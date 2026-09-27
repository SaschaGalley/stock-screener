/**
 * Does the factor score rank the stocks that went on to do better — measured
 * over the past, not waited for?
 *
 *   pnpm run backtest                     # S&P 500, month-ends since 2013
 *   pnpm run backtest -- --from 2016-01   # a later start
 *   pnpm run backtest -- --limit 60       # the first 60 companies, to try it out
 *
 * The live evaluation needs months of stored scores before it says anything.
 * This one rebuilds them. At every month-end since 2013 it reconstructs each
 * S&P 500 member as the scorer would have seen it that day: the SEC filings
 * filed before it, and the prices up to its close (`payload.ts`). It then scores
 * the whole cross-section with the live code and evaluates the scores against
 * the following months' returns, with the same `evaluate` the page uses.
 *
 * Everything the live system calibrates is recalibrated per month, from that
 * month's cross-section only: the premium adjustment, and every criterion's
 * reference distribution. Nothing from after a month-end reaches its scores.
 *
 * What it cannot do, and says so in the result:
 *   - Analyst data was never archived, so the consensus and revisions pillars
 *     are silent and the DCF starts from trailing growth.
 *   - The universe is today's index members, each from the day it joined.
 *     Companies that left before today are missing: survivors only.
 *   - Peer groups are the index's own GICS sub-industries, not Finnhub's.
 *
 * The result is stored in `app_state` (`backtest.result`) for the page.
 */

import { join } from 'path';

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { closePool, waitForDatabase } from '../db/client.js';
import { writeAppState } from '../db/admin.js';
import { companyFacts, CompanyFacts } from '../data/edgar-facts.js';
import { fetchSp500Constituents } from '../data/universe.js';
import { sectorToEtf } from '../data/macro.js';
import {
  collectCalibrated, percentiles, sectorKey, useCalibrationTable, usePremiumAdjustment,
  type CriterionDistribution,
} from '../analysis/calibration.js';
import { computeAllMetrics, impliedPremiumShift } from '../analysis/computeMetrics.js';
import { computeFactorScore, PILLAR_WEIGHTS } from '../analysis/score.js';
import {
  evaluate, suggestWeights, type Close, type SignalPoint,
} from '../analysis/evaluate.js';
import { PILLAR_KEYS } from '../types.js';
import { Company, payloadAt, yahooSector } from './payload.js';
import { BACKTEST_CAVEATS, BacktestResult, RESULT_KEY } from './result.js';
import { crossSectionPeers } from './peers.js';
import { indexAtOrBefore, priceHistory, PriceHistory } from './prices.js';
import { rateHistory } from './rates.js';

const BENCHMARK = '^GSPC';
/** Prices from a year before the first month-end: momentum reads twelve months back. */
const PRICE_LEAD_YEARS = 2;
/** Months ahead the scores are judged over. */
export const BACKTEST_HORIZONS = [1, 3];
/** The horizon the weight suggestion reads: one month, as factor research measures. */
export const BACKTEST_WEIGHT_HORIZON = 1;

const pillarKey = (p: string) => `score.factor.pillars.${p}.score`;
/** Signals that are one criterion's figure rather than a score. */
export const CRITERION_PREFIX = 'criterion.';
export const BACKTEST_SIGNALS = ['score.factor.score', 'score.factor.raw', ...PILLAR_KEYS.map(pillarKey)];
const LABEL_KEY = 'score.factor.verdict';

/** The last trading day of every month between `from` and `to`. */
export function monthEnds(dates: string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < dates.length; k++) {
    const d = dates[k];
    if (d < from || d > to) continue;
    const next = dates[k + 1];
    if (!next || next.slice(0, 7) !== d.slice(0, 7)) out.push(d);
  }
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A fixed number of downloads in flight, results in input order. */
async function pooled<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

export async function runBacktest(opts: { from?: string; to?: string; limit?: number } = {}): Promise<BacktestResult> {
  const cfg = getConfig();
  const dir = join(cfg.dataDir, 'backtest');
  const from = opts.from ? `${opts.from.slice(0, 7)}-01` : '2013-01-01';
  const to = opts.to ?? new Date().toISOString().slice(0, 10);
  const priceFrom = `${Number(from.slice(0, 4)) - PRICE_LEAD_YEARS}-01-01`;

  const constituents = (await fetchSp500Constituents()).filter((c) => c.cik);
  const companies: Company[] = constituents.slice(0, opts.limit ?? constituents.length).map((c) => ({
    symbol: c.symbol, name: c.name, cik: c.cik!, sector: c.sector, subIndustry: c.subIndustry, added: c.added,
  }));
  logger.info(`Backtest: ${companies.length} companies, month-ends ${from} → ${to}`);

  const facts = new Map<string, CompanyFacts>();
  let done = 0;
  await pooled(companies, 4, async (c) => {
    const f = await companyFacts(c.cik, join(dir, 'facts'));
    if (f) facts.set(c.symbol, f);
    if (++done % 50 === 0) logger.info(`  SEC filings: ${done}/${companies.length}`);
  });

  const etfs = [...new Set(companies.map((c) => sectorToEtf(c.sector)).filter((e): e is string => !!e))];
  const prices = new Map<string, PriceHistory>();
  done = 0;
  await pooled([...companies.map((c) => c.symbol), BENCHMARK, ...etfs], 4, async (symbol) => {
    const p = await priceHistory(symbol, priceFrom, join(dir, 'prices'));
    if (p) prices.set(symbol, p);
    if (++done % 50 === 0) logger.info(`  Prices: ${done}/${companies.length + etfs.length + 1}`);
  });
  const bench = prices.get(BENCHMARK);
  if (!bench) throw new Error(`No ${BENCHMARK} history — cannot build the calendar`);

  const ratesOn = await rateHistory(priceFrom, cfg.fredApiKey);
  const days = monthEnds(bench.dates, from, to);

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

  try {
    for (const [m, day] of days.entries()) {
      const entries = companies.flatMap((c) => {
        if (c.added && c.added > day) return [];
        const f = facts.get(c.symbol), px = prices.get(c.symbol);
        if (!f || !px) return [];
        const etf = sectorToEtf(c.sector);
        const p = payloadAt(c, f, px, bench, etf ? prices.get(etf) ?? null : null, day);
        return p ? [{ c, ...p }] : [];
      });
      if (entries.length < 20) continue;

      const rates = ratesOn(day);
      const peers = crossSectionPeers(entries.map((e) => ({
        symbol: e.c.symbol, sector: e.c.sector, subIndustry: e.c.subIndustry, financials: e.financials,
      })));

      // The month's premium adjustment, from this month's DCFs only.
      usePremiumAdjustment(0);
      const shifts = entries.flatMap((e) => {
        const s = impliedPremiumShift({ financials: e.financials, rates, sectorMedians: peers.get(e.c.symbol) ?? null });
        return s === null ? [] : [s];
      });
      const premium = median(shifts) ?? 0;
      premiums.push(premium);
      usePremiumAdjustment(premium);

      const metrics = entries.map((e) => computeAllMetrics(e.financials, rates, peers.get(e.c.symbol) ?? null));
      const score = (k: number) => computeFactorScore({
        financials: entries[k].financials, metrics: metrics[k], sectorMedians: peers.get(entries[k].c.symbol) ?? null,
        marketSignals: entries[k].signals, technicalSignals: null,
      });

      // The month's reference distributions, from this month's cross-section only.
      const values = new Map<string, number[]>();
      const add = (key: string, value: number) => values.set(key, [...(values.get(key) ?? []), value]);
      collectCalibrated((key, value, sector) => {
        add(key, value);
        if (sector) add(sectorKey(key, sector), value);
      }, () => entries.forEach((_, k) => score(k)));
      const table: Record<string, CriterionDistribution> = {};
      for (const [key, xs] of values) table[key] = { quantiles: percentiles(xs), n: xs.length, symbols: xs.length };
      useCalibrationTable(table);
      usePremiumAdjustment(premium);

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
        push('score.factor.score', e.c.symbol, { at, value: f.score });
        push('score.factor.raw', e.c.symbol, { at, value: f.raw });
        for (const p of f.pillars) push(pillarKey(p.key), e.c.symbol, { at, value: p.score });
        push(LABEL_KEY, e.c.symbol, { at, value: null, text: f.verdict });
      });
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

  const sortedPremiums = [...premiums].sort((a, b) => a - b);
  const result: BacktestResult = {
    generatedAt: new Date().toISOString(),
    from: days[0] ?? from, to: days[days.length - 1] ?? to,
    months: premiums.length,
    companies: scored.size,
    premium: {
      median: median(premiums) ?? 0,
      min: sortedPremiums[0] ?? 0,
      max: sortedPremiums[sortedPremiums.length - 1] ?? 0,
    },
    evaluation,
    byYear: [...years.entries()].sort(([a], [b]) => a - b).map(([year, v]) => ({
      year, months: v.ics.length, ic: mean(v.ics), neutralIc: mean(v.neutral),
    })),
    weights: suggestWeights(PILLAR_WEIGHTS, evaluation.ics, BACKTEST_WEIGHT_HORIZON, pillarKey),
    weightHorizon: BACKTEST_WEIGHT_HORIZON,
    caveats: BACKTEST_CAVEATS,
  };
  await writeAppState(RESULT_KEY, JSON.stringify(result));
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, digits = 3): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

export function renderBacktest(r: BacktestResult): string {
  const lines = [
    `Backtest ${r.from} → ${r.to} · ${r.months} month-ends · ${r.companies} companies`,
    `Premium adjustment per month: median ${(r.premium.median * 100).toFixed(2)} pts (${(r.premium.min * 100).toFixed(2)} … ${(r.premium.max * 100).toFixed(2)})`,
  ];
  for (const h of BACKTEST_HORIZONS) {
    lines.push('', `── ${h} month${h > 1 ? 's' : ''} ahead ──`);
    lines.push(`${'signal'.padEnd(34)} ${'IC'.padStart(7)} ${'t'.padStart(6)} ${'sector'.padStart(7)} ${'t'.padStart(6)} ${'hit'.padStart(5)} ${'top−bot'.padStart(8)} ${'n'.padStart(5)}`);
    for (const s of r.evaluation.ics.filter((x) => x.horizon === h && x.days > 0)) {
      lines.push(
        `${s.key.replace('score.factor.', '').replace(CRITERION_PREFIX, '  · ').padEnd(34)} ${fmt(s.meanIc).padStart(7)} ${fmt(s.tStat, 1).padStart(6)} `
        + `${fmt(s.neutralIc).padStart(7)} ${fmt(s.neutralTStat, 1).padStart(6)} `
        + `${(s.hitRate === null ? '—' : `${Math.round(s.hitRate * 100)}%`).padStart(5)} `
        + `${(s.spread === null ? '—' : `${(s.spread * 100).toFixed(2)}%`).padStart(8)} ${fmt(s.meanCrossSection, 0).padStart(5)}`,
      );
    }
  }
  lines.push('', 'Factor score IC at one month, by year:');
  for (const y of r.byYear) lines.push(`  ${y.year}  IC ${fmt(y.ic)}  sector ${fmt(y.neutralIc)}  (${y.months} months)`);
  lines.push('', `Pillar weights at ${r.weightHorizon} month (a suggestion, never applied):`);
  for (const w of r.weights) {
    lines.push(`  ${w.key.padEnd(12)} ${w.current.toFixed(2)} → ${w.suggested.toFixed(2)}   IC ${fmt(w.ic)} over ${w.independent} windows`);
  }
  lines.push('', ...r.caveats.map((c) => `· ${c}`));
  return lines.join('\n');
}

const isMain = process.argv[1]?.endsWith('backtest/run.ts') || process.argv[1]?.endsWith('backtest/run.js');

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  (async () => {
    getConfig();
    await waitForDatabase();
    const started = Date.now();
    const result = await runBacktest({
      from: flag('--from'), to: flag('--to'), limit: flag('--limit') ? Number(flag('--limit')) : undefined,
    });
    console.log(renderBacktest(result));
    logger.success(`Backtest finished in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
    await closePool();
  })().catch(async (e) => {
    logger.error(`Backtest failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
}
