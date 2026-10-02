/**
 * Score the scores: rank correlation of every stored signal with the returns
 * that followed it.
 *
 * Two cross-sections. The watchlist carries every signal, the prose included,
 * and is the only place the narrative and the old LLM score can be judged. The
 * universe — watchlist and reference symbols together — carries only the
 * factor signals, which every stock has, and is several hundred stocks wide:
 * one day's IC over 37 stocks has a standard error near ±0.17, over 500 near
 * ±0.045. The pillar weight suggestion reads the universe.
 *
 * Nothing here is stored. The score series already accumulates with every
 * refresh, and prices are fetched fresh, so the evaluation is a recomputation
 * that gets more informative each night without any state of its own. Read it
 * with the sample size in view, and the `indep.` column says how many windows
 * the t-statistic stands on.
 *
 *   pnpm run evaluate [--horizons 5,20,60] [--symbol AAPL,MSFT] [--json]
 */

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { BENCHMARK_CURRENCY, fetchDailyBars } from '../data/macro.js';
import { fxTicker, majorCurrency } from '../currencies.js';
import {
  evaluate, inCommonCurrency, suggestWeights,
  type Close, type Evaluation, type SignalPoint, type WeightSuggestion,
} from '../analysis/evaluate.js';
import { PILLAR_KEYS } from '../types.js';
import { PILLAR_LABELS, PILLAR_WEIGHTS } from '../analysis/score.js';
import { closePool, waitForDatabase } from './client.js';
import { listSymbols, readSeries, symbolFacts } from './store.js';

const BENCHMARK = '^GSPC';
const LABEL_KEY = 'score.final.verdict';

/** The horizon the weight suggestion reads: about a month, as factor research measures. */
export const WEIGHT_HORIZON = 20;

const pillarKey = (p: string) => `score.factor.pillars.${p}.score`;

/**
 * The signals worth ranking, headline first.
 *
 * `factor.raw` is the factor score before the confidence shrink and the
 * conviction stretch: if it ranks better than `factor.score`, the shrink is
 * throwing information away. `verdict.score` is the old single-call LLM score,
 * kept as the baseline the whole deterministic pipeline has to beat.
 */
export const EVALUATED_SIGNALS: {
  key: string; label: string; title: string; pillar?: boolean;
  /** Computed for every stock from the numbers alone, so it is evaluated on the universe too. */
  factor?: boolean;
}[] = [
  { key: 'score.final.score',     label: 'Final',         title: 'Gesamt-Score' },
  { key: 'score.factor.score',    label: 'Factor',        title: 'Faktor-Score', factor: true },
  { key: 'score.factor.raw',      label: 'Factor (raw)',  title: 'Faktor roh (ohne Schrumpfung)', factor: true },
  { key: 'score.narrative.score', label: 'Narrative',     title: 'Narrativ (Text)' },
  ...PILLAR_KEYS.map((p) => ({
    key: pillarKey(p), label: `  ${p}`, title: PILLAR_LABELS[p], pillar: true, factor: true,
  })),
  { key: 'verdict.score',         label: 'Old LLM score', title: 'Alter LLM-Score (Vergleich)' },
];

/** Both cross-sections and what the universe says about the pillar weights. */
export interface EvaluationReport {
  /** The watchlist: every signal, the prose included. */
  watchlist: Evaluation;
  /** Watchlist and reference universe together, factor signals only; null before there is a universe. */
  universe:  Evaluation | null;
  /** Pillar weights the evidence argues for at `WEIGHT_HORIZON` — see `suggestWeights`. */
  weights:   WeightSuggestion[];
  weightHorizon: number;
}

const PRICE_CONCURRENCY = 6;

function toCloses(bars: { date: Date; close: number }[]): Close[] {
  return bars.map((b) => ({ date: b.date.toISOString().slice(0, 10), close: b.close }));
}

export async function runEvaluation(opts: {
  symbols?:  string[];
  horizons?: number[];
} = {}): Promise<EvaluationReport> {
  // An explicit list is someone asking about those stocks: no universe then.
  const watchlist = opts.symbols?.length ? opts.symbols : await listSymbols('watchlist');
  const reference = opts.symbols?.length ? [] : await listSymbols('reference');
  const symbols = [...watchlist, ...reference];
  const horizons = opts.horizons?.length ? opts.horizons : [5, 20, 60];

  const keys = [...EVALUATED_SIGNALS.map((s) => s.key), LABEL_KEY];
  const factorKeys = [...EVALUATED_SIGNALS.filter((s) => s.factor).map((s) => s.key), LABEL_KEY];
  const onWatchlist = new Set(watchlist);

  const watchSignals = new Map<string, Map<string, SignalPoint[]>>(keys.map((k) => [k, new Map()]));
  const allSignals = new Map<string, Map<string, SignalPoint[]>>(factorKeys.map((k) => [k, new Map()]));
  let earliest = Date.now();
  for (const symbol of symbols) {
    const watched = onWatchlist.has(symbol);
    for (const series of await readSeries(symbol, watched ? keys : factorKeys)) {
      const points = series.points.map((p) => ({ at: new Date(p.at), value: p.value, text: p.text }));
      if (points.length) earliest = Math.min(earliest, points[0].at.getTime());
      if (watched) watchSignals.get(series.key)!.set(symbol, points);
      allSignals.get(series.key)?.set(symbol, points);
    }
  }

  // Fetch from a little before the first signal: a symbol's entry close is its
  // last session at or before the formation day, which can be a day earlier.
  const daysBack = Math.ceil((Date.now() - earliest) / 86_400_000) + 10;
  const benchmark = toCloses(await fetchDailyBars(BENCHMARK, daysBack));
  if (benchmark.length === 0) throw new Error(`No ${BENCHMARK} history — cannot build the calendar`);

  // Each listing's currency, and the dollar rate of every one that is not the
  // benchmark's: a euro listing is credited with its return in dollars, the
  // way the index it is measured against is.
  const facts = await symbolFacts(symbols);
  const currencyOf = (s: string) => majorCurrency(facts.get(s)?.currency) ?? BENCHMARK_CURRENCY;
  const fx = new Map<string, Close[]>();
  for (const cur of new Set(symbols.map(currencyOf))) {
    if (cur === BENCHMARK_CURRENCY) continue;
    fx.set(cur, toCloses(await fetchDailyBars(fxTicker(cur, BENCHMARK_CURRENCY), daysBack)));
  }

  const prices = new Map<string, Close[]>();
  // A few at a time: Yahoo throttles bursts, and one at a time kept the web
  // page waiting half a minute.
  const queue = [...symbols];
  await Promise.all(Array.from({ length: PRICE_CONCURRENCY }, async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      const bars = await fetchDailyBars(symbol, daysBack);
      if (!bars.length) {
        logger.warn(`${symbol}: no price history — left out`);
        continue;
      }
      const cur = currencyOf(symbol);
      if (cur === BENCHMARK_CURRENCY) {
        prices.set(symbol, toCloses(bars));
        continue;
      }
      const rate = fx.get(cur);
      if (rate?.length) prices.set(symbol, inCommonCurrency(toCloses(bars), rate));
      else logger.warn(`${symbol}: no ${cur}/${BENCHMARK_CURRENCY} history — left out rather than mixed with the currency`);
    }
  }));

  const sectors = new Map<string, string>();
  for (const [symbol, f] of facts) if (f.sector) sectors.set(symbol, f.sector);

  const common = { prices, benchmark, horizons, labelKey: LABEL_KEY, sectors };
  const watch = evaluate({ ...common, signals: watchSignals });
  const universe = reference.length ? evaluate({ ...common, signals: allSignals }) : null;
  return {
    watchlist: watch,
    universe,
    weights:   suggestWeights(PILLAR_WEIGHTS, (universe ?? watch).ics, WEIGHT_HORIZON, pillarKey),
    weightHorizon: WEIGHT_HORIZON,
  };
}

/**
 * How long the web page reuses a result.
 *
 * The inputs move once a day — a nightly refresh adds a score, a session adds a
 * close — and a run fetches a year of prices per symbol, so recomputing on
 * every page view would spend a minute of Yahoo requests to say the same thing.
 */
export const EVALUATION_TTL_MS = 6 * 60 * 60_000;

const memo = new Map<string, { at: number; value: Promise<EvaluationReport> }>();

/** `runEvaluation` behind a per-horizon-set cache; `fresh` forces a recompute. */
export function cachedEvaluation(horizons: number[], fresh = false): { at: number; value: Promise<EvaluationReport> } {
  const key = horizons.join(',');
  const hit = memo.get(key);
  if (hit && !fresh && Date.now() - hit.at < EVALUATION_TTL_MS) return hit;
  const entry = { at: Date.now(), value: runEvaluation({ horizons }) };
  // A failed run must not be served for six hours.
  entry.value.catch(() => { if (memo.get(key) === entry) memo.delete(key); });
  memo.set(key, entry);
  return entry;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function fmt(v: number | null, digits = 2): string {
  return v === null ? '—' : v.toFixed(digits);
}

function pct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

function renderScope(title: string, ev: Evaluation): string[] {
  const lines: string[] = [];
  lines.push(`${title}: signals ${ev.from ?? '—'} → ${ev.to ?? '—'} · ${ev.symbols} symbols`);
  const labelOf = new Map(EVALUATED_SIGNALS.map((s) => [s.key, s.label]));

  for (const h of [...new Set(ev.ics.map((r) => r.horizon))]) {
    lines.push('', `── ${h} sessions ahead ──`);
    lines.push(`${'signal'.padEnd(16)} ${'IC'.padStart(6)} ${'t'.padStart(6)} ${'IC sect'.padStart(7)} ${'t'.padStart(5)} ${'hit'.padStart(5)} ${'top−bot'.padStart(8)}  ${'days'.padStart(4)} ${'indep.'.padStart(6)} ${'n'.padStart(4)}`);
    for (const r of ev.ics.filter((x) => x.horizon === h)) {
      if (r.days === 0) continue;
      lines.push(
        `${(labelOf.get(r.key) ?? r.key).padEnd(16)} ${fmt(r.meanIc).padStart(6)} ${fmt(r.tStat, 1).padStart(6)} `
        + `${fmt(r.neutralIc).padStart(7)} ${fmt(r.neutralTStat, 1).padStart(5)} `
        + `${(r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)}%`).padStart(5)} ${pct(r.spread).padStart(8)}  `
        + `${String(r.days).padStart(4)} ${String(r.independent).padStart(6)} ${fmt(r.meanCrossSection, 0).padStart(4)}`,
      );
    }
    const byLabel = ev.labels.filter((l) => l.horizon === h);
    if (byLabel.length) {
      lines.push('  excess return by verdict (non-overlapping windows):');
      for (const l of byLabel) lines.push(`    ${l.label.padEnd(12)} ${pct(l.meanExcess).padStart(8)}  (${l.count})`);
    }
    if (!ev.ics.some((x) => x.horizon === h && x.days > 0)) {
      lines.push('  (no window of this length has closed yet)');
    }
  }
  return lines;
}

export function renderEvaluation(report: EvaluationReport): string {
  const lines = renderScope('Watchlist', report.watchlist);
  if (report.universe) lines.push('', '', ...renderScope('Universe (factor signals)', report.universe));
  lines.push('', '', `Pillar weights at ${report.weightHorizon} sessions (IC shrunk by its standard error; a suggestion, never applied):`);
  for (const w of report.weights) {
    lines.push(
      `  ${w.key.padEnd(12)} ${w.current.toFixed(2)} → ${w.suggested.toFixed(2)}`
      + `   IC ${fmt(w.ic)} shrunk ${fmt(w.shrunkIc, 3)} over ${w.independent} windows`,
    );
  }
  return lines.join('\n');
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('evaluate.ts') || process.argv[1]?.endsWith('evaluate.js');

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const horizons = flag('--horizons')?.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const symbols = flag('--symbol')?.split(',').map((s) => s.trim().toUpperCase());

  (async () => {
    getConfig();
    await waitForDatabase();
    const ev = await runEvaluation({ symbols, horizons });
    console.log(args.includes('--json') ? JSON.stringify(ev, null, 2) : renderEvaluation(ev));
    await closePool();
  })().catch(async (e) => {
    logger.error(`Evaluation failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
}
