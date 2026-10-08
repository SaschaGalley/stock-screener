/**
 * Does the backtest measure the score the app shows?
 *
 * The backtest rebuilds each company from its SEC filings, Yahoo's prices and
 * the rating history, and calibrates every day from that day's S&P 1500. The
 * app scores the same company from Yahoo's current fields and Finnhub's peers,
 * against the distributions of its own reference universe. Both run the same
 * `computeFactorScore`; whether they hand it the same company is a question the
 * backtest's numbers rest on, and one that can be answered: for every stock the
 * app holds that is in the backtest's universe too, its newest live score
 * beside the backtest's score of the same session.
 *
 * Three scores a stock, to tell the sources of a difference apart:
 *
 *   live      — the app's: its stored inputs, its committed calibration and
 *               premium, its recorded rates. Recomputed with the code as it is,
 *               so a scoring change since the snapshot is not a difference.
 *   data      — the backtest's payload scored the app's way: committed
 *               calibration and premium, the app's rates. Live against data is
 *               the data alone — filings against Yahoo, the rebuilt consensus
 *               against today's, GICS peers against Finnhub's.
 *   backtest  — the backtest's payload as the backtest scores it: that
 *               session's own distributions and premium, FRED's rates. Data
 *               against backtest is the method alone.
 *
 * Only the factor score: the narrative half of the final score exists only for
 * the watchlist and has no history to rebuild.
 */

import { computeAllMetrics } from '../analysis/computeMetrics.js';
import { CALIBRATION_META, premiumFor, useCalibrationTable, usePremiumAdjustment } from '../analysis/calibration.js';
import { spearman } from '../analysis/evaluate.js';
import { computeFactorScore, PILLAR_LABELS } from '../analysis/score.js';
import type { MarketRates } from '../data/fred.js';
import { storedInputs } from '../db/rescore.js';
import { listSymbols, macroHistory } from '../db/store.js';
import { PILLAR_KEYS, type FactorScore, type PillarKey, type StockFinancials } from '../types.js';
import { RECOMMENDATIONS } from '../verdict.js';
import { logger } from '../utils/logger.js';
import { calibrateCrossSection, median, type CrossEntry } from './cross-section.js';
import type { BacktestCompany, BacktestData } from './load.js';
import { payloadAt } from './payload.js';
import { sessionOf } from './prices.js';
import { sectorToEtf } from '../data/macro.js';

/** A live snapshot older than this before the newest price is not compared: the app has moved on from it. */
const MAX_SNAPSHOT_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
/** The stocks whose live and backtest scores differ the most, named. */
const GAPS = 10;

/** How well two readings of one figure agree across the stocks both have. */
export interface FidelityScore {
  key:   string;
  label: string;
  /** Stocks with both a live and a backtest reading. */
  n:     number;
  /** Rank correlation, live against backtest — the one the IC inherits. */
  rho:     number | null;
  /** Live against the backtest's data scored the app's way: the data alone. */
  rhoData: number | null;
  /** The backtest's data the app's way against the backtest's way: the method alone. */
  rhoMethod: number | null;
  meanLive:     number | null;
  meanBacktest: number | null;
  meanAbsDiff:  number | null;
}

export interface FidelityCriterion {
  pillar: PillarKey;
  key:    string;
  label:  string;
  /** Share of the compared stocks the criterion scored for, live and in the backtest. */
  live:     number;
  backtest: number;
  /** Stocks it scored for in both, and the rank correlation of their points (live against the backtest's data). */
  n:   number;
  rho: number | null;
  /** Mean points of those stocks, 0–1. */
  meanLive:     number | null;
  meanBacktest: number | null;
}

/** One input field, as the app read it from Yahoo and as the backtest rebuilt it. */
export interface FidelityField {
  key:      string;
  /** Share of the compared stocks with a value, live and in the backtest. */
  live:     number;
  backtest: number;
  /** Of the stocks with both, the share that agree — amounts within 10 %, rates within two points — and the rank correlation. */
  n:        number;
  agree:    number | null;
  rho:      number | null;
}

export interface FidelityGap {
  symbol:   string;
  live:     number;
  data:     number;
  backtest: number;
  /** The pillar that differed the most. */
  pillar:   { key: PillarKey; label: string; live: number | null; backtest: number | null } | null;
}

export interface Fidelity {
  generatedAt: string;
  /** The sessions the live snapshots carried, with how many stocks each. */
  sessions: { day: string; symbols: number }[];
  compared: number;
  /** Stocks the app holds outside the backtest's universe — Europe, the watchlist's own. */
  outside:  number;
  /** In both, but without a live snapshot recent enough or a payload the backtest could build. */
  missing:  number;
  /** The premium adjustment: the app's committed one, and the median the sessions' DCFs implied. */
  premium:  { live: number; backtest: number };
  /** The rates of the largest session, as the app recorded them and as the backtest reads them from FRED. */
  rates:    { live: { riskFree: number; premium: number }; backtest: { riskFree: number; premium: number } } | null;
  scores:   FidelityScore[];
  verdicts: { same: number; adjacent: number; counts: { live: string; backtest: string; n: number }[] };
  /** The top tenth of the compared stocks by each score, and how many of it the two share. */
  top:      { size: number; shared: number };
  criteria: FidelityCriterion[];
  fields:   FidelityField[];
  gaps:     FidelityGap[];
}

/**
 * The inputs compared field by field: where a pillar disagrees, these say
 * whether the backtest rebuilt the figure differently or not at all.
 */
export const FIDELITY_FIELDS = [
  'price', 'marketCap', 'revenue', 'grossProfit', 'ebit', 'ebitda', 'netIncome', 'operatingCashFlow', 'freeCashFlow',
  'totalDebt', 'totalCash', 'interestExpense', 'totalAssets', 'totalLiabilities', 'totalCurrentAssets',
  'totalCurrentLiabilities', 'retainedEarnings', 'bookValue', 'sharesOutstanding', 'revenueGrowth', 'earningsGrowth',
  'operatingMargin', 'peRatio', 'roic', 'beta', 'targetMeanPrice', 'analystCount',
] as const;
const RATE_TOLERANCE: Record<string, number> = {
  revenueGrowth: 0.02, earningsGrowth: 0.02, operatingMargin: 0.02, roic: 0.02, beta: 0.1,
};

interface Pair {
  symbol:  string;
  company: BacktestCompany;
  session: string;
  rates:   MarketRates;
  live:    FactorScore;
  liveFinancials: StockFinancials;
  data?:   FactorScore;
  backtest?: FactorScore;
  backtestFinancials?: StockFinancials;
}

/** The US tickers' class separator, which the index tables and Yahoo spell differently. */
const tickerKey = (s: string) => s.toUpperCase().replace(/\./g, '-');

export async function fidelityCheck(data: BacktestData, ratesOn: (day: string) => MarketRates): Promise<Fidelity | null> {
  const { companies, facts, prices, bench, analysts } = data;
  const lastSession = bench.dates[bench.dates.length - 1];
  // Snapshots up to the newest close the prices hold: a later one carries a
  // price the backtest cannot rebuild.
  const until = Date.parse(`${lastSession}T23:59:59Z`);
  const byTicker = new Map(companies.filter((c) => !c.removed).map((c) => [tickerKey(c.symbol), c]));

  const symbols = await listSymbols('all');
  const macro = await macroHistory('macro.');
  const pairs: Pair[] = [];
  let outside = 0, missing = 0;

  try {
    // The app's own calibration and premium for the live scores.
    useCalibrationTable(null);
    usePremiumAdjustment(null);
    for (const symbol of symbols) {
      const company = byTicker.get(tickerKey(symbol));
      if (!company) { outside++; continue; }
      const inputs = await storedInputs(symbol, until, macro);
      const session = inputs ? sessionOf(inputs.capturedAt, bench.dates) : null;
      if (!inputs || !session || until - inputs.capturedAt.getTime() > MAX_SNAPSHOT_AGE_DAYS * DAY_MS) { missing++; continue; }
      const { financials, sectorMedians, marketSignals, technicalSignals } = inputs;
      const live = computeFactorScore({
        financials, metrics: computeAllMetrics(financials, inputs.rates, sectorMedians),
        sectorMedians, marketSignals, technicalSignals,
      });
      pairs.push({ symbol, company, session, rates: inputs.rates, live, liveFinancials: financials });
    }

    const bySession = new Map<string, Pair[]>();
    for (const p of pairs) (bySession.get(p.session) ?? bySession.set(p.session, []).get(p.session)!).push(p);
    const premiums: number[] = [];
    for (const [day, group] of bySession) {
      // The session's whole cross-section, as a month-end of the run would be.
      const entries: (CrossEntry & { c: BacktestCompany })[] = companies.flatMap((c) => {
        if (c.added && c.added > day) return [];
        if (c.removed && c.removed <= day) return [];
        const f = facts.get(c.symbol), px = prices.get(c.symbol);
        if (!f || !px) return [];
        const etf = sectorToEtf(c.sector);
        const p = payloadAt(c, f, px, bench, etf ? prices.get(etf) ?? null : null, day, analysts.get(c.symbol) ?? null);
        return p ? [{ c, ...p }] : [];
      });
      if (entries.length < 20) { missing += group.length; continue; }
      const cs = calibrateCrossSection(entries, ratesOn(day));
      premiums.push(cs.premium);
      const index = new Map(entries.map((e, k) => [e.c.symbol, k]));
      for (const p of group) {
        const k = index.get(p.company.symbol);
        if (k === undefined) continue;
        p.backtest = cs.score(k);
        p.backtestFinancials = entries[k].financials;
      }
      // The same payloads the app's way: its table, its premium, its rates.
      useCalibrationTable(null);
      usePremiumAdjustment(null);
      for (const p of group) {
        const k = index.get(p.company.symbol);
        if (k === undefined) continue;
        const e = entries[k], peers = cs.peers.get(e.c.symbol) ?? null;
        p.data = computeFactorScore({
          financials: e.financials, metrics: computeAllMetrics(e.financials, p.rates, peers),
          sectorMedians: peers, marketSignals: e.signals, technicalSignals: null,
        });
      }
    }

    const both = pairs.filter((p): p is Pair & Required<Pick<Pair, 'data' | 'backtest' | 'backtestFinancials'>> =>
      !!p.data && !!p.backtest && !!p.backtestFinancials);
    missing += pairs.length - both.length;
    if (both.length < 20) {
      logger.warn(`Fidelity: only ${both.length} stocks in both the app and the backtest — not compared`);
      return null;
    }

    const largest = [...bySession].sort((a, b) => b[1].length - a[1].length)[0];
    const fred = ratesOn(largest[0]);
    const liveRates = largest[1][0].rates;
    return {
      generatedAt: new Date().toISOString(),
      sessions: [...bySession].map(([day, g]) => ({ day, symbols: g.length })).sort((a, b) => b.day.localeCompare(a.day)),
      compared: both.length, outside, missing,
      // The American firms' on both sides: the backtest's stocks are no others.
      premium: { live: premiumFor(CALIBRATION_META.premiumAdjustments, 'USD', false), backtest: median(premiums) ?? 0 },
      rates: {
        live: { riskFree: liveRates.riskFreeRate, premium: liveRates.equityRiskPremium },
        backtest: { riskFree: fred.riskFreeRate, premium: fred.equityRiskPremium },
      },
      ...compare(both),
    };
  } finally {
    useCalibrationTable(null);
    usePremiumAdjustment(null);
  }
}

type Compared = Pick<Fidelity, 'scores' | 'verdicts' | 'top' | 'criteria' | 'fields' | 'gaps'>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pillarOf = (f: FactorScore, key: PillarKey) => f.pillars.find((p) => p.key === key) ?? null;

/** The live, data and backtest scores of the same stocks, side by side. */
export function compare(pairs: readonly {
  symbol: string; live: FactorScore; data: FactorScore; backtest: FactorScore;
  liveFinancials?: StockFinancials; backtestFinancials?: StockFinancials;
}[]): Compared {
  const readings: { key: string; label: string; read: (f: FactorScore) => number | null }[] = [
    { key: 'score', label: 'Score', read: (f) => f.score },
    { key: 'raw', label: 'Score roh (vor Schrumpfung und Streckung)', read: (f) => f.raw },
    ...PILLAR_KEYS.map((k) => ({ key: k, label: PILLAR_LABELS[k], read: (f: FactorScore) => pillarOf(f, k)?.score ?? null })),
  ];
  const rhoOf = (a: (number | null)[], b: (number | null)[]) => {
    const x: number[] = [], y: number[] = [];
    a.forEach((v, i) => {
      const w = b[i];
      if (v !== null && w !== null && Number.isFinite(v) && Number.isFinite(w)) { x.push(v); y.push(w); }
    });
    return x.length >= 10 ? spearman(x, y) : null;
  };
  const scores: FidelityScore[] = readings.map(({ key, label, read }) => {
    const live = pairs.map((p) => read(p.live)), data = pairs.map((p) => read(p.data)), bt = pairs.map((p) => read(p.backtest));
    const both = pairs.flatMap((_, i) => (live[i] !== null && bt[i] !== null ? [[live[i]!, bt[i]!]] : []));
    return {
      key, label, n: both.length,
      rho: rhoOf(live, bt), rhoData: rhoOf(live, data), rhoMethod: rhoOf(data, bt),
      meanLive: mean(both.map((x) => x[0])), meanBacktest: mean(both.map((x) => x[1])),
      meanAbsDiff: mean(both.map((x) => Math.abs(x[1] - x[0]))),
    };
  });

  const rank = (v: string) => RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);
  const counts = new Map<string, number>();
  for (const p of pairs) counts.set(`${p.live.verdict}|${p.backtest.verdict}`, (counts.get(`${p.live.verdict}|${p.backtest.verdict}`) ?? 0) + 1);
  const verdicts = {
    same: pairs.filter((p) => p.live.verdict === p.backtest.verdict).length / pairs.length,
    adjacent: pairs.filter((p) => Math.abs(rank(p.live.verdict) - rank(p.backtest.verdict)) <= 1).length / pairs.length,
    counts: [...counts].map(([k, n]) => {
      const [live, backtest] = k.split('|');
      return { live, backtest, n };
    }).sort((a, b) => rank(a.live) - rank(b.live) || rank(a.backtest) - rank(b.backtest)),
  };

  const size = Math.max(1, Math.round(pairs.length / 10));
  const topBy = (read: (p: (typeof pairs)[number]) => number) =>
    new Set([...pairs].sort((a, b) => read(b) - read(a)).slice(0, size).map((p) => p.symbol));
  const topLive = topBy((p) => p.live.score), topBacktest = topBy((p) => p.backtest.score);
  const top = { size, shared: [...topLive].filter((s) => topBacktest.has(s)).length };

  const criteria: FidelityCriterion[] = [];
  for (const pillar of PILLAR_KEYS) {
    const keys = new Map<string, string>();
    for (const p of pairs) for (const c of pillarOf(p.live, pillar)?.criteria ?? []) keys.set(c.key, c.label);
    for (const [key, label] of keys) {
      const pointsOf = (f: FactorScore) => pillarOf(f, pillar)?.criteria.find((c) => c.key === key)?.points ?? null;
      const live = pairs.map((p) => pointsOf(p.live)), data = pairs.map((p) => pointsOf(p.data)), bt = pairs.map((p) => pointsOf(p.backtest));
      const both = pairs.flatMap((_, i) => (live[i] !== null && data[i] !== null ? [[live[i]!, data[i]!]] : []));
      criteria.push({
        pillar, key, label,
        live: live.filter((v) => v !== null).length / pairs.length,
        backtest: bt.filter((v) => v !== null).length / pairs.length,
        n: both.length, rho: rhoOf(live, data),
        meanLive: mean(both.map((x) => x[0])), meanBacktest: mean(both.map((x) => x[1])),
      });
    }
  }

  const fields: FidelityField[] = FIDELITY_FIELDS.map((key) => {
    const read = (f: StockFinancials | undefined) => {
      const v = f ? (f as unknown as Record<string, unknown>)[key] : null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const live = pairs.map((p) => read(p.liveFinancials)), bt = pairs.map((p) => read(p.backtestFinancials));
    const both = pairs.flatMap((_, i) => (live[i] !== null && bt[i] !== null ? [[live[i]!, bt[i]!]] : []));
    // Rates within two points of each other, beta within a tenth, amounts within ten per cent.
    const close = (a: number, b: number) => (key in RATE_TOLERANCE
      ? Math.abs(a - b) <= RATE_TOLERANCE[key]
      : Math.abs(a - b) <= 0.1 * Math.max(Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-9);
    return {
      key,
      live: live.filter((v) => v !== null).length / pairs.length,
      backtest: bt.filter((v) => v !== null).length / pairs.length,
      n: both.length,
      agree: both.length ? both.filter(([a, b]) => close(a, b)).length / both.length : null,
      rho: rhoOf(live, bt),
    };
  });

  const gaps: FidelityGap[] = [...pairs]
    .sort((a, b) => Math.abs(b.backtest.score - b.live.score) - Math.abs(a.backtest.score - a.live.score))
    .slice(0, GAPS)
    .map((p) => {
      const worst = PILLAR_KEYS.map((k) => ({
        key: k, live: pillarOf(p.live, k)?.score ?? null, backtest: pillarOf(p.backtest, k)?.score ?? null,
      })).sort((a, b) => {
        const d = (x: { live: number | null; backtest: number | null }) =>
          x.live === null && x.backtest === null ? -1 : x.live === null || x.backtest === null ? 5 : Math.abs(x.live - x.backtest);
        return d(b) - d(a);
      })[0];
      return {
        symbol: p.symbol, live: p.live.score, data: p.data.score, backtest: p.backtest.score,
        pillar: worst ? { ...worst, label: PILLAR_LABELS[worst.key] } : null,
      };
    });

  return { scores, verdicts, top, criteria, fields, gaps };
}

// ── Report ───────────────────────────────────────────────────────────────────

const f2 = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));

export function renderFidelity(r: Fidelity): string {
  const out: string[] = [];
  out.push(`Backtest gegen Live-Score — ${r.compared} Aktien in beiden (${r.outside} nur in der App, ${r.missing} ohne Gegenstück)`);
  out.push(`  Sitzungen: ${r.sessions.map((s) => `${s.day} (${s.symbols})`).join(', ')}`);
  out.push(`  Prämienkorrektur: App ${(r.premium.live * 100).toFixed(2)} Pkt., Backtest ${(r.premium.backtest * 100).toFixed(2)} Pkt.`);
  if (r.rates) {
    out.push(`  Zins/Prämie: App ${(r.rates.live.riskFree * 100).toFixed(2)} % / ${(r.rates.live.premium * 100).toFixed(2)} %, `
      + `Backtest ${(r.rates.backtest.riskFree * 100).toFixed(2)} % / ${(r.rates.backtest.premium * 100).toFixed(2)} %`);
  }
  out.push('');
  out.push(`  ${'Signal'.padEnd(44)} ${'n'.padStart(4)}  ρ live~bt  ρ Daten  ρ Methode   Ø live  Ø bt  Ø|Δ|`);
  for (const s of r.scores) {
    out.push(`  ${s.label.padEnd(44)} ${String(s.n).padStart(4)}  ${f2(s.rho).padStart(9)}  ${f2(s.rhoData).padStart(7)}  ${f2(s.rhoMethod).padStart(9)}`
      + `   ${f2(s.meanLive).padStart(6)}  ${f2(s.meanBacktest).padStart(4)}  ${f2(s.meanAbsDiff).padStart(4)}`);
  }
  out.push('');
  out.push(`  Urteil gleich: ${(r.verdicts.same * 100).toFixed(0)} %, höchstens eine Stufe auseinander: ${(r.verdicts.adjacent * 100).toFixed(0)} %`);
  out.push(`  Oberstes Zehntel: ${r.top.shared} von ${r.top.size} in beiden`);
  out.push('');
  out.push('  Kriterien (Punkte, live gegen Backtest-Daten):');
  for (const c of r.criteria) {
    out.push(`    ${`${c.pillar}.${c.key}`.padEnd(36)} live ${(c.live * 100).toFixed(0).padStart(3)} %  bt ${(c.backtest * 100).toFixed(0).padStart(3)} %`
      + `  n ${String(c.n).padStart(3)}  ρ ${f2(c.rho).padStart(5)}  Ø ${f2(c.meanLive)} / ${f2(c.meanBacktest)}`);
  }
  out.push('');
  out.push('  Eingangsdaten (Anteil mit Wert live / Backtest, davon gleich: Beträge ±10 %, Raten ±2 Pkt.):');
  for (const f of r.fields) {
    out.push(`    ${f.key.padEnd(24)} live ${(f.live * 100).toFixed(0).padStart(3)} %  bt ${(f.backtest * 100).toFixed(0).padStart(3)} %`
      + `  gleich ${f.agree === null ? '—' : `${(f.agree * 100).toFixed(0)} %`.padStart(5)}  ρ ${f2(f.rho).padStart(5)}`);
  }
  out.push('');
  out.push('  Größte Abstände:');
  for (const g of r.gaps) {
    out.push(`    ${g.symbol.padEnd(7)} live ${f2(g.live, 1)}  Daten ${f2(g.data, 1)}  Backtest ${f2(g.backtest, 1)}`
      + (g.pillar ? `  — ${g.pillar.label} ${f2(g.pillar.live, 1)} → ${f2(g.pillar.backtest, 1)}` : ''));
  }
  return out.join('\n');
}
