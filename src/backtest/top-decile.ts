/**
 * What the top tenth of the score is made of, and which of it falls back.
 *
 * The top tenth trailed the ninth over three and six months in every variant
 * of the conviction stretch (`variants.ts`), so it is the stocks that rank
 * highest, not what the stretch calls them. Two questions, asked of the same
 * company-months the backtest scored:
 *
 *   1. The profile: how the top tenth differs from the ninth and from the rest
 *      at the moment it was formed — its pillars, how far it had already run,
 *      what it cost, how large it was, what the analysts promised, how much the
 *      pillars agreed.
 *   2. The split: inside the top tenth each month, the stocks above its own
 *      median of a feature against those below it — which half did the
 *      falling back. The same split in the ninth tenth says whether a
 *      difference belongs to the top or to the feature everywhere.
 *
 * Twenty features at three horizons is sixty chances for noise to look like a
 * finding, so each split is read in both halves of the years too (2013–2019,
 * 2020–2026): a candidate for a rule is one that points the same way in both.
 * Returns are each month's, held to its own 2.5th and 97.5th percentiles and
 * read against the month's average stock, as the bands are.
 */

import { meanTest, type Close } from '../analysis/evaluate.js';

/**
 * One scored company at one month-end, with what it looked like then: the
 * features in `TOP_FEATURES` order, NaN where there was no reading. An array
 * rather than an object a feature, because there are a hundred and fifty
 * thousand of them.
 */
export interface TopRecord {
  day:      string;
  symbol:   string;
  segment:  string;
  sector:   string;
  score:    number;
  features: Float64Array;
}

/** The features of a record, in order, from readings by key. */
export function featureArray(values: Record<string, number | null | undefined>): Float64Array {
  return Float64Array.from(TOP_FEATURES, (f) => {
    const v = values[f.key];
    return v !== null && v !== undefined && Number.isFinite(v) ? v : NaN;
  });
}

export const TOP_FEATURES: readonly { key: string; label: string }[] = [
  { key: 'mom12',      label: '12-Monats-Rendite' },
  { key: 'mom3',       label: '3-Monats-Rendite' },
  { key: 'nearHigh',   label: 'Nähe zum 52-Wochen-Hoch' },
  { key: 'size',       label: 'Börsenwert' },
  { key: 'ps',         label: 'Kurs-Umsatz-Verhältnis' },
  { key: 'pe',         label: 'KGV' },
  { key: 'upside',     label: 'Kursziel-Potenzial' },
  { key: 'growth',     label: 'Umsatzwachstum' },
  { key: 'beta',       label: 'Beta' },
  { key: 'agreement',  label: 'Einigkeit der Säulen' },
  { key: 'confidence', label: 'Konfidenz' },
  { key: 'pillar.valuation', label: 'Säule Bewertung' },
  { key: 'pillar.quality',   label: 'Säule Qualität' },
  { key: 'pillar.health',    label: 'Säule Bilanz & Risiko' },
  { key: 'pillar.consensus', label: 'Säule Analystenkonsens' },
  { key: 'pillar.momentum',  label: 'Säule Markt & Momentum' },
  { key: 'pillar.revisions', label: 'Säule Erwartungen' },
];

const GROUPS = ['D1', 'D2–D8', 'D9', 'D10'] as const;
export const TOP_HORIZONS = [1, 3, 6] as const;
const HALF = '2020-01-01';
const WINSOR = 0.025;
/** Fewer stocks than this on either side of a month's split and the month says nothing about it. */
const MIN_SIDE = 3;

export interface GroupProfile {
  group:    (typeof GROUPS)[number];
  n:        number;
  /** Each feature's median over the group's company-months. */
  medians:  Record<string, number | null>;
  /** Share of the group's company-months in each index. */
  segments: Record<string, number>;
  /** The three sectors it held most of, with their shares. */
  sectors:  { sector: string; share: number }[];
}

export interface SplitStat { mean: number | null; t: number | null; months: number }

export interface TopSplit {
  feature: string;
  label:   string;
  horizon: number;
  /** Inside the top tenth: the half above the month's median of the feature, the half below, and above minus below. */
  high:    SplitStat;
  low:     SplitStat;
  diff:    SplitStat;
  /** Above minus below in each half of the years. */
  first:   SplitStat;
  second:  SplitStat;
  /** Above minus below inside the ninth tenth, for comparison. */
  ninth:   SplitStat;
}

export interface TopDecileStudy {
  profiles: GroupProfile[];
  splits:   TopSplit[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stat = (xs: number[]): SplitStat => ({
  mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, t: meanTest(xs).t, months: xs.length,
});

/** Index of the last close at or before `day`, or −1. */
function at(closes: readonly Close[], day: string): number {
  let lo = 0, hi = closes.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function topDecileStudy(
  records: readonly TopRecord[], prices: ReadonlyMap<string, Close[]>, monthEnds: readonly string[],
): TopDecileStudy {
  const byDay = new Map<string, TopRecord[]>();
  for (const r of records) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const days = [...byDay.keys()].sort();

  // Each month's tenths by score, as the bands rank them.
  const group = new Map<TopRecord, (typeof GROUPS)[number]>();
  const decile = new Map<TopRecord, number>();
  for (const day of days) {
    const rs = [...byDay.get(day)!].sort((a, b) => a.score - b.score);
    rs.forEach((r, k) => {
      const d = Math.min(10, Math.floor((k * 10) / rs.length) + 1);
      decile.set(r, d);
      group.set(r, d === 1 ? 'D1' : d === 10 ? 'D10' : d === 9 ? 'D9' : 'D2–D8');
    });
  }

  const profiles: GroupProfile[] = GROUPS.map((g) => {
    const rs = records.filter((r) => group.get(r) === g);
    const count = (key: (r: TopRecord) => string) => {
      const m = new Map<string, number>();
      for (const r of rs) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return m;
    };
    const sectors = [...count((r) => r.sector)].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([sector, n]) => ({ sector, share: n / rs.length }));
    return {
      group: g, n: rs.length,
      medians: Object.fromEntries(TOP_FEATURES.map((f, i) => [f.key, median(rs.flatMap((r) => {
        const v = r.features[i];
        return Number.isFinite(v) ? [v] : [];
      }))])),
      segments: Object.fromEntries([...count((r) => r.segment)].map(([k, n]) => [k, n / rs.length])),
      sectors,
    };
  });

  const splits: TopSplit[] = [];
  for (const h of TOP_HORIZONS) {
    // Each month's winsorised excess return for every scored stock.
    const excess = new Map<TopRecord, number>();
    days.forEach((day) => {
      const i = monthEnds.indexOf(day);
      if (i < 0 || i + h >= monthEnds.length) return;
      const exit = monthEnds[i + h];
      const rs = byDay.get(day)!.flatMap((r) => {
        const px = prices.get(r.symbol);
        if (!px) return [];
        const a = at(px, day), b = at(px, exit);
        return a >= 0 && b > a ? [{ r, ret: px[b].close / px[a].close - 1 }] : [];
      });
      if (rs.length < 30) return;
      const sorted = rs.map((x) => x.ret).sort((a, b) => a - b);
      const lo = sorted[Math.floor(WINSOR * (sorted.length - 1))], hi = sorted[Math.ceil((1 - WINSOR) * (sorted.length - 1))];
      const clipped = rs.map((x) => ({ r: x.r, ret: Math.min(hi, Math.max(lo, x.ret)) }));
      const avg = clipped.reduce((s, x) => s + x.ret, 0) / clipped.length;
      for (const x of clipped) excess.set(x.r, x.ret - avg);
    });

    for (const [i, f] of TOP_FEATURES.entries()) {
      const highs: number[] = [], lows: number[] = [], diffs: number[] = [], first: number[] = [], second: number[] = [], ninth: number[] = [];
      for (const day of days) {
        const month = byDay.get(day)!;
        // Split at the tenth's own median that month: the question is which
        // half of the top falls back, and a feature the whole top sits high
        // on — the pillars' agreement — would leave the lower half empty.
        const side = (d: number) => {
          const inside = month.filter((r) => decile.get(r) === d && excess.has(r) && Number.isFinite(r.features[i]));
          const cut = median(inside.map((r) => r.features[i]));
          if (cut === null) return null;
          const up = inside.filter((r) => r.features[i] > cut).map((r) => excess.get(r)!);
          const down = inside.filter((r) => r.features[i] <= cut).map((r) => excess.get(r)!);
          if (up.length < MIN_SIDE || down.length < MIN_SIDE) return null;
          const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
          return { up: m(up), down: m(down) };
        };
        const top = side(10);
        if (top) {
          highs.push(top.up);
          lows.push(top.down);
          diffs.push(top.up - top.down);
          (day < HALF ? first : second).push(top.up - top.down);
        }
        const nine = side(9);
        if (nine) ninth.push(nine.up - nine.down);
      }
      // Overlapping windows are not independent: every h-th month only, as the evaluation counts them.
      const every = (xs: number[]) => xs.filter((_, k) => k % h === 0);
      splits.push({
        feature: f.key, label: f.label, horizon: h,
        high: stat(every(highs)), low: stat(every(lows)), diff: stat(every(diffs)),
        first: stat(every(first)), second: stat(every(second)), ninth: stat(every(ninth)),
      });
    }
  }
  return { profiles, splits };
}
