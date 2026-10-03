/**
 * Does the factor score rank the stocks that went on to do better — measured
 * over the past, not waited for?
 *
 *   pnpm run backtest                     # S&P 1500, month-ends since 2013
 *   pnpm run backtest -- --universe sp500 # the large caps alone
 *   pnpm run backtest -- --from 2016-01   # a later start
 *   pnpm run backtest -- --limit 60       # the first 60 companies, to try it out
 *   pnpm run backtest -- --no-analysts    # without the rebuilt consensus, for comparison
 *   pnpm run backtest -- --no-insiders    # without the insider candidates (half an hour of Finnhub the first time)
 *   pnpm run backtest -- --no-departed    # today's members only, without those that left
 *   pnpm run backtest -- --studies        # and the studies: the score under other rules, the top tenth
 *   pnpm run backtest -- --write-weights  # and commit the weight fit, if it held up
 *   pnpm run backtest -- --fidelity       # only compare the live scores with the backtest's, printed
 *
 * The live evaluation needs months of stored scores before it says anything.
 * This one rebuilds them. At every month-end since 2013 it reconstructs each
 * member of the S&P 1500 — the 500, the MidCap 400 and the SmallCap 600 — as
 * the scorer would have seen it that day: the SEC filings filed before it, and
 * the prices up to its close (`payload.ts`). It then scores the whole
 * cross-section with the live code and evaluates the scores against the
 * following months' returns, with the same `evaluate` the page uses — across
 * all of them, and within each of the three indices: a factor the large caps
 * price away may still work further down.
 *
 * Everything the live system calibrates is recalibrated per month, from that
 * month's cross-section only: the premium adjustment, and every criterion's
 * reference distribution. Nothing from after a month-end reaches its scores.
 *
 * The analyst consensus of each month-end is rebuilt from Yahoo's rating
 * history (`analysts.ts`, `analysis/analyst-history.ts`): each firm's newest
 * target and grade from the year before. The result says, year by year, for
 * what share of the stocks there was one.
 *
 * What it cannot do, and says so in the result:
 *   - Estimates, their revisions and earnings surprises have no history, so
 *     the revisions pillar has only the rating drift and the DCF starts from
 *     trailing growth. The rating history thins out before 2020.
 *   - The universe is today's index members, each from the day it joined the
 *     composite (`compositeJoinDates`), and those that left since 2013 as far
 *     as free data still has them (`departed.ts`): the ones that still trade.
 *     Bought and bankrupt companies are missing.
 *   - Peer groups are the index's own GICS sub-industries, not Finnhub's.
 *
 * Beside the score it measures candidates — signals no pillar reads yet, put
 * to the same test before anyone proposes a weight for them: the insiders'
 * open-market buying and selling, from their Form 4 filings as Finnhub keeps
 * them (`insiders.ts`, `analysis/insider-signals.ts`).
 *
 * It also fits the weights to what it measured and checks the fit on the half
 * of the months it did not see (`weights.ts`).
 *
 * The result is stored in `app_state` (`backtest.result`) for the page.
 */

import { writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { closePool, waitForDatabase } from '../db/client.js';
import { takeBacktestLock, type BacktestLock } from './lock.js';
import { COMPOSITE_INDEXES } from '../data/universe.js';
import { sectorToEtf } from '../data/macro.js';
import { collectCalibrated, useCalibrationTable, usePremiumAdjustment } from '../analysis/calibration.js';
import { trustOf } from '../analysis/score.js';
import { FITTED_WEIGHTS_META } from '../analysis/weight-table.js';
import { bucketReturns, evaluate, type Close, type SignalPoint } from '../analysis/evaluate.js';
import { PILLAR_KEYS } from '../types.js';
import { insiderHistory } from './insiders.js';
import { VARIANTS, variantSignals } from './variants.js';
import { featureArray, TOP_FEATURES, topDecileStudy, type TopRecord } from './top-decile.js';
import { INSIDER_CANDIDATES, insiderActivity, type InsiderTrade } from '../analysis/insider-signals.js';
import { payloadAt, yahooSector } from './payload.js';
import {
  BACKTEST_CAVEATS, BacktestResult, departedCaveat, NO_ANALYSTS_CAVEAT, saveBacktestRun, writeBacktestStatus,
  type BacktestStatus, type BacktestTrigger,
} from './result.js';
import { calibrateCrossSection, median } from './cross-section.js';
import { fidelityCheck, renderFidelity } from './fidelity.js';
import { loadBacktestData, pooled, type BacktestUniverse } from './load.js';
import { indexAtOrBefore, monthEnds, type PriceHistory } from './prices.js';
import { rateHistory } from './rates.js';
import { renderWeightTable, scoredRow, WEIGHT_SPLIT, weightLab, type ScoredRow, type WeightValidation } from './weights.js';

export type { BacktestUniverse } from './load.js';
/** Months ahead the scores are judged over. */
export const BACKTEST_HORIZONS = [1, 3, 6, 12];
/**
 * The horizons the weight fit is checked on — fixed with the rule, before
 * the longer ones were measured: a check that grows with whatever else is
 * measured is a check that moves after the result is seen.
 */
export const BACKTEST_FIT_HORIZONS = [1, 3];
/** The horizon the weight fit reads: one month, as factor research measures. */
export const BACKTEST_WEIGHT_HORIZON = 1;

const pillarKey = (p: string) => `score.factor.pillars.${p}.score`;
/** Signals that are one criterion's figure rather than a score. */
export const CRITERION_PREFIX = 'criterion.';
/** Signals measured beside the score that no pillar reads yet. */
export const CANDIDATE_PREFIX = 'candidate.';
export const BACKTEST_SIGNALS = ['score.factor.score', 'score.factor.raw', ...PILLAR_KEYS.map(pillarKey)];
const LABEL_KEY = 'score.factor.verdict';

// Lives beside the other calendar helpers now, so a single stock's history can
// use it without importing the whole backtest; re-exported for existing callers.
export { monthEnds } from './prices.js';

export async function runBacktest(
  opts: {
    from?: string; to?: string; limit?: number; analysts?: boolean; insiders?: boolean; departed?: boolean; universe?: BacktestUniverse;
    trigger?: BacktestTrigger;
    /**
     * The studies too — the score under other rules (`variants.ts`) and what
     * its top tenth is made of (`top-decile.ts`). Questions asked once, not
     * every month: they add half a gigabyte at the peak, and the page keeps
     * showing the newest run that answered them.
     */
    studies?: boolean;
    /** Told at every step, in words for the admin page: "SEC-Abschlüsse 500/1502". */
    onProgress?: (phase: string) => void;
  } = {},
): Promise<BacktestResult> {
  const withAnalysts = opts.analysts ?? true;
  const progress = (phase: string) => { try { opts.onProgress?.(phase); } catch { /* a status write must not cost the run */ } };
  const universe = opts.universe ?? 'sp1500';
  const cfg = getConfig();
  const dir = join(cfg.dataDir, 'backtest');
  const from = opts.from ? `${opts.from.slice(0, 7)}-01` : '2013-01-01';
  const to = opts.to ?? new Date().toISOString().slice(0, 10);
  const data = await loadBacktestData({
    dir, from, universe, limit: opts.limit, analysts: withAnalysts, departed: opts.departed ?? true, progress,
  });
  const { companies, facts, prices, bench, analysts, priceFrom } = data;

  const insiders = new Map<string, InsiderTrade[]>();
  const finnhubKey = cfg.finnhubApiKey;
  if ((opts.insiders ?? true) && finnhubKey) {
    let done = 0;
    await pooled(companies, 2, async (c) => {
      const t = await insiderHistory(c.symbol, finnhubKey, join(dir, 'insiders'));
      if (t) insiders.set(c.symbol, t);
      if (++done % 100 === 0) {
        logger.info(`  Insider histories: ${done}/${companies.length}`);
        progress(`Insider-Historien ${done}/${companies.length}`);
      }
    });
  }

  const ratesOn = await rateHistory(priceFrom, cfg.fredApiKey);
  const days = monthEnds(bench.dates, from, to);

  // Whether what follows measures the score the app shows: the newest live
  // scores beside the backtest's of the same sessions (`fidelity.ts`).
  progress('Abgleich mit den Live-Scores');
  const fidelity = opts.limit ? null : await fidelityCheck(data, ratesOn).catch((e) => {
    logger.warn(`Fidelity check failed: ${(e as Error).message}`);
    return null;
  });

  const signals = new Map<string, Map<string, SignalPoint[]>>(
    [...BACKTEST_SIGNALS, LABEL_KEY].map((k) => [k, new Map()]),
  );
  const push = (key: string, symbol: string, point: SignalPoint) => {
    const bySymbol = signals.get(key) ?? new Map<string, SignalPoint[]>();
    const list = bySymbol.get(symbol);
    if (list) list.push(point); else bySymbol.set(symbol, [point]);
    signals.set(key, bySymbol);
  };
  const scored = new Set<string>();
  const premiums: number[] = [];
  // Every company-month's criteria, for weighing them again (`weights.ts`).
  const rows: ScoredRow[] = [];
  // And what each looked like, for the study of the top tenth (`top-decile.ts`).
  const topRecords: TopRecord[] = [];
  const labels = new Map<string, string>();
  // Company-months scored, and how many of them had a rebuilt consensus target.
  const coverage = new Map<number, { stocks: number; covered: number }>();

  try {
    for (const [m, day] of days.entries()) {
      const entries = companies.flatMap((c) => {
        if (c.added && c.added > day) return [];
        if (c.removed && c.removed <= day) return [];
        const f = facts.get(c.symbol), px = prices.get(c.symbol);
        if (!f || !px) return [];
        const etf = sectorToEtf(c.sector);
        const p = payloadAt(c, f, px, bench, etf ? prices.get(etf) ?? null : null, day, analysts.get(c.symbol) ?? null);
        return p ? [{ c, ...p }] : [];
      });
      if (entries.length < 20) continue;
      const year = coverage.get(Number(day.slice(0, 4))) ?? { stocks: 0, covered: 0 };
      year.stocks += entries.length;
      year.covered += entries.filter((e) => e.financials.targetMeanPrice !== null).length;
      coverage.set(Number(day.slice(0, 4)), year);

      const { premium, metrics, score } = calibrateCrossSection(entries, ratesOn(day));
      premiums.push(premium);

      // Dated the day before: the evaluation counts a signal from the days
      // strictly before a formation day, and these scores saw that day's
      // close — the close the forward return starts from, and nothing after.
      const at = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000);
      entries.forEach((e, k) => {
        // Every criterion's own figure too, turned so that more is better: a
        // pillar that ranks nothing may still hold a criterion that does.
        const f = collectCalibrated((key, value, _sector, direction) => {
          push(`${CRITERION_PREFIX}${key}`, e.c.symbol, { at, value: value * (direction ?? 1) });
        }, () => score(k));
        scored.add(e.c.symbol);
        rows.push(scoredRow(at, e.c.symbol, trustOf(e.financials, metrics[k]), f));
        for (const p of f.pillars) for (const c of p.criteria) labels.set(`${p.key}.${c.key}`, c.label);
        push('score.factor.score', e.c.symbol, { at, value: f.score });
        push('score.factor.raw', e.c.symbol, { at, value: f.raw });
        for (const p of f.pillars) push(pillarKey(p.key), e.c.symbol, { at, value: p.score });
        push(LABEL_KEY, e.c.symbol, { at, value: null, text: f.verdict });

        // What the stock looked like that day, for the study of the top tenth.
        const fin = e.financials, tech = e.signals?.technicals;
        const finite = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : null);
        if (opts.studies) topRecords.push({
          day, symbol: e.c.symbol, segment: e.c.segment, sector: yahooSector(e.c.sector), score: f.score,
          features: featureArray({
            mom12: finite(tech?.returns?.y1), mom3: finite(tech?.returns?.m3), nearHigh: finite(tech?.drawdownFromHighPct),
            size: finite(fin.marketCap),
            ps: fin.revenue && fin.revenue > 0 ? fin.marketCap / fin.revenue : null,
            pe: fin.peRatio !== null && fin.peRatio > 0 ? fin.peRatio : null,
            upside: fin.targetMeanPrice && fin.price > 0 ? fin.targetMeanPrice / fin.price - 1 : null,
            growth: finite(fin.revenueGrowth), beta: finite(fin.beta),
            agreement: f.agreement, confidence: f.confidence,
            ...Object.fromEntries(f.pillars.map((p) => [`pillar.${p.key}`, p.score])),
          }),
        });

        const trades = insiders.get(e.c.symbol);
        if (trades) {
          const a = insiderActivity(trades, day);
          for (const cand of INSIDER_CANDIDATES) {
            const value = cand.read(a, e.financials.marketCap);
            if (value !== null) push(`${CANDIDATE_PREFIX}${cand.key}`, e.c.symbol, { at, value });
          }
        }
      });
      progress(`Monatsende ${day} (${m + 1}/${days.length}), ${entries.length} Aktien`);
      if (m % 12 === 0 || m === days.length - 1) {
        logger.info(`  ${day}: ${entries.length} stocks, premium ${(premium * 100).toFixed(2)} pts`);
      }
    }
  } finally {
    useCalibrationTable(null);
    usePremiumAdjustment(null);
  }

  // Returns on month-end closes, against the index's month-ends as the calendar.
  const toCloses = (p: PriceHistory): Close[] => p.dates.map((d, k) => ({ date: d, close: p.adj[k] }));
  const calendar: Close[] = monthEnds(bench.dates, from, bench.dates[bench.dates.length - 1])
    .map((d) => ({ date: d, close: bench.adj[indexAtOrBefore(bench.dates, d)] }));
  const priceMap = new Map<string, Close[]>();
  for (const c of companies) {
    const p = prices.get(c.symbol);
    if (p) priceMap.set(c.symbol, toCloses(p));
  }
  const sectors = new Map(companies.map((c) => [c.symbol, yahooSector(c.sector)]));
  const evaluation = evaluate({
    signals, prices: priceMap, benchmark: calendar, horizons: BACKTEST_HORIZONS,
    labelKey: LABEL_KEY, sectors, keepDaily: true,
  });

  const headline = evaluation.ics.find((r) => r.key === 'score.factor.score' && r.horizon === BACKTEST_WEIGHT_HORIZON);
  const years = new Map<number, { ics: number[]; neutral: number[] }>();
  for (const d of headline?.daily ?? []) {
    const y = Number(d.day.slice(0, 4));
    const entry = years.get(y) ?? { ics: [], neutral: [] };
    entry.ics.push(d.ic);
    if (d.neutralIc !== null) entry.neutral.push(d.neutralIc);
    years.set(y, entry);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  // The daily series served their purpose; the stored result keeps the aggregates.
  for (const r of evaluation.ics) delete r.daily;

  // The same signals within each index: the large caps alone, the mid caps, the small caps.
  const segments = universe === 'sp500' ? [] : COMPOSITE_INDEXES.flatMap((ix) => {
    const members = new Set(companies.filter((c) => c.segment === ix.key && scored.has(c.symbol)).map((c) => c.symbol));
    if (members.size === 0) return [];
    const within = new Map([...BACKTEST_SIGNALS, LABEL_KEY, ...[...signals.keys()].filter((k) => k.startsWith(CANDIDATE_PREFIX))].map((k) => [
      k, new Map([...(signals.get(k) ?? new Map<string, SignalPoint[]>())].filter(([sym]) => members.has(sym))),
    ]));
    const ev = evaluate({ signals: within, prices: priceMap, benchmark: calendar, horizons: BACKTEST_HORIZONS, labelKey: LABEL_KEY, sectors });
    return [{ key: ix.key, label: ix.label, companies: members.size, ics: ev.ics, labels: ev.labels }];
  });

  // Each criterion's own series has been evaluated; what follows reads the
  // score, the verdicts and the rows. A quarter of a gigabyte freed before the
  // bands and variants build their own.
  for (const k of [...signals.keys()]) if (k.startsWith(CRITERION_PREFIX)) signals.delete(k);

  // The score cut into its tenths and its verdicts, each against the month's
  // average stock: whether the top earns more than the next, and whether a
  // STRONG BUY earns more than a BUY.
  progress('Bänder und Dezile');
  const scoreSignal = signals.get('score.factor.score') ?? new Map<string, SignalPoint[]>();
  const step = (p: SignalPoint) => {
    if (p.value === null || !Number.isFinite(p.value)) return null;
    const v = Math.floor(p.value);
    return v <= 2 ? '<3' : v >= 8 ? '≥8' : `${v}–${v + 1}`;
  };
  const bucketsOf = (symbols: Set<string> | null) => {
    const only = <T>(m: Map<string, T>) => (symbols ? new Map([...m].filter(([s]) => symbols.has(s))) : m);
    const common = { prices: priceMap, benchmark: calendar, horizons: BACKTEST_HORIZONS };
    return {
      deciles: bucketReturns({ ...common, points: only(scoreSignal), bucket: 'decile' }),
      rawDeciles: bucketReturns({ ...common, points: only(signals.get('score.factor.raw') ?? new Map()), bucket: 'decile' }),
      verdicts: bucketReturns({ ...common, points: only(signals.get(LABEL_KEY) ?? new Map()), bucket: (p) => p.text ?? null }),
      steps: bucketReturns({ ...common, points: only(scoreSignal), bucket: step }),
    };
  };
  const bands = bucketsOf(null);
  for (const seg of segments) {
    const members = new Set(companies.filter((c) => c.segment === seg.key).map((c) => c.symbol));
    Object.assign(seg, { bands: bucketsOf(members) });
  }

  // The same rows under other rules: the conviction stretch at full, half and
  // none, each with its IC, its tenths and its verdicts (`variants.ts`).
  if (opts.studies) progress('Varianten');
  const variants = !opts.studies ? undefined : VARIANTS.map((v) => {
    const sig = variantSignals(rows, v);
    const common = { prices: priceMap, benchmark: calendar, horizons: BACKTEST_HORIZONS };
    const ev = evaluate({
      ...common, signals: new Map([['score', sig.score], ['verdict', sig.verdict]]), labelKey: 'verdict', sectors,
    });
    const bySegment = segments.map((seg) => {
      const members = new Set(companies.filter((c) => c.segment === seg.key).map((c) => c.symbol));
      const only = new Map([...sig.score].filter(([s]) => members.has(s)));
      return { key: seg.key, ics: evaluate({ ...common, signals: new Map([['score', only]]), sectors }).ics };
    });
    const counts = new Map<string, number>();
    for (const points of sig.verdict.values()) for (const p of points) counts.set(p.text!, (counts.get(p.text!) ?? 0) + 1);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return {
      key: v.key, label: v.label, stretch: v.stretch,
      ics: ev.ics,
      segments: bySegment,
      deciles: bucketReturns({ ...common, points: sig.score, bucket: 'decile' }),
      verdicts: bucketReturns({ ...common, points: sig.verdict, bucket: (p) => p.text ?? null }),
      // The verdicts in each half of the years: a rule found on all of them should hold in both.
      halves: [{ to: WEIGHT_SPLIT }, { from: WEIGHT_SPLIT }].map((range) => bucketReturns({
        ...common, bucket: (p) => p.text ?? null, points: sig.verdict, range,
      })),
      steps: bucketReturns({ ...common, points: sig.score, bucket: step }),
      verdictShare: Object.fromEntries([...counts].map(([k, n]) => [k, total ? n / total : 0])),
    };
  });

  if (opts.studies) progress('Oberstes Zehntel');
  const topDecile = opts.studies ? topDecileStudy(topRecords, priceMap, calendar.map((c) => c.date)) : undefined;
  topRecords.length = 0;

  const fit = weightLab(rows, { prices: priceMap, sectors }, {
    fitHorizon: BACKTEST_WEIGHT_HORIZON, horizons: BACKTEST_FIT_HORIZONS, labels,
  }).validate(calendar);

  const sortedPremiums = [...premiums].sort((a, b) => a - b);
  const result: BacktestResult = {
    generatedAt: new Date().toISOString(),
    from: days[0] ?? from, to: days[days.length - 1] ?? to,
    months: premiums.length,
    companies: scored.size,
    universe: universe === 'sp500' ? 'S&P 500' : 'S&P 1500',
    segments,
    premium: {
      median: median(premiums) ?? 0,
      min: sortedPremiums[0] ?? 0,
      max: sortedPremiums[sortedPremiums.length - 1] ?? 0,
    },
    evaluation,
    byYear: [...years.entries()].sort(([a], [b]) => a - b).map(([year, v]) => {
      const c = coverage.get(year);
      return {
        year, months: v.ics.length, ic: mean(v.ics), neutralIc: mean(v.neutral),
        analysts: withAnalysts && c && c.stocks > 0 ? c.covered / c.stocks : null,
      };
    }),
    fit,
    departed: data.departed ?? undefined,
    bands,
    variants,
    topDecile,
    fidelity: fidelity ?? undefined,
    caveats: [
      withAnalysts ? BACKTEST_CAVEATS[0] : NO_ANALYSTS_CAVEAT,
      data.departed ? departedCaveat(data.departed) : BACKTEST_CAVEATS[1],
      ...BACKTEST_CAVEATS.slice(2),
    ].concat(FITTED_WEIGHTS_META
      ? [`Die Gewichte in Kraft sind auf die Monatsenden ${FITTED_WEIGHTS_META.from} bis ${FITTED_WEIGHTS_META.to} `
        + 'angepasst: Für sie sind die Zahlen oben zum Teil in-sample. Was die Anpassung auf Jahren leistet, die sie nicht gesehen hat, '
        + 'steht unter „Gewichte“.']
      : []),
  };
  // A trial on the first few companies says whether the code runs, not what
  // the score does: it is printed, never stored over a real run.
  if (opts.limit) {
    logger.info('Trial run (--limit): result not stored');
  } else {
    progress('Speichern');
    await saveBacktestRun(result, opts.trigger ?? 'cli');
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, digits = 3): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

export function renderBacktest(r: BacktestResult): string {
  const lines = [
    `Backtest ${r.universe ?? 'S&P 500'} ${r.from} → ${r.to} · ${r.months} month-ends · ${r.companies} companies`,
    `Premium adjustment per month: median ${(r.premium.median * 100).toFixed(2)} pts (${(r.premium.min * 100).toFixed(2)} … ${(r.premium.max * 100).toFixed(2)})`,
  ];
  for (const h of BACKTEST_HORIZONS) {
    lines.push('', `── ${h} month${h > 1 ? 's' : ''} ahead ──`);
    lines.push(`${'signal'.padEnd(34)} ${'IC'.padStart(7)} ${'t'.padStart(6)} ${'sector'.padStart(7)} ${'t'.padStart(6)} ${'hit'.padStart(5)} ${'top−bot'.padStart(8)} ${'n'.padStart(5)}`);
    for (const s of r.evaluation.ics.filter((x) => x.horizon === h && x.days > 0)) {
      lines.push(
        `${s.key.replace('score.factor.', '').replace(CRITERION_PREFIX, '  · ').replace(CANDIDATE_PREFIX, '  ◇ ').padEnd(34)} ${fmt(s.meanIc).padStart(7)} ${fmt(s.tStat, 1).padStart(6)} `
        + `${fmt(s.neutralIc).padStart(7)} ${fmt(s.neutralTStat, 1).padStart(6)} `
        + `${(s.hitRate === null ? '—' : `${Math.round(s.hitRate * 100)}%`).padStart(5)} `
        + `${(s.spread === null ? '—' : `${(s.spread * 100).toFixed(2)}%`).padStart(8)} ${fmt(s.meanCrossSection, 0).padStart(5)}`,
      );
    }
  }
  for (const seg of r.segments ?? []) {
    lines.push('', `── ${seg.label}: ${seg.companies} companies ──`);
    for (const h of BACKTEST_HORIZONS) {
      for (const sig of seg.ics.filter((x) => x.horizon === h && x.days > 0 && !x.key.startsWith(CRITERION_PREFIX))) {
        lines.push(`  ${h}M ${sig.key.replace('score.factor.', '').padEnd(28)} IC ${fmt(sig.meanIc).padStart(7)}  t ${fmt(sig.tStat, 1).padStart(5)}`
          + `  sector ${fmt(sig.neutralIc).padStart(7)}  t ${fmt(sig.neutralTStat, 1).padStart(5)}  n ${fmt(sig.meanCrossSection, 0)}`);
      }
    }
  }
  if (r.variants?.length) {
    lines.push('', '── Variants: the same rows under other rules ──');
    for (const v of r.variants) {
      const ic = (h: number) => v.ics.find((x) => x.key === 'score' && x.horizon === h);
      const top = (h: number) => v.steps.find((x) => x.horizon === h && x.bucket === '≥8');
      const d10 = (h: number) => v.deciles.find((x) => x.horizon === h && x.bucket === 'D10');
      lines.push(`  ${v.label}`);
      lines.push(`    IC  ${BACKTEST_HORIZONS.map((h) => `${h}M ${fmt(ic(h)?.meanIc)} (t ${fmt(ic(h)?.tStat, 1)}, sector ${fmt(ic(h)?.neutralIc)})`).join('  ')}`);
      lines.push(`    D10 ${BACKTEST_HORIZONS.map((h) => `${h}M ${d10(h)?.meanExcess == null ? '—' : `${(d10(h)!.meanExcess! * 100).toFixed(2)}%`} (t ${fmt(d10(h)?.tStat, 1)})`).join('  ')}`);
      lines.push(`    ≥8  ${BACKTEST_HORIZONS.map((h) => `${h}M ${top(h)?.meanExcess == null ? '—' : `${(top(h)!.meanExcess! * 100).toFixed(2)}%`} (n ${top(h)?.count ?? 0})`).join('  ')}`);
      lines.push(`    share ${Object.entries(v.verdictShare).map(([k, x]) => `${k} ${(x * 100).toFixed(1)}%`).join(', ')}`);
      for (const verdict of ['STRONG BUY', 'BUY']) {
        lines.push(`    ${verdict.padEnd(10)} ${BACKTEST_HORIZONS.map((h) => {
          const all = v.verdicts.find((x) => x.horizon === h && x.bucket === verdict);
          const halves = (v.halves ?? []).map((list) => list.find((x) => x.horizon === h && x.bucket === verdict));
          const pc = (x: { meanExcess: number | null } | undefined) => (x?.meanExcess == null ? '—' : `${(x.meanExcess * 100).toFixed(2)}%`);
          return `${h}M ${pc(all)} (t ${fmt(all?.tStat, 1)}, n ${all?.count ?? 0}; halves ${halves.map(pc).join(' / ')})`;
        }).join('  ')}`);
      }
    }
  }
  if (r.topDecile) {
    const pc = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
    lines.push('', '── The top tenth: profile (medians) ──');
    lines.push(`  ${'feature'.padEnd(26)} ${r.topDecile.profiles.map((g) => g.group.padStart(10)).join('')}`);
    for (const f of TOP_FEATURES) {
      lines.push(`  ${f.label.padEnd(26)} ${r.topDecile.profiles.map((g) => {
        const v = g.medians[f.key];
        return (v === null ? '—' : Math.abs(v) >= 1e6 ? `${(v / 1e9).toFixed(1)}B` : v.toFixed(3)).padStart(10);
      }).join('')}`);
    }
    for (const g of r.topDecile.profiles) {
      lines.push(`  ${g.group}: n ${g.n} · ${Object.entries(g.segments).map(([k, x]) => `${k} ${(x * 100).toFixed(0)}%`).join(', ')} · `
        + g.sectors.map((x) => `${x.sector} ${(x.share * 100).toFixed(0)}%`).join(', '));
    }
    for (const h of [3, 6]) {
      lines.push('', `── The top tenth split at its own median, ${h} months (above − below; halves; same split in D9) ──`);
      const rows = r.topDecile.splits.filter((x) => x.horizon === h).sort((a, b) => Math.abs(b.diff.t ?? 0) - Math.abs(a.diff.t ?? 0));
      for (const x of rows) {
        lines.push(`  ${x.label.padEnd(26)} above ${pc(x.high.mean).padStart(7)} below ${pc(x.low.mean).padStart(7)}  diff ${pc(x.diff.mean).padStart(7)} (t ${fmt(x.diff.t, 1)})`
          + `  2013–19 ${pc(x.first.mean).padStart(7)} (t ${fmt(x.first.t, 1)})  2020–26 ${pc(x.second.mean).padStart(7)} (t ${fmt(x.second.t, 1)})`
          + `  D9 ${pc(x.ninth.mean).padStart(7)} (t ${fmt(x.ninth.t, 1)})`);
      }
    }
  }
  lines.push('', 'Factor score IC at one month, by year:');
  for (const y of r.byYear) {
    lines.push(`  ${y.year}  IC ${fmt(y.ic)}  sector ${fmt(y.neutralIc)}  (${y.months} months)`
      + (y.analysts != null ? `  consensus for ${Math.round(y.analysts * 100)}%` : ''));
  }
  lines.push('', ...renderFit(r.fit), '', ...r.caveats.map((c) => `· ${c}`));
  if (r.fidelity) lines.push('', renderFidelity(r.fidelity));
  return lines.join('\n');
}

function renderFit(v: WeightValidation): string[] {
  const lines = [`Weights: fitted at ${v.horizon} month, checked on the half each fit did not see (split ${v.split})`];
  for (const [name, f] of [['forward', v.forward], ['reverse', v.reverse]] as const) {
    lines.push(`  ${name}: fitted ${f.fit.from} → ${f.fit.to}, scored ${f.tested.from} → ${f.tested.to}`
      + ` (prior width ${fmt(f.fit.priorSd.criteria, 4)} criteria, ${fmt(f.fit.priorSd.pillars, 4)} pillars)`);
    if (!f.fit.moved) {
      lines.push('    the rule moved nothing on these months: scored as the judgment is');
      continue;
    }
    for (const c of f.comparisons) {
      lines.push(`    ${c.horizon}M  IC ${fmt(c.judgment.ic)} → ${fmt(c.fitted.ic)}   gain ${fmt(c.gain.mean, 4)} (t ${fmt(c.gain.tStat, 1)}, `
        + `ahead in ${c.gain.ahead === null ? '—' : Math.round(c.gain.ahead * 100)}% of ${c.independent} windows)`);
    }
  }
  const joint = (f: WeightValidation['full']) => `Σt² ${f.joint.criteria.sumT2.toFixed(1)} over ${f.joint.criteria.k} criteria, `
    + `${f.joint.pillars.sumT2.toFixed(1)} over ${f.joint.pillars.k} pillars`;
  lines.push(`  joint tests: ${joint(v.forward.fit)} (first half) · ${joint(v.reverse.fit)} (second half) · ${joint(v.full)} (all)`);
  lines.push(`  ${v.held ? 'HELD' : v.full.moved ? 'DID NOT HOLD' : 'NOTHING TO FIT'} — the rule on every month `
    + `(prior width ${fmt(v.full.priorSd.criteria, 4)} criteria, ${fmt(v.full.priorSd.pillars, 4)} pillars):`);
  for (const w of v.full.rows.filter((x) => x.ic !== null)) {
    lines.push(`    ${(w.key === null ? w.pillar.toUpperCase() : `  ${w.key}`).padEnd(24)} ${w.judgment.toFixed(3)} → ${w.fitted.toFixed(3)}`
      + `   IC ${fmt(w.ic)} ± ${fmt(w.se)}`);
  }
  return lines;
}

/** `maxRSS` is in kilobytes on Linux and macOS alike, as Node reports it. */
const peakMemoryMb = () => Math.round(process.resourceUsage().maxRSS / 1024);

const isMain = process.argv[1]?.endsWith('backtest/run.ts') || process.argv[1]?.endsWith('backtest/run.js');
const cliArgs = process.argv.slice(2);

if (isMain && cliArgs.includes('--fidelity')) {
  // The comparison with the live scores alone, printed: every full run
  // stores it with its result, this is for looking without one.
  (async () => {
    const cfg = getConfig();
    await waitForDatabase();
    const data = await loadBacktestData({
      dir: join(cfg.dataDir, 'backtest'), from: '2013-01-01', universe: 'sp1500', analysts: true, departed: false, progress: () => {},
    });
    const r = await fidelityCheck(data, await rateHistory(data.priceFrom, cfg.fredApiKey));
    console.log(r ? renderFidelity(r) : 'Nothing to compare: too few stocks in both the app and the backtest');
    await closePool();
  })().catch(async (e) => {
    logger.error(`Fidelity check failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
} else if (isMain) {
  const args = cliArgs;
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const trigger: BacktestTrigger = flag('--trigger') === 'cron' ? 'cron' : flag('--trigger') === 'manual' ? 'manual' : 'cli';
  let status: BacktestStatus | null = null;
  const report = (patch: Partial<BacktestStatus>) => {
    if (!status) return Promise.resolve();
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    return writeBacktestStatus(status).catch(() => { /* the run matters more than its status line */ });
  };
  let lock: BacktestLock | null = null;
  (async () => {
    getConfig();
    await waitForDatabase();
    lock = await takeBacktestLock();
    if (!lock) {
      logger.warn('Another backtest is running — not starting a second one');
      await closePool();
      process.exit(2);
    }
    const started = Date.now();
    status = {
      state: 'running', trigger, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: null, phase: 'Start', error: null, peakMb: null,
    };
    await report({});
    // A status write a step: a few hundred over a run, none of them awaited by the run.
    let last = 0;
    const result = await runBacktest({
      from: flag('--from'), to: flag('--to'), limit: flag('--limit') ? Number(flag('--limit')) : undefined,
      analysts: !args.includes('--no-analysts'),
      insiders: !args.includes('--no-insiders'),
      departed: !args.includes('--no-departed'),
      studies: args.includes('--studies'),
      universe: flag('--universe') === 'sp500' ? 'sp500' : 'sp1500',
      trigger,
      onProgress: (phase) => {
        if (Date.now() - last < 2_000) return;
        last = Date.now();
        void report({ phase });
      },
    });
    console.log(renderBacktest(result));
    if (args.includes('--write-weights')) {
      if (!result.fit.held) {
        logger.warn('Weights not written: the fit did not hold up on the months it had not seen');
      } else {
        const out = resolve('src/analysis/weight-table.ts');
        writeFileSync(out, renderWeightTable(result.fit, {
          generatedAt: result.generatedAt, from: result.from, to: result.to, months: result.months, companies: result.companies,
        }));
        logger.success(`Weights written → ${out}`);
      }
    }
    const peakMb = peakMemoryMb();
    await report({ state: 'done', finishedAt: new Date().toISOString(), phase: null, peakMb });
    logger.success(`Backtest finished in ${((Date.now() - started) / 60_000).toFixed(1)} min, peak memory ${peakMb} MB`);
    await lock?.release();
    await closePool();
  })().catch(async (e) => {
    logger.error(`Backtest failed: ${(e as Error).message}`);
    await report({ state: 'failed', finishedAt: new Date().toISOString(), error: (e as Error).message, peakMb: peakMemoryMb() });
    await lock?.release().catch(() => {});
    await closePool();
    process.exit(1);
  });
}
