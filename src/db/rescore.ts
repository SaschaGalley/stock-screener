/**
 * Re-score the stored history with today's scoring model.
 *
 * The factor score is a pure function of data this database already keeps, so
 * the series it produces does not have to start on the day the code shipped.
 * Every snapshot carries the date its content first appeared, which means the
 * inputs for any past day are recoverable and the score for that day is a
 * recomputation rather than a reconstruction.
 *
 * Each instant is scored with what was actually known then:
 *
 *   - **That day's rates**, from the macro series the refresh records. Early
 *     re-scores used the fallback constants and called the difference "tens of
 *     basis points"; the fallback premium is 5.5 % against a measured 4.1 %,
 *     which moved Microsoft's valuation pillar from 4.8 to 3.5 and put the list
 *     a full point below the detail page that recomputed with live rates.
 *   - **The analysis in force**, the newest stored card produced at or before
 *     the instant, decayed by its age exactly as the nightly refresh does. The
 *     re-score used to pass no card at all, which rewrote every recent point as
 *     the factor score alone and dropped the narrative the live series had.
 *
 * Two things this deliberately does *not* do:
 *
 *   - It does not invent a narrative half where none existed. For dates before
 *     the verdict pipeline stored a card, `final.score` equals `factor.score`
 *     and the blend weights say so. Folding the old single-call LLM scores in
 *     as a stand-in would import exactly the noise this whole change removes.
 *   - It does not touch `verdict.*`. Those observations are what the old
 *     pipeline actually concluded on those days, and overwriting them would
 *     destroy the only baseline the new score can be compared against.
 *
 * Idempotent: observations upsert on (symbol, metric, timestamp), so running it
 * twice writes the same rows twice and changes nothing.
 *
 *   pnpm run rescore [--symbol AAPL] [--since 2026-01-01] [--dry-run]
 */

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { computeAllMetrics } from '../analysis/computeMetrics.js';
import { deriveTechnicalSignals } from '../analysis/signals.js';
import { rescore } from '../score-service.js';
import type {
  MarketSignals, ScoreCard, SectorMedians, StockFinancials, TechnicalSignals,
} from '../types.js';
import { readAppConfig } from '../app-config.js';
import { FALLBACK_RATES, RATE_CURRENCIES, type MarketRates } from '../data/fred.js';
import { RATING_BUCKETS } from '../data/ratings.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { closePool, waitForDatabase } from './client.js';
import { hasPeers } from '../sector-medians.js';
import { readAppState, writeAppState } from './admin.js';
import { migrate } from './migrate.js';
import { syncCatalog } from './catalog.js';
import {
  deleteObservations, listSymbols, macroHistory, recordObservations, scoreCardHistory, scoreInstants, snapshotHistory,
} from './store.js';

export interface RescoreStats {
  symbols:      number;
  days:         number;
  observations: number;
  /** Orphaned rows from an earlier re-score under different scoring rules. */
  cleared:      number;
  skipped:      number;
}

/**
 * How far past a financials timestamp a sibling snapshot still counts as part
 * of the same observation.
 *
 * One refresh writes the financials first and the market signals a few hundred
 * milliseconds later, so a strict at-or-before rule excluded every signals
 * payload written by the very run whose price it belongs to — three symbols
 * came out of the first re-score at 90 % coverage with no momentum pillar, for
 * no better reason than the order of two writes. Minutes are enough to pair a
 * run with itself and far too short to reach the next day's data.
 */
const SAME_RUN_MS = 15 * 60_000;

/**
 * The entry that belongs to `at` — the newest one at or before it, or one
 * written just after by the same run.
 */
function asOf<T>(history: { data: T; capturedAt: Date }[], at: number): T | null {
  let found: T | null = null;
  for (const row of history) {
    if (row.capturedAt.getTime() > at + SAME_RUN_MS) break;
    found = row.data;
  }
  return found;
}

type RateHistory = Map<string, { at: number; value: number }[]>;

/**
 * One rate as of `at`: the newest reading at or before it, else the earliest
 * after it, else nothing. Reaching forward is deliberate — the premium was only
 * recorded from September, and Damodaran's monthly implied ERP a few weeks
 * later is far closer to the truth of an August day than a long-run constant.
 */
function rateAt(history: RateHistory, key: string, at: number): number | undefined {
  const points = history.get(key);
  if (!points?.length) return undefined;
  let found: number | undefined;
  for (const p of points) {
    if (p.at > at) break;
    found = p.value;
  }
  return found ?? points[0].value;
}

/** The rates the models would have discounted with at `at`, fallbacks only where nothing was ever recorded. */
export function ratesAt(history: RateHistory, at: number): MarketRates {
  const creditSpreads = { ...FALLBACK_RATES.creditSpreads };
  for (const b of RATING_BUCKETS) {
    const v = rateAt(history, `macro.creditSpreads.${b.rating}`, at);
    if (v !== undefined) creditSpreads[b.rating] = v;
  }
  const localRiskFreeRates: MarketRates['localRiskFreeRates'] = {};
  for (const c of RATE_CURRENCIES) {
    const v = rateAt(history, `macro.localRiskFreeRates.${c}`, at);
    if (v !== undefined) localRiskFreeRates[c] = v;
  }
  return {
    riskFreeRate:      rateAt(history, 'macro.riskFreeRate', at)      ?? FALLBACK_RATES.riskFreeRate,
    aaaBondYield:      rateAt(history, 'macro.aaaBondYield', at)      ?? FALLBACK_RATES.aaaBondYield,
    equityRiskPremium: rateAt(history, 'macro.equityRiskPremium', at) ?? FALLBACK_RATES.equityRiskPremium,
    creditSpreads,
    localRiskFreeRates,
  };
}

/** The newest stored card produced at or before `at`. */
function cardAt(history: { card: ScoreCard; producedAt: Date }[], at: number): ScoreCard | null {
  let found: ScoreCard | null = null;
  for (const h of history) {
    if (h.producedAt.getTime() > at) break;
    found = h.card;
  }
  return found;
}

export async function rescoreHistory(opts: {
  symbols?: string[];
  since?:   Date;
  dryRun?:  boolean;
} = {}): Promise<RescoreStats> {
  const stats: RescoreStats = { symbols: 0, days: 0, observations: 0, cleared: 0, skipped: 0 };
  const symbols = opts.symbols?.length ? opts.symbols : await listSymbols();
  // The admin settings, as the refresh reads them — not the defaults, or a
  // changed narrative weight would split the re-scored series from the live one.
  const scoring = (await readAppConfig()).scoring;
  const rates = await macroHistory('macro.');

  for (const symbol of symbols) {
    // Full histories, whatever `since` says: an instant after `since` still
    // needs the snapshot in force before it.
    const financials = await snapshotHistory<StockFinancials>(symbol, 'financials');
    if (financials.length === 0) {
      logger.debug(`${symbol}: no stored financials — nothing to re-score`);
      continue;
    }

    const signals = await snapshotHistory<MarketSignals>(symbol, 'market_signals');
    // Only payloads that came from peers — see `hasPeers`.
    const peers   = (await snapshotHistory<SectorMedians>(symbol, 'sector_medians')).filter((r) => hasPeers(r.data));
    const techSig = await snapshotHistory<TechnicalSignals>(symbol, 'technical_signals');
    const cards   = await scoreCardHistory(symbol);

    // Every instant that has a score, plus every day the financials moved. The
    // financials alone used to drive the timeline, which missed the points the
    // nightly refresh and the CLI write themselves — a few milliseconds off the
    // snapshot's own timestamp — and those are the *newest* points, the ones the
    // overview shows. After a scoring change they kept the old code's numbers
    // while the detail page recomputed with the new, and the two disagreed.
    const since = opts.since?.getTime() ?? -Infinity;
    const instants = [...new Set([
      ...financials.map((r) => r.capturedAt.getTime()),
      ...(await scoreInstants(symbol)).map((d) => d.getTime()),
    ])].filter((t) => t >= since).sort((x, y) => x - y);

    // Clear this symbol's `score.*` rows at the instants about to be rewritten.
    // Without it a re-score under changed rules cannot remove what it no longer
    // produces: a criterion that now abstains leaves its last value behind at
    // the very timestamp being rewritten, and the series quietly disagrees with
    // itself.
    if (!opts.dryRun) {
      stats.cleared += await deleteObservations(symbol, 'score.', instants.map((t) => new Date(t)));
    }

    let wrote = 0;
    for (const at of instants) {
      const f = asOf(financials, at);
      if (!f || typeof f.price !== 'number' || !Number.isFinite(f.price)) {
        stats.skipped++;
        continue;
      }

      const sectorMedians = asOf(peers, at);
      const marketSignals = asOf(signals, at);

      // Prefer the stored aggregate; derive it where the snapshot predates the
      // technical-signals kind but the indicators behind it were kept.
      const technicalSignals = asOf(techSig, at)
        ?? (marketSignals?.technicals ? deriveTechnicalSignals(marketSignals.technicals, f.price) : null);

      const metrics = computeAllMetrics(f, ratesAt(rates, at), sectorMedians);

      const card = rescore({
        financials: f, metrics, sectorMedians, marketSignals, technicalSignals,
        previous:           cardAt(cards, at),
        narrativeMaxWeight: scoring.narrativeMaxWeight,
        adjustmentLimit:    scoring.adjustmentLimit,
        now:                at,
      });

      if (!opts.dryRun) {
        stats.observations += await recordObservations(
          symbol, [{ domain: 'score', payload: card }], new Date(at),
        );
      }
      wrote++;
      stats.days++;
    }

    stats.symbols++;
    logger.info(`${symbol}: ${wrote} instant${wrote === 1 ? '' : 's'} re-scored`);
  }

  return stats;
}

// ── The card as of now ───────────────────────────────────────────────────────

/**
 * Today's score card from the stored inputs, exactly as the series computes it.
 *
 * The detail page used to recompute from live fetches — current FRED rates,
 * a fresh peer-median call — while the overview read the series the refresh
 * had written from *its* fetches. Any difference in inputs became a different
 * verdict on the two screens: a Finnhub call that came back with no peers, a
 * premium read an hour later. Reading the same snapshots and the same recorded
 * rates through the same function makes the two one number by construction.
 *
 * `previous` is the analysis on show; for the newest one it is the card the
 * series carries too.
 */
export interface StoredInputs {
  financials:       StockFinancials;
  marketSignals:    MarketSignals | null;
  sectorMedians:    SectorMedians | null;
  technicalSignals: TechnicalSignals | null;
  rates:            MarketRates;
}

/**
 * The inputs the series used at `now`: the snapshots in force and the recorded
 * rates. Everything that shows a number the score depends on — the card and the
 * valuation models beside it — reads these, so the page cannot disagree with
 * the list about what went in.
 */
export async function storedInputs(symbol: string, now: number = Date.now()): Promise<StoredInputs | null> {
  const [financials, signals, peers, techSig, rates] = await Promise.all([
    snapshotHistory<StockFinancials>(symbol, 'financials'),
    snapshotHistory<MarketSignals>(symbol, 'market_signals'),
    snapshotHistory<SectorMedians>(symbol, 'sector_medians'),
    snapshotHistory<TechnicalSignals>(symbol, 'technical_signals'),
    macroHistory('macro.'),
  ]);
  const f = asOf(financials, now);
  if (!f || typeof f.price !== 'number' || !Number.isFinite(f.price)) return null;
  const marketSignals = asOf(signals, now);
  return {
    financials:       f,
    marketSignals,
    sectorMedians:    asOf(peers.filter((r) => hasPeers(r.data)), now),
    technicalSignals: asOf(techSig, now)
      ?? (marketSignals?.technicals ? deriveTechnicalSignals(marketSignals.technicals, f.price) : null),
    rates:            ratesAt(rates, now),
  };
}

export async function currentScoreCard(
  symbol: string, previous: ScoreCard | null, now: number = Date.now(),
): Promise<ScoreCard | null> {
  const inputs = await storedInputs(symbol, now);
  if (!inputs) return null;
  const { financials: f, sectorMedians, marketSignals, technicalSignals } = inputs;
  const scoring = (await readAppConfig()).scoring;
  return rescore({
    financials: f,
    metrics:    computeAllMetrics(f, inputs.rates, sectorMedians),
    sectorMedians, marketSignals, technicalSignals,
    previous,
    narrativeMaxWeight: scoring.narrativeMaxWeight,
    adjustmentLimit:    scoring.adjustmentLimit,
    now,
  });
}

// ── Keeping the series on the current code ──────────────────────────────────

/**
 * The modules whose code decides a score card. A change to any of them changes
 * what the stored series would be if it were computed today.
 */
const SCORING_MODULES = [
  'analysis/score', 'analysis/metrics', 'analysis/computeMetrics', 'analysis/data-quality',
  'analysis/run-rate', 'analysis/signals', 'score-service', 'verdict', 'db/rescore', 'sector-medians',
];

/**
 * A hash of the scoring code as it is deployed — sources under tsx, compiled
 * output in the container, whichever this file itself was loaded from.
 *
 * Derived, not declared: a hand-bumped version number is one more thing to
 * forget, and forgetting it is exactly how the overview came to show the old
 * code's numbers next to detail pages computed with the new.
 */
export function scoringFingerprint(): string {
  const here = fileURLToPath(import.meta.url);
  const root = dirname(dirname(here));
  const ext = extname(here);
  const hash = createHash('sha256');
  for (const m of SCORING_MODULES) {
    try {
      hash.update(m).update(readFileSync(join(root, `${m}${ext}`)));
    } catch {
      hash.update(`${m}:missing`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

const FINGERPRINT_KEY = 'scoring.fingerprint';

/**
 * Re-score the whole history if the scoring code changed since it was written.
 *
 * Runs once per deploy, on server start, in the background: the series stays
 * readable meanwhile and simply catches up. The fingerprint is stored only
 * after a complete pass, so an interrupted one is repeated next start.
 */
export async function rescoreIfScoringChanged(): Promise<void> {
  const current = scoringFingerprint();
  const stored = await readAppState(FINGERPRINT_KEY);
  if (stored === current) return;
  logger.info(`Scoring code changed (${stored ?? 'none'} → ${current}) — re-scoring the stored history`);
  const stats = await rescoreHistory();
  await writeAppState(FINGERPRINT_KEY, current);
  logger.success(`Re-scored ${stats.symbols} symbols, ${stats.days} instants on the current scoring code`);
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('rescore.ts') || process.argv[1]?.endsWith('rescore.js');

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const symbolArg = flag('--symbol');
  const sinceArg = flag('--since');
  const since = sinceArg ? new Date(sinceArg) : undefined;
  if (since && !Number.isFinite(since.getTime())) {
    logger.error(`--since "${sinceArg}" is not a date`);
    process.exit(1);
  }

  (async () => {
    getConfig();
    await waitForDatabase();
    await migrate();
    // The `score.*` metrics only exist in the catalogue once it has been synced
    // against the current schemas; without this the first run writes nothing.
    await syncCatalog();

    const full = !symbolArg && !since && !args.includes('--dry-run');
    const stats = await rescoreHistory({
      symbols: symbolArg ? symbolArg.split(',').map((s) => s.trim().toUpperCase()) : undefined,
      since,
      dryRun:  args.includes('--dry-run'),
    });
    // A complete pass brings the series onto this code; say so, so the server
    // does not repeat it on its next start.
    if (full) await writeAppState(FINGERPRINT_KEY, scoringFingerprint());
    logger.success(
      `${args.includes('--dry-run') ? 'Dry run' : 'Re-score'} complete — `
      + `${stats.symbols} symbols, ${stats.days} days, ${stats.observations} observations`
      + (stats.cleared > 0 ? `, ${stats.cleared} stale rows cleared` : '')
      + (stats.skipped > 0 ? `, ${stats.skipped} snapshots skipped (no usable price)` : ''),
    );
    await closePool();
  })().catch(async (e) => {
    logger.error(`Re-score failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
}
