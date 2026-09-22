/**
 * Score the scores: rank correlation of every stored signal with the returns
 * that followed it.
 *
 * Nothing here is stored. The score series already accumulates with every
 * refresh, and prices are fetched fresh, so the evaluation is a recomputation
 * that gets more informative each night without any state of its own. Read it
 * with the sample size in view — at a few dozen stocks and a few weeks of
 * history the standard error of a mean IC is larger than any IC worth having,
 * and the `indep.` column says how many windows the t-statistic stands on.
 *
 *   pnpm run evaluate [--horizons 5,20,60] [--symbol AAPL,MSFT] [--json]
 */

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { fetchDailyBars } from '../data/macro.js';
import { evaluate, type Close, type Evaluation, type SignalPoint } from '../analysis/evaluate.js';
import { PILLAR_KEYS } from '../types.js';
import { PILLAR_LABELS } from '../analysis/score.js';
import { closePool, waitForDatabase } from './client.js';
import { listSymbols, readSeries } from './store.js';

const BENCHMARK = '^GSPC';
const LABEL_KEY = 'score.final.verdict';

/**
 * The signals worth ranking, headline first.
 *
 * `factor.raw` is the factor score before the confidence shrink and the
 * conviction stretch: if it ranks better than `factor.score`, the shrink is
 * throwing information away. `verdict.score` is the old single-call LLM score,
 * kept as the baseline the whole deterministic pipeline has to beat.
 */
export const EVALUATED_SIGNALS: { key: string; label: string; title: string; pillar?: boolean }[] = [
  { key: 'score.final.score',     label: 'Final',         title: 'Gesamt-Score' },
  { key: 'score.factor.score',    label: 'Factor',        title: 'Faktor-Score' },
  { key: 'score.factor.raw',      label: 'Factor (raw)',  title: 'Faktor roh (ohne Schrumpfung)' },
  { key: 'score.narrative.score', label: 'Narrative',     title: 'Narrativ (Text)' },
  ...PILLAR_KEYS.map((p) => ({
    key: `score.factor.pillars.${p}.score`, label: `  ${p}`, title: PILLAR_LABELS[p], pillar: true,
  })),
  { key: 'verdict.score',         label: 'Old LLM score', title: 'Alter LLM-Score (Vergleich)' },
];

const PRICE_CONCURRENCY = 4;

function toCloses(bars: { date: Date; close: number }[]): Close[] {
  return bars.map((b) => ({ date: b.date.toISOString().slice(0, 10), close: b.close }));
}

export async function runEvaluation(opts: {
  symbols?:  string[];
  horizons?: number[];
} = {}): Promise<Evaluation> {
  const symbols = opts.symbols?.length ? opts.symbols : await listSymbols();
  const horizons = opts.horizons?.length ? opts.horizons : [5, 20, 60];
  const keys = [...EVALUATED_SIGNALS.map((s) => s.key), LABEL_KEY];

  const signals = new Map<string, Map<string, SignalPoint[]>>(keys.map((k) => [k, new Map()]));
  let earliest = Date.now();
  for (const symbol of symbols) {
    for (const series of await readSeries(symbol, keys)) {
      const points = series.points.map((p) => ({ at: new Date(p.at), value: p.value, text: p.text }));
      if (points.length) earliest = Math.min(earliest, points[0].at.getTime());
      signals.get(series.key)!.set(symbol, points);
    }
  }

  // Fetch from a little before the first signal: a symbol's entry close is its
  // last session at or before the formation day, which can be a day earlier.
  const daysBack = Math.ceil((Date.now() - earliest) / 86_400_000) + 10;
  const benchmark = toCloses(await fetchDailyBars(BENCHMARK, daysBack));
  if (benchmark.length === 0) throw new Error(`No ${BENCHMARK} history — cannot build the calendar`);

  const prices = new Map<string, Close[]>();
  // A few at a time: Yahoo throttles bursts, and one at a time kept the web
  // page waiting half a minute.
  const queue = [...symbols];
  await Promise.all(Array.from({ length: PRICE_CONCURRENCY }, async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      const bars = await fetchDailyBars(symbol, daysBack);
      if (bars.length) prices.set(symbol, toCloses(bars));
      else logger.warn(`${symbol}: no price history — left out`);
    }
  }));

  return evaluate({ signals, prices, benchmark, horizons, labelKey: LABEL_KEY });
}

/**
 * How long the web page reuses a result.
 *
 * The inputs move once a day — a nightly refresh adds a score, a session adds a
 * close — and a run fetches a year of prices per symbol, so recomputing on
 * every page view would spend a minute of Yahoo requests to say the same thing.
 */
export const EVALUATION_TTL_MS = 6 * 60 * 60_000;

const memo = new Map<string, { at: number; value: Promise<Evaluation> }>();

/** `runEvaluation` behind a per-horizon-set cache; `fresh` forces a recompute. */
export function cachedEvaluation(horizons: number[], fresh = false): { at: number; value: Promise<Evaluation> } {
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

export function renderEvaluation(ev: Evaluation): string {
  const lines: string[] = [];
  lines.push(`Signals ${ev.from ?? '—'} → ${ev.to ?? '—'} · ${ev.symbols} symbols`);
  const labelOf = new Map(EVALUATED_SIGNALS.map((s) => [s.key, s.label]));

  for (const h of [...new Set(ev.ics.map((r) => r.horizon))]) {
    lines.push('', `── ${h} sessions ahead ──`);
    lines.push(`${'signal'.padEnd(16)} ${'IC'.padStart(6)} ${'t'.padStart(6)} ${'hit'.padStart(5)} ${'top−bot'.padStart(8)}  ${'days'.padStart(4)} ${'indep.'.padStart(6)} ${'n'.padStart(4)}`);
    for (const r of ev.ics.filter((x) => x.horizon === h)) {
      if (r.days === 0) continue;
      lines.push(
        `${(labelOf.get(r.key) ?? r.key).padEnd(16)} ${fmt(r.meanIc).padStart(6)} ${fmt(r.tStat, 1).padStart(6)} `
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
