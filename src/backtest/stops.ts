/**
 * Do the depot check's stops protect a position, and what do they cost? And do
 * its two lists pick the right half — reduce the weak stock whose chart falls,
 * look at buying the strong one whose chart rises?
 *
 * A · The stops. At every month-end every scored stock is a position held, and
 * three exits are set beside holding it for three and six months, each with
 * the levels the depot check would have given that day (`analysis/stops.ts`):
 *
 *   - the stop under the support (or three daily moves under the close),
 *     fixed on the day it is set;
 *   - the trailing stop as a broker runs it: the width the check names, under
 *     the highest close since the order;
 *   - the chandelier the night watch reads: three daily moves under the
 *     22-day high, every day anew.
 *
 * A position stopped out is in cash for the rest of the window — the rule as
 * fixed. After the first run a second reading was added, shown and not
 * judged: the proceeds put into the index (SPY, dividends in) for the rest of
 * the window, so that what a stop costs is told apart from the market it
 * leaves. Daily closes
 * only, as in the setups: a stop is hit by a close at or under it and leaves
 * at that close, so a gap costs what it would, and the range inside a day is
 * not seen. Returns include dividends.
 *
 * What a stop does to the average is the test: its return minus holding's,
 * month by month, on every third (sixth) month so the windows do not overlap
 * — which is why the run reads the charts of every third month only.
 * What it does to the bad outcomes — the worst twentieth, the share of
 * positions that lost a fifth — is shown beside it, as the reason one sets a
 * stop at all.
 *
 * B · The lists. Among the stocks scored under the reduce bar, the half whose
 * chart trend read down is set against the rest, in excess returns over the
 * month's average stock; among the buys, the half whose chart read up. The
 * chart is the deterministic reading (`trendAnswer`), the one the night watch
 * uses — the depot check's model reading has no history.
 *
 * The rule for both was fixed before the first run, as for the timing and the
 * setups: |t| of at least 2 over the months, and the same sign in both halves
 * of the years.
 */

import type { Close } from '../analysis/evaluate.js';
import {
  STOP_GROUPS, STOP_HORIZONS, STOP_MIN_T, STOP_RULES, WEAK_SCORE, WINNER_MOM,
  type ListRuleRow, type StopGroupKey, type StopRecord, type StopRow, type StopRuleKey, type StopStudy,
} from '../analysis/stop-study.js';
import { indexAtOrBefore, type PriceHistory } from './prices.js';
import { HALF, monthlyExcess, splitStat } from './top-decile.js';

export * from '../analysis/stop-study.js';

/** A loss this deep is the bad outcome a stop is set against. */
const DEEP_LOSS = -0.2;
const MIN_SIDE = 3;
const MIN_TRADES = 10;
const SESSIONS_PER_MONTH = 21;
const CHANDELIER_ATR = 3;
const CHANDELIER_SESSIONS = 22;
const ATR_SESSIONS = 14;

const inGroup = (r: StopRecord, g: StopGroupKey) =>
  g === 'all' || (g === 'weak-falling' ? r.score < WEAK_SCORE && r.trend === -1
    : g === 'winners' ? r.mom12 !== null && r.mom12 > WINNER_MOM : r.group === g);


/**
 * Each session's chandelier level: the 22-day high less three ATR(14), from
 * split-adjusted bars — the close where a bar has no high or low (NaN or null).
 */
function chandelierSeries(px: PriceHistory): Float64Array {
  const atr = atrSeries(px);
  const out = new Float64Array(atr.length).fill(NaN);
  for (let k = 0; k < atr.length; k++) {
    if (!Number.isFinite(atr[k])) continue;
    let high = -Infinity;
    for (let j = Math.max(0, k - CHANDELIER_SESSIONS + 1); j <= k; j++) {
      const v = px.high?.[j];
      high = Math.max(high, v != null && Number.isFinite(v) ? v : px.close[j]);
    }
    out[k] = high - CHANDELIER_ATR * atr[k];
  }
  return out;
}

/** Each session's ATR(14) from split-adjusted bars; close-to-close where there are no highs and lows. */
function atrSeries(px: PriceHistory): Float64Array {
  const n = px.close.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  const tr = new Float64Array(n);
  const at = (xs: (number | null)[] | undefined, k: number) => {
    const v = xs?.[k];
    return v != null && Number.isFinite(v) ? v : px.close[k];
  };
  for (let k = 0; k < n; k++) {
    const h = at(px.high, k), l = at(px.low, k);
    const prev = k > 0 ? px.close[k - 1] : null;
    tr[k] = prev === null ? h - l : Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
    sum += tr[k];
    if (k >= ATR_SESSIONS) sum -= tr[k - ATR_SESSIONS];
    if (k >= ATR_SESSIONS - 1) out[k] = sum / ATR_SESSIONS;
  }
  return out;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** One position walked under each rule: its return, and the sessions until it left, where it left early. */
export function walkPosition(r: StopRecord, px: PriceHistory, chandelier: Float64Array, sessions: number) {
  const end = r.i + sessions;
  if (end >= px.close.length) return null;
  const ret = (k: number) => px.adj[k] / px.adj[r.i] - 1;
  const hold = ret(end);
  const out: Record<StopRuleKey, { ret: number; left: number | null } | null> = { stop: null, trailing: null, chandelier: null };

  if (r.stop !== null) {
    let left: number | null = null;
    for (let k = r.i + 1; k <= end; k++) if (px.close[k] <= r.stop) { left = k; break; }
    out.stop = { ret: left === null ? hold : ret(left), left: left === null ? null : left - r.i };
  }
  if (r.width !== null) {
    let peak = px.close[r.i], left: number | null = null;
    for (let k = r.i + 1; k <= end; k++) {
      if (px.close[k] <= peak * (1 - r.width)) { left = k; break; }
      peak = Math.max(peak, px.close[k]);
    }
    out.trailing = { ret: left === null ? hold : ret(left), left: left === null ? null : left - r.i };
  }
  {
    let left: number | null = null;
    for (let k = r.i + 1; k <= end; k++) if (Number.isFinite(chandelier[k]) && px.close[k] < chandelier[k]) { left = k; break; }
    out.chandelier = { ret: left === null ? hold : ret(left), left: left === null ? null : left - r.i };
  }
  return { hold, out };
}

export function stopStudy(
  records: readonly StopRecord[], histories: ReadonlyMap<string, PriceHistory>,
  closes: ReadonlyMap<string, Close[]>, monthEnds: readonly string[], index: PriceHistory | null = null,
): StopStudy {
  // The index from one day to another, for the proceeds of a stop.
  const indexReturn = (from: string, to: string) => {
    if (!index) return null;
    const a = indexAtOrBefore(index.dates, from), b = indexAtOrBefore(index.dates, to);
    return a >= 0 && b >= a ? index.adj[b] / index.adj[a] - 1 : null;
  };
  const days = [...new Set(records.map((r) => r.day))].sort();
  // Months counted on the calendar, so "every third" holds whichever month-ends the records come from.
  const monthOf = new Map(monthEnds.map((d, k) => [d, k]));
  const levels = new Map<string, Float64Array>();
  const levelsOf = (symbol: string, px: PriceHistory) => levels.get(symbol) ?? levels.set(symbol, chandelierSeries(px)).get(symbol)!;

  const rows: StopRow[] = [];
  for (const h of STOP_HORIZONS) {
    // Every position walked once per horizon; the groups pick from the same walks.
    const walks = records.flatMap((r) => {
      const px = histories.get(r.symbol);
      const sessions = h * SESSIONS_PER_MONTH;
      const w = px ? walkPosition(r, px, levelsOf(r.symbol, px), sessions) : null;
      if (!w || !px) return [];
      // The same exits with the proceeds in the index until the window ends.
      const viaIndex = Object.fromEntries(STOP_RULES.map(({ key }) => {
        const o = w.out[key];
        if (!o) return [key, null];
        if (o.left === null) return [key, o.ret];
        const rest = indexReturn(px.dates[r.i + o.left], px.dates[r.i + sessions]);
        return [key, rest === null ? null : (1 + o.ret) * (1 + rest) - 1];
      })) as Record<StopRuleKey, number | null>;
      return [{ r, ...w, viaIndex }];
    });
    for (const rule of STOP_RULES) {
      for (const g of STOP_GROUPS) {
        const mine = walks.filter((w) => inGroup(w.r, g.key) && w.out[rule.key] !== null);
        const byMonth = new Map<number, number[]>();
        const byMonthIndex = new Map<number, number[]>();
        for (const w of mine) {
          const m = monthOf.get(w.r.day);
          if (m === undefined || m % h !== 0) continue;
          (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(w.out[rule.key]!.ret - w.hold);
          const vi = w.viaIndex[rule.key];
          if (vi !== null) (byMonthIndex.get(m) ?? byMonthIndex.set(m, []).get(m)!).push(vi - w.hold);
        }
        const monthly = (xs: Map<number, number[]>) => [...xs].sort((a, b) => a[0] - b[0])
          .filter(([, v]) => v.length >= MIN_TRADES).map(([, v]) => v.reduce((a, x) => a + x, 0) / v.length);
        const all: number[] = [], first: number[] = [], second: number[] = [];
        for (const [m, xs] of [...byMonth].sort((a, b) => a[0] - b[0])) {
          if (xs.length < MIN_TRADES) continue;
          const d = xs.reduce((a, x) => a + x, 0) / xs.length;
          all.push(d);
          (monthEnds[m] < HALF ? first : second).push(d);
        }
        const diff = splitStat(all), a = splitStat(first), b = splitStat(second);
        const both = (sign: number) => Math.sign(a.mean ?? 0) === sign && Math.sign(b.mean ?? 0) === sign;
        const t = diff.t ?? 0;
        const holds = mine.map((w) => w.hold), ruled = mine.map((w) => w.out[rule.key]!.ret);
        const ruledIndex = mine.flatMap((w) => (w.viaIndex[rule.key] !== null ? [w.viaIndex[rule.key]!] : []));
        const left = mine.flatMap((w) => (w.out[rule.key]!.left !== null ? [w.out[rule.key]!.left!] : []));
        const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
        rows.push({
          rule: rule.key, group: g.key, horizon: h, trades: mine.length,
          stopped: mine.length ? left.length / mine.length : 0, sessions: mean(left),
          hold: mean(holds), ruled: mean(ruled),
          p05Hold: quantile(holds, 0.05), p05Rule: quantile(ruled, 0.05),
          deepHold: mine.length ? holds.filter((x) => x <= DEEP_LOSS).length / mine.length : 0,
          deepRule: mine.length ? ruled.filter((x) => x <= DEEP_LOSS).length / mine.length : 0,
          diff, first: a, second: b,
          ...(index ? { diffIndex: splitStat(monthly(byMonthIndex)), ruledIndex: mean(ruledIndex) } : {}),
          verdict: t >= STOP_MIN_T && both(1) ? 'bringt mehr' : t <= -STOP_MIN_T && both(-1) ? 'kostet' : 'nicht belegt',
        });
      }
    }
  }

  // B · the lists, against the month's average stock.
  const byDay = new Map<string, StopRecord[]>();
  for (const r of records) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(r);
  const lists: ListRuleRow[] = [];
  for (const h of [1, 3, 6] as const) {
    const excess = monthlyExcess(byDay, closes, monthEnds, h);
    for (const rule of ['reduce', 'buy'] as const) {
      const among = (r: StopRecord) => (rule === 'reduce' ? r.score < WEAK_SCORE : r.group === 'buy');
      const picks = (r: StopRecord) => (rule === 'reduce' ? r.trend === -1 : r.trend === 1);
      const chosen: number[] = [], rest: number[] = [], diffs: number[] = [], first: number[] = [], second: number[] = [];
      days.forEach((day) => {
        const k = monthOf.get(day);
        if (k === undefined || k % h !== 0) return;
        const inside = byDay.get(day)!.filter((r) => among(r) && excess.has(r));
        const a = inside.filter(picks).map((r) => excess.get(r)!), b = inside.filter((r) => !picks(r)).map((r) => excess.get(r)!);
        if (a.length < MIN_SIDE || b.length < MIN_SIDE) return;
        const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
        chosen.push(m(a)); rest.push(m(b)); diffs.push(m(a) - m(b));
        (day < HALF ? first : second).push(m(a) - m(b));
      });
      const diff = splitStat(diffs), x = splitStat(first), y = splitStat(second);
      // The direction that makes the rule right: the reduce half lags, the buy half leads.
      const right = rule === 'reduce' ? -1 : 1;
      const t = (diff.t ?? 0) * right;
      const both = (sign: number) => Math.sign(x.mean ?? 0) === sign * right && Math.sign(y.mean ?? 0) === sign * right;
      lists.push({
        rule, horizon: h, chosen: splitStat(chosen), rest: splitStat(rest), diff, first: x, second: y,
        verdict: t >= STOP_MIN_T && both(1) ? 'trägt' : t <= -STOP_MIN_T && both(-1) ? 'falsch herum' : 'nicht belegt',
      });
    }
  }

  return {
    records: records.length,
    withStop: records.filter((r) => r.stop !== null).length,
    withWidth: records.filter((r) => r.width !== null).length,
    rows, lists,
  };
}
