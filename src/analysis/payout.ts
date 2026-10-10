/**
 * What a company hands its shareholders: the dividend, and the shares it buys
 * back or issues beside it.
 *
 * The score reads the share count already (`netIssuance`, Pontiff and Woodgate
 * 2008). The dividend it reads only inside the dividend model's fair value —
 * no criterion asks whether the stocks paying the most went on to do better.
 * The literature is mixed: a high yield alone has predicted little once value
 * is controlled for, and the net payout including buybacks has done better
 * (Boudoukh, Michaely, Richardson and Roberts 2007). So the yields are measured
 * as candidates in the backtest before anyone proposes a weight for them.
 *
 * The rule a candidate must pass, fixed before the first run: the rank IC over
 * one month, within sectors — a utility's yield and a software company's are
 * not one scale — at |t| ≥ 2 over all months, and with the same sign in both
 * halves of them (`backtest/run.ts`, `candidateHalves`).
 *
 * Pure and dependency-free: the web app reads the titles.
 */

import type { DividendRecord, StockFinancials } from '../types.js';

const finite = (v: number | null | undefined): number | null =>
  v !== null && v !== undefined && Number.isFinite(v) ? v : null;

/** Change in the share count over the last fiscal year: negative is buybacks, positive dilution. */
export function netIssuance(f: Pick<StockFinancials, 'sharesOutstandingAnnual' | 'prevYear'>): number | null {
  const now = finite(f.sharesOutstandingAnnual);
  const before = finite(f.prevYear?.sharesOutstanding);
  return now !== null && before !== null && before > 0 ? now / before - 1 : null;
}

/**
 * The signals the backtest measures. A firm without a dividend on record yields
 * nothing, so it ranks at 0 in the first and is left out of the second: the
 * first asks whether payers beat the rest, the second whether the higher
 * payers beat the lower.
 */
export const PAYOUT_CANDIDATES: readonly {
  key: string; title: string; read: (f: StockFinancials) => number | null;
}[] = [
  { key: 'payout.dividend-yield', title: 'Dividendenrendite (ohne Dividende = 0)', read: (f) => finite(f.dividendYield) ?? 0 },
  {
    key: 'payout.dividend-yield-payers', title: 'Dividendenrendite, nur Zahler',
    read: (f) => { const dy = finite(f.dividendYield); return dy !== null && dy > 0 ? dy : null; },
  },
  {
    key: 'payout.shareholder-yield', title: 'Ausschüttungsrendite (Dividende + Rückkäufe)',
    read: (f) => { const n = netIssuance(f); return n === null ? null : (finite(f.dividendYield) ?? 0) - n; },
  },
];

// ── How long the dividend has been raised ───────────────────────────────────
//
// "Raised for 22 years in a row" is the one line a dividend page always has,
// and the one the trailing yield and its five-year growth rate cannot say: a
// cut three years ago is inside a five-year average and invisible in it.
//
// Counted in calendar years of the ex-date, on the regular dividend: the sum of
// a year's payments against the year before's. What breaks a plain sum:
//
// - A special dividend — Costco's $15 beside a regular $1.16 — makes its year
//   look raised and the next one cut. A payment several times the regular ones
//   before it, and the ones after it if there are any, is set aside.
// - Yahoo's older history lists things that are not the dividend: Coca-Cola's
//   September 2001 payment twice, once at double the amount; a $0.01 entry
//   between two of Exxon's $0.22; P&G's 2002 spin-off of Jif and Crisco as a
//   $0.345 dividend. Each leaves its year with a payment more than the years
//   around it, so in such a year the payment furthest from the year's others
//   is set aside, when it is more than a third off them.
// - A payment that slips across New Year leaves five in one year and three in
//   the next. When two years differ in count, their average payments are
//   compared instead of their sums.
//
// A cut is dated by the payment, not the year: the first regular payment below
// its counterpart a year earlier. A cut in May shows in the sums of that year
// and the next, and the sums would date it a year late; payments in the year
// after a cut are measured against the payments before it and say nothing new,
// so they do not count as a second one.
//
// The amounts are Yahoo's, split-adjusted and in the currency of the quote. A
// dividend declared in another currency — Shell's dollars paid in pence on the
// London line, Novo's kroner on the ADR — moves with the rate, and a weaker
// rate reads as a cut the company never made. Where the reporting currency is
// not the quote's, only the years paid are counted.

/** A payment this many times the regular ones before it (and after it, where there are any) is special. */
const SPECIAL_MULTIPLE = 2.5;
/** The payments a special one is measured against: two years either side. */
const SPECIAL_WINDOW_DAYS = 730;
/** In a year with a payment too many, the odd one out is set aside when it is this far off the payments around it. */
const STRAY_DISTANCE = 1 / 3;
/** The years whose payment counts say how many a year usually has: five either side. */
const TYPICAL_COUNT_YEARS = 5;
/** A year's dividend this little above the year before's is the same dividend, rounded differently after a split. */
const SAME = 0.001;
/**
 * A payment this little below its counterpart is not a cut: Yahoo's oldest
 * split-adjusted amounts wobble by a fraction of a percent (Realty Income's
 * 1996, −0.65 %), and no company cuts its dividend by less than one.
 */
const CUT_TOLERANCE = 0.01;
/**
 * A dividend record that starts within this many years of the price history
 * may have started before it — Yahoo's German listings begin in 2000 and
 * Coca-Cola's dividends in 1962. One that starts later began then: Microsoft's
 * first dividend in 2003, with prices from 1986.
 */
const RECORD_START_YEARS = 4;
/** A payment's counterpart a year earlier is the one nearest the anniversary, within this many days. */
const ANNIVERSARY_DAYS = 75;

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const yearOf = (day: string) => Number(day.slice(0, 4));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Payment { day: string; amount: number; t: number }

/** Specials: several times the payments before them, and the ones after them where there are any. */
function isSpecial(p: Payment, all: Payment[]): boolean {
  const near = (from: number, to: number) => all.filter((q) => q !== p && q.t >= from && q.t <= to).map((q) => q.amount);
  const before = near(p.t - SPECIAL_WINDOW_DAYS * DAY_MS, p.t - 1);
  const after = near(p.t + 1, p.t + SPECIAL_WINDOW_DAYS * DAY_MS);
  return before.length > 0 && p.amount > SPECIAL_MULTIPLE * median(before)
    && (after.length === 0 || p.amount > SPECIAL_MULTIPLE * median(after));
}

/**
 * In each year with more payments than the years around it, the ones furthest
 * off the others — as many as it has too many, and only those more than a
 * third off. "The others" are the rest of that year and the years either side:
 * with two payments in a year, its own median sits halfway and cannot tell
 * Siemens' €1.60 of 2010 from the €0.51 Yahoo lists beside it. A year that is
 * merely crowded by a payment slipping across New Year has its payments close
 * together and loses none.
 */
function strays(payments: Payment[]): Set<Payment> {
  const byYear = new Map<number, Payment[]>();
  for (const p of payments) byYear.set(yearOf(p.day), [...(byYear.get(yearOf(p.day)) ?? []), p]);
  const years = [...byYear.keys()].sort((a, b) => a - b);
  // The first and last years on record are often partial and say nothing about a usual count.
  const inner = new Set(years.slice(1, -1));
  const out = new Set<Payment>();
  for (const [y, list] of byYear) {
    const around = years.filter((x) => x !== y && inner.has(x) && Math.abs(x - y) <= TYPICAL_COUNT_YEARS)
      .map((x) => byYear.get(x)!.length);
    if (around.length === 0) continue;
    const extra = list.length - Math.round(median(around));
    if (extra <= 0) continue;
    const nearby = [y - 1, y, y + 1].flatMap((x) => byYear.get(x) ?? []);
    list
      .map((p) => ({ p, off: Math.abs(p.amount / median(nearby.filter((q) => q !== p).map((q) => q.amount)) - 1) }))
      .filter((x) => x.off > STRAY_DISTANCE)
      .sort((a, b) => b.off - a.off)
      .slice(0, extra)
      .forEach((x) => out.add(x.p));
  }
  return out;
}

/**
 * The dividend year by year and its runs, from every payment on record —
 * `null` for a company that has never paid one.
 *
 * `today` decides which year is the last complete one: the runs count up to the
 * year before it, so a dividend not yet raised this year has not broken
 * anything. A cut this year has, and sets the raised run to nothing.
 * `convertedFrom` is the reporting currency where it is not the quote's;
 * `historyStart` the first day of the price history the payments came with.
 */
export function dividendRecord(
  payments: { day: string; amount: number }[], today: string,
  convertedFrom: string | null = null, historyStart: string | null = null,
): DividendRecord | null {
  const byDay = new Map<string, number>();
  for (const p of payments) {
    if (Number.isFinite(p.amount) && p.amount > 0) byDay.set(p.day, Math.max(byDay.get(p.day) ?? 0, p.amount));
  }
  const all: Payment[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount, t: dayMs(day) }));

  const specials = new Set(all.filter((p) => isSpecial(p, all)));
  const stray = strays(all.filter((p) => !specials.has(p)));
  const regular = all.filter((p) => !specials.has(p) && !stray.has(p));
  if (regular.length === 0) return null;

  // Cuts, each dated by the first payment below the one a year before it.
  const cuts: { day: string; from: number; to: number; t: number }[] = [];
  for (const p of regular) {
    const target = p.t - 365 * DAY_MS;
    let prior: Payment | null = null;
    for (const q of regular) {
      if (Math.abs(q.t - target) <= ANNIVERSARY_DAYS * DAY_MS && (!prior || Math.abs(q.t - target) < Math.abs(prior.t - target))) prior = q;
    }
    if (!prior || p.amount >= prior.amount * (1 - CUT_TOLERANCE)) continue;
    const priorT = prior.t;
    if (cuts.some((c) => c.t > priorT && c.t < p.t)) continue;   // still measuring against the time before that cut
    cuts.push({ day: p.day, from: prior.amount, to: p.amount, t: p.t });
  }

  const through = yearOf(today) - 1;
  const perYear = new Map<number, { amount: number; payments: number }>();
  for (const p of regular) {
    const y = yearOf(p.day);
    if (y > through) continue;
    const e = perYear.get(y) ?? { amount: 0, payments: 0 };
    e.amount += p.amount; e.payments += 1;
    perYear.set(y, e);
  }
  const years = [...perYear.entries()].sort(([a], [b]) => a - b).map(([year, e]) => ({ year, ...e }));
  const cutYears = new Set(cuts.map((c) => yearOf(c.day)));

  const raised = (y: number): boolean => {
    const cur = perYear.get(y), prev = perYear.get(y - 1);
    if (!cur || !prev || cutYears.has(y)) return false;
    const ratio = cur.payments === prev.payments
      ? cur.amount / prev.amount
      : (cur.amount / cur.payments) / (prev.amount / prev.payments);
    return ratio > 1 + SAME;
  };
  let raisedYears = 0;
  while (raised(through - raisedYears)) raisedYears++;
  if (cuts.some((c) => yearOf(c.day) > through)) raisedYears = 0;
  let paidYears = 0;
  while (perYear.has(through - paidYears)) paidYears++;

  const lastCut = cuts.length ? cuts[cuts.length - 1] : null;
  return {
    raisedYears: convertedFrom ? null : raisedYears,
    paidYears,
    fromStart: paidYears > 0 && years[0].year === through - paidYears + 1
      && (historyStart === null || years[0].year <= yearOf(historyStart) + RECORD_START_YEARS),
    through,
    lastCut: lastCut && !convertedFrom ? { day: lastCut.day, from: lastCut.from, to: lastCut.to } : null,
    lastPaid: regular[regular.length - 1].day,
    convertedFrom,
    years,
    setAside: all.filter((p) => specials.has(p) || stray.has(p)).map(({ day, amount }) => ({ day, amount })),
  };
}
