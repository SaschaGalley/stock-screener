/**
 * Re-score the stored history with today's scoring model.
 *
 * The factor score is a pure function of data this database already keeps, so
 * the series it produces does not have to start on the day the code shipped.
 * Every snapshot carries the date its content first appeared, which means the
 * inputs for any past day are recoverable and the score for that day is a
 * recomputation rather than a reconstruction.
 *
 * Two things this deliberately does *not* do:
 *
 *   - It does not invent a narrative half. Nobody stored what a dossier said on
 *     a Tuesday in June, so for dates before the verdict pipeline existed
 *     `final.score` equals `factor.score` and the blend weights say so. The
 *     alternative — folding the old single-call LLM scores in as a stand-in —
 *     would import exactly the noise this whole change removes.
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
  MarketSignals, SectorMedians, StockFinancials, TechnicalSignals,
} from '../types.js';
import { DEFAULT_APP_CONFIG } from '../app-config.js';
import { FALLBACK_RATES } from '../data/fred.js';
import { closePool, waitForDatabase } from './client.js';
import { migrate } from './migrate.js';
import { syncCatalog } from './catalog.js';
import { deleteObservations, listSymbols, recordObservations, snapshotHistory } from './store.js';

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

export async function rescoreHistory(opts: {
  symbols?: string[];
  since?:   Date;
  dryRun?:  boolean;
} = {}): Promise<RescoreStats> {
  const stats: RescoreStats = { symbols: 0, days: 0, observations: 0, cleared: 0, skipped: 0 };
  const symbols = opts.symbols?.length ? opts.symbols : await listSymbols();
  const scoring = DEFAULT_APP_CONFIG.scoring;

  for (const symbol of symbols) {
    // Financials drive the timeline: the price moves every session, so a new
    // financials row is what a "day" in this history actually is. The other
    // kinds are sampled against it rather than contributing dates of their own,
    // which would otherwise produce a score for a day nobody observed.
    const financials = await snapshotHistory<StockFinancials>(symbol, 'financials', opts.since);
    if (financials.length === 0) {
      logger.debug(`${symbol}: no stored financials — nothing to re-score`);
      continue;
    }

    const signals = await snapshotHistory<MarketSignals>(symbol, 'market_signals', opts.since);
    const peers   = await snapshotHistory<SectorMedians>(symbol, 'sector_medians', opts.since);
    const techSig = await snapshotHistory<TechnicalSignals>(symbol, 'technical_signals', opts.since);

    // Clear this symbol's `score.*` rows at the instants about to be rewritten.
    // Without it a re-score under changed rules cannot remove what it no longer
    // produces: a criterion that now abstains leaves its last value behind at
    // the very timestamp being rewritten, and the series quietly disagrees with
    // itself. Only these instants, so the live refresh's own cards survive.
    if (!opts.dryRun) {
      stats.cleared += await deleteObservations(
        symbol, 'score.', financials.map((r) => r.capturedAt),
      );
    }

    let wrote = 0;
    for (const row of financials) {
      const at = row.capturedAt.getTime();
      const f = row.data;
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

      // The rates of that day are not recoverable per symbol — they live in the
      // global macro series — so the models are re-run on the fallback set. It
      // moves the discount rate by tens of basis points at most, which is well
      // inside the ramps the valuation pillar uses.
      const metrics = computeAllMetrics(f, FALLBACK_RATES, sectorMedians);

      const card = rescore({
        financials: f, metrics, sectorMedians, marketSignals, technicalSignals,
        previous:           null,
        narrativeMaxWeight: scoring.narrativeMaxWeight,
        adjustmentLimit:    scoring.adjustmentLimit,
        now:                at,
      });

      if (!opts.dryRun) {
        stats.observations += await recordObservations(
          symbol, [{ domain: 'score', payload: card }], row.capturedAt,
        );
      }
      wrote++;
      stats.days++;
    }

    stats.symbols++;
    logger.info(`${symbol}: ${wrote} day${wrote === 1 ? '' : 's'} re-scored`);
  }

  return stats;
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

    const stats = await rescoreHistory({
      symbols: symbolArg ? symbolArg.split(',').map((s) => s.trim().toUpperCase()) : undefined,
      since,
      dryRun:  args.includes('--dry-run'),
    });
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
