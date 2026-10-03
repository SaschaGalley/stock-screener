/**
 * Would the score have beaten the index — as a portfolio, after costs?
 *
 * Everything else in the backtest reads the score against the month's
 * average stock: an equal-weighted crowd of fifteen hundred. An investor's
 * yardstick is the cap-weighted index, and from 2013 on the largest companies
 * ran far ahead of the average one, so "ahead of the average stock" and
 * "ahead of the MSCI World" are different claims. This asks the second.
 *
 * At every rebalancing month-end the portfolio buys the top N stocks by a
 * signal, in equal parts, and holds them untouched until the next one. Each
 * stock is valued on dividend-adjusted closes at every month-end in between,
 * so a quarterly or a yearly portfolio has a monthly path like the index. A
 * stock that stops trading inside a holding period stays at its last close —
 * cash, as a takeover would leave it. Every name bought or sold costs
 * `COST_PER_SIDE` of its weight; taxes are left out.
 *
 * Two signals, both fixed before the first run, and the rule they are read
 * by:
 *
 *   - `score` — the published factor score.
 *   - `quality-momentum` — the mean of the quality and the momentum pillar, as
 *     the research describes the two most robust premia (Novy-Marx 2013 on
 *     gross profitability; Asness, Frazzini and Pedersen 2019 on quality;
 *     Jegadeesh and Titman 1993 on momentum), not as this data would weight
 *     them. Valuation, the balance sheet, the consensus and the revisions are
 *     left out.
 *
 * The rule: a signal "beats the index" only if, at 25 stocks rebalanced
 * quarterly, it is ahead of the MSCI World ETF after costs in both halves of
 * the years (2013–2019, 2020–2026). `quality-momentum` "beats the score" only
 * if it is ahead of `score` the same way. The other sizes and rhythms are
 * shown, not judged: five rules are five chances for one to look good.
 *
 * What the universe lacks says which way the result leans: companies that
 * were bought or went bankrupt after leaving the index are missing, the
 * bankrupt ones among the stocks a low score would have avoided and a top-N
 * portfolio could have held. The S&P 600 joins in 2019.
 */

import type { Close } from '../analysis/evaluate.js';
import { HALF } from './top-decile.js';

export const PORTFOLIO_SIGNALS = [
  { key: 'score',            label: 'Faktor-Score (veröffentlicht)' },
  { key: 'quality-momentum', label: 'Qualität + Momentum (Literatur)' },
] as const;
export type PortfolioSignal = (typeof PORTFOLIO_SIGNALS)[number]['key'];

/** Portfolio sizes and rebalancing rhythms (months); the first is the one the rule judges. */
export const PORTFOLIO_RULES = [
  { size: 25, every: 3 },
  { size: 25, every: 1 },
  { size: 25, every: 12 },
  { size: 50, every: 3 },
  { size: 50, every: 12 },
] as const;

/** Commission and half the spread on a liquid US share, per name bought or sold, as a share of its weight. */
export const COST_PER_SIDE = 0.001;

/** The index funds a portfolio is set against, total return: the S&P 500 and the MSCI World. */
export const PORTFOLIO_BENCHMARKS = [
  { key: 'SPY',  label: 'S&P 500 (SPY)' },
  { key: 'URTH', label: 'MSCI World (URTH)' },
] as const;
/** The one the rule reads. */
export const RULE_BENCHMARK = 'URTH';

/** One scored company at one month-end: each signal's value, in `PORTFOLIO_SIGNALS` order, NaN where it has none. */
export interface PortfolioRecord {
  day:    string;
  symbol: string;
  values: Float64Array;
}

export interface PathStats {
  /** Compound annual return. */
  cagr:        number | null;
  /** Annualised standard deviation of the monthly returns. */
  vol:         number | null;
  /** Deepest fall from a month-end high. */
  maxDrawdown: number | null;
}

export interface RelativeStats {
  /** Annual return minus the benchmark's, compounded each. */
  excess:         number | null;
  /** The same in each half of the years. */
  first:          number | null;
  second:         number | null;
  /** Annualised standard deviation of the monthly difference. */
  trackingError:  number | null;
  /** Mean monthly difference over its standard deviation, annualised. */
  infoRatio:      number | null;
  /** Calendar years ahead, of all. */
  yearsAhead:     number;
  years:          number;
  /** The worst twelve months against it. */
  worst12m:       number | null;
}

export interface PortfolioRun extends PathStats {
  signal:   PortfolioSignal;
  size:     number;
  every:    number;
  /** Share of the portfolio replaced at a rebalancing, on average. */
  turnover: number;
  /** What the costs took, per year. */
  costDrag: number;
  /** Against each benchmark, and against the equal-weighted universe. */
  vs:       Record<string, RelativeStats>;
  /** Calendar-year returns. */
  yearly:   { year: number; ret: number }[];
}

export interface PortfolioStudy {
  from:       string;
  to:         string;
  costPerSide: number;
  benchmarks: (PathStats & { key: string; label: string; yearly: { year: number; ret: number }[] })[];
  universe:   PathStats & { yearly: { year: number; ret: number }[] };
  runs:       PortfolioRun[];
  /** Month-end wealth from 1, for the rule's portfolios and what they are set against. */
  paths:      { key: string; label: string; points: { day: string; value: number }[] }[];
  /** The rule's two verdicts. */
  verdicts:   { key: string; claim: string; holds: boolean | null }[];
}

/** Index of the last close at or before `day`, or −1. */
function at(closes: readonly Close[], day: string): number {
  let lo = 0, hi = closes.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return m === null || xs.length < 2 ? null : Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/** A month-end path of returns: its compound annual return, its volatility and its deepest fall. */
function pathStats(rets: number[]): PathStats {
  if (!rets.length) return { cagr: null, vol: null, maxDrawdown: null };
  let w = 1, peak = 1, dd = 0;
  for (const r of rets) {
    w *= 1 + r;
    peak = Math.max(peak, w);
    dd = Math.min(dd, w / peak - 1);
  }
  const s = sd(rets);
  return { cagr: w ** (12 / rets.length) - 1, vol: s === null ? null : s * Math.sqrt(12), maxDrawdown: dd };
}

function yearly(days: readonly string[], rets: number[]): { year: number; ret: number }[] {
  const by = new Map<number, number>();
  rets.forEach((r, k) => {
    const y = Number(days[k].slice(0, 4));
    by.set(y, (by.get(y) ?? 1) * (1 + r));
  });
  return [...by].map(([year, g]) => ({ year, ret: g - 1 }));
}

function relative(days: readonly string[], a: number[], b: number[]): RelativeStats {
  const cagr = (xs: number[]) => pathStats(xs).cagr;
  const part = (keep: (d: string) => boolean) => {
    const ia = a.filter((_, k) => keep(days[k])), ib = b.filter((_, k) => keep(days[k]));
    const ca = cagr(ia), cb = cagr(ib);
    return ca === null || cb === null ? null : ca - cb;
  };
  const diff = a.map((x, k) => x - b[k]);
  const te = sd(diff);
  const m = mean(diff);
  const ya = yearly(days, a), yb = yearly(days, b);
  let worst: number | null = null;
  for (let k = 11; k < a.length; k++) {
    let ga = 1, gb = 1;
    for (let j = k - 11; j <= k; j++) { ga *= 1 + a[j]; gb *= 1 + b[j]; }
    worst = worst === null ? ga - gb : Math.min(worst, ga - gb);
  }
  return {
    excess: part(() => true), first: part((d) => d < HALF), second: part((d) => d >= HALF),
    trackingError: te === null ? null : te * Math.sqrt(12),
    infoRatio: te && m !== null ? (m * 12) / (te * Math.sqrt(12)) : null,
    yearsAhead: ya.filter((y, k) => y.ret > yb[k].ret).length, years: ya.length,
    worst12m: worst,
  };
}

/**
 * The portfolios. `calendar` is the month-ends a period can end on — formation
 * days and the ones after the last; `benchmarks` the index funds' closes.
 */
export function portfolioStudy(input: {
  records:    readonly PortfolioRecord[];
  prices:     ReadonlyMap<string, Close[]>;
  calendar:   readonly string[];
  benchmarks: ReadonlyMap<string, Close[]>;
}): PortfolioStudy {
  const { records, prices, benchmarks } = input;
  const byDay = new Map<string, PortfolioRecord[]>();
  for (const r of records) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const formations = [...byDay.keys()].sort();
  const first = formations[0];
  // Month-ends from the first formation on: where every path is marked.
  const marks = input.calendar.filter((d) => d >= first);
  const valueAt = (closes: readonly Close[] | undefined, day: string) => {
    if (!closes) return null;
    const i = at(closes, day);
    return i >= 0 ? closes[i].close : null;
  };
  // Every path is a list of monthly returns over `marks`, the first mark its start.
  const monthly = marks.slice(1);

  const benchPaths = PORTFOLIO_BENCHMARKS.map((b) => {
    const closes = benchmarks.get(b.key);
    const rets = monthly.map((d, k) => {
      const v0 = valueAt(closes, marks[k]), v1 = valueAt(closes, d);
      return v0 && v1 ? v1 / v0 - 1 : 0;
    });
    return { ...b, rets };
  });

  // The equal-weighted universe, rebalanced monthly: the crowd the rest of the backtest reads against.
  const universeRets = monthly.map((d, k) => {
    const rs = (byDay.get(marks[k]) ?? []).flatMap((r) => {
      const px = prices.get(r.symbol);
      const v0 = valueAt(px, marks[k]), v1 = valueAt(px, d);
      return v0 && v1 ? [v1 / v0 - 1] : [];
    });
    return mean(rs) ?? 0;
  });

  const runs: PortfolioRun[] = [];
  const paths: PortfolioStudy['paths'] = [];
  // Each run's monthly returns, for comparing two runs; the result keeps only their statistics.
  const monthlyOf = new Map<string, number[]>();
  const runKey = (signal: string, size: number, every: number) => `${signal}:${size}:${every}`;
  for (const [si, sig] of PORTFOLIO_SIGNALS.entries()) {
    for (const rule of PORTFOLIO_RULES) {
      const rets: number[] = [];
      let held: string[] = [];
      const turnovers: number[] = [];
      let costs = 0;
      // The holding period's names, their entry closes, what the trades cost, and the value at the last mark.
      let entry: { names: string[]; base: Map<string, number>; kept: number; last: number } | null = null;
      marks.forEach((day, k) => {
        if (k > 0 && entry) {
          // Mark the holdings: equal parts at entry, drifting since.
          const rel = entry.names.map((s) => {
            const v = valueAt(prices.get(s), day);
            return v !== null ? v / entry!.base.get(s)! : 1;
          });
          const value = (mean(rel) ?? 1) * entry.kept;
          rets.push(value / entry.last - 1);
          entry.last = value;
        }
        const f = formations.indexOf(day);
        if (f < 0 || f % rule.every !== 0) return;
        const ranked = (byDay.get(day) ?? [])
          .filter((r) => Number.isFinite(r.values[si]) && valueAt(prices.get(r.symbol), day))
          .sort((a, b) => b.values[si] - a.values[si] || a.symbol.localeCompare(b.symbol))
          .slice(0, rule.size);
        const names = ranked.map((r) => r.symbol);
        const kept = names.filter((s) => held.includes(s)).length;
        const replaced = (names.length - kept) / Math.max(1, names.length);
        // Selling the old names and buying the new ones, each at its weight.
        const charge = COST_PER_SIDE * (held.length ? 2 * replaced : 1);
        if (held.length) turnovers.push(replaced);
        costs += charge;
        held = names;
        entry = {
          names, kept: 1 - charge, last: 1,
          base: new Map(names.map((s) => [s, valueAt(prices.get(s), day)!])),
        };
      });
      monthlyOf.set(runKey(sig.key, rule.size, rule.every), rets);
      const years = rets.length / 12;
      const stats = pathStats(rets);
      runs.push({
        signal: sig.key, size: rule.size, every: rule.every, ...stats,
        turnover: mean(turnovers) ?? 0,
        costDrag: years > 0 ? costs / years : 0,
        vs: Object.fromEntries([
          ...benchPaths.map((b) => [b.key, relative(monthly, rets, b.rets)] as const),
          ['universe', relative(monthly, rets, universeRets)] as const,
        ]),
        yearly: yearly(monthly, rets),
      });
      if (rule === PORTFOLIO_RULES[0]) paths.push({ key: sig.key, label: `${sig.label}, ${rule.size} Aktien, alle ${rule.every} Monate`, points: wealth(marks, rets) });
    }
  }
  for (const b of benchPaths) paths.push({ key: b.key, label: b.label, points: wealth(marks, b.rets) });
  paths.push({ key: 'universe', label: 'Durchschnittsaktie (gleichgewichtet)', points: wealth(marks, universeRets) });

  const { size, every } = PORTFOLIO_RULES[0];
  const judged = (signal: PortfolioSignal) => runs.find((r) => r.signal === signal && r.size === size && r.every === every)!;
  const ahead = (x: number | null, y: number | null) => (x === null || y === null ? null : x > 0 && y > 0);
  const score = judged('score'), qm = judged('quality-momentum');
  const qmVsScore = relative(monthly, monthlyOf.get(runKey('quality-momentum', size, every))!, monthlyOf.get(runKey('score', size, every))!);
  return {
    from: first, to: marks[marks.length - 1], costPerSide: COST_PER_SIDE,
    benchmarks: benchPaths.map((b) => ({ key: b.key, label: b.label, ...pathStats(b.rets), yearly: yearly(monthly, b.rets) })),
    universe: { ...pathStats(universeRets), yearly: yearly(monthly, universeRets) },
    runs, paths,
    verdicts: [
      { key: 'score-vs-index', claim: 'Der Faktor-Score schlägt den MSCI World nach Kosten in beiden Hälften der Jahre (25 Aktien, quartalsweise).',
        holds: ahead(score.vs[RULE_BENCHMARK].first, score.vs[RULE_BENCHMARK].second) },
      { key: 'qm-vs-index', claim: 'Qualität + Momentum schlägt den MSCI World nach Kosten in beiden Hälften der Jahre (25 Aktien, quartalsweise).',
        holds: ahead(qm.vs[RULE_BENCHMARK].first, qm.vs[RULE_BENCHMARK].second) },
      { key: 'qm-vs-score', claim: 'Qualität + Momentum schlägt den Faktor-Score in beiden Hälften der Jahre (25 Aktien, quartalsweise).',
        holds: ahead(qmVsScore.first, qmVsScore.second) },
    ],
  };
}

/** Month-end wealth from 1. */
function wealth(marks: readonly string[], rets: number[]): { day: string; value: number }[] {
  let w = 1;
  return [{ day: marks[0], value: 1 }, ...rets.map((r, k) => ({ day: marks[k + 1], value: (w *= 1 + r) }))];
}
