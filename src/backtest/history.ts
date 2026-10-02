/**
 * One stock's last five years, month-end by month-end, as the models would
 * have read it then.
 *
 * The backtest already rebuilds every S&P 500 member at every month-end since
 * 2013 from the SEC filings known that day (`payload.ts`) and runs them through
 * the live models — and then keeps only the factor score. This reuses the same
 * reconstruction for a single stock and keeps what the detail page wants: the
 * price, the composite fair value, earnings per share and four multiples.
 *
 * What it cannot rebuild, it leaves out, and the reader is told so:
 *   - Analyst targets were never archived, so the analyst contributor drops
 *     out of the composite, and the DCF starts from trailing growth.
 *   - Peer multiples need the peers' own reconstruction; one stock alone has
 *     none, so that contributor drops out too.
 *   - The premium adjustment is today's, applied to every month.
 * Every month is computed the same way, so the series is consistent with
 * itself — which is what "historically traded 20–44 % below" needs — but its
 * last point is not the headline composite, which has the analysts and peers.
 *
 * A company without XBRL filings (a foreign private issuer, most European
 * listings) gets the `annual` series instead: Yahoo's fiscal years, each held
 * from a quarter after it ends. That carries earnings and price multiples but
 * no fair value.
 */

import { join } from 'path';

import { computeAllMetrics } from '../analysis/computeMetrics.js';
import { companyFacts } from '../data/edgar-facts.js';
import { lookupCIK } from '../data/edgar.js';
import { sectorToEtf } from '../data/macro.js';
import type { StockFinancials } from '../types.js';
import type { ValuationHistory, ValuationHistoryPoint } from '../analysis/valuation-history.js';
import { payloadAt } from './payload.js';
import { indexAtOrBefore, monthEnds, priceHistory, type PriceHistory } from './prices.js';
import { rateHistory } from './rates.js';
import { savePriceHistory } from '../history-service.js';

const BENCHMARK = '^GSPC';
export const HISTORY_YEARS = 5;
/** Price history before the window: the payload wants a year of sessions and the beta five years of months. */
const PRICE_LEAD_YEARS = 5;
/** Fewer reconstructed months than this and the SEC route has not worked — fall back. */
const MIN_SEC_MONTHS = 12;
/** How long after a fiscal year ends its annual report is assumed known. */
const ANNUAL_REPORT_LAG_DAYS = 75;

function yearsBefore(date: string, years: number): string {
  return `${Number(date.slice(0, 4)) - years}${date.slice(4, 7)}-01`;
}

export interface HistoryInput {
  financials: StockFinancials;
  dataDir:    string;
  fredApiKey: string | null | undefined;
}

export async function reconstructHistory({ financials: f, dataDir, fredApiKey }: HistoryInput): Promise<ValuationHistory | null> {
  const dir = join(dataDir, 'backtest');
  const today = new Date().toISOString().slice(0, 10);
  const from = yearsBefore(today, HISTORY_YEARS);
  // A day old at most: the backtest's week-long cache would leave "today" a
  // week behind the rest of the page.
  const px = await priceHistory(f.symbol, yearsBefore(today, HISTORY_YEARS + PRICE_LEAD_YEARS), join(dir, 'prices'), 1);
  if (!px) return null;
  // Ten years of prices fetched anyway — the archive keeps them.
  await savePriceHistory(f.symbol, px).catch(() => { /* best effort */ });
  const days = monthEnds(px.dates, from, today);

  const sec = await fromFilings(f, px, days, dir, fredApiKey);
  if (sec && sec.length >= MIN_SEC_MONTHS) {
    return { symbol: f.symbol, source: 'sec', points: sec, computedAt: new Date().toISOString() };
  }
  return { symbol: f.symbol, source: 'annual', points: fromAnnual(f, px, days), computedAt: new Date().toISOString() };
}

async function fromFilings(
  f: StockFinancials, px: PriceHistory, days: string[], dir: string, fredApiKey: string | null | undefined,
): Promise<ValuationHistoryPoint[] | null> {
  const id = await lookupCIK(f.symbol);
  if (!id) return null;
  const facts = await companyFacts(id.cik, join(dir, 'facts'));
  if (!facts) return null;

  const priceFrom = px.dates[0];
  const etf = sectorToEtf(f.sector);
  const [bench, etfPx, ratesOn] = await Promise.all([
    priceHistory(BENCHMARK, priceFrom, join(dir, 'prices')),
    etf ? priceHistory(etf, priceFrom, join(dir, 'prices')) : Promise.resolve(null),
    rateHistory(priceFrom, fredApiKey),
  ]);
  if (!bench) return null;

  // Yahoo's sector and industry are what the live code reads; the payload maps
  // GICS names onto them and passes anything else through unchanged.
  const company = {
    symbol: f.symbol, name: f.companyName, cik: id.cik,
    sector: f.sector ?? '', subIndustry: f.industry ?? '', added: null,
  };

  return days.flatMap((day) => {
    const p = payloadAt(company, facts, px, bench, etfPx, day);
    if (!p) return [];
    const m = computeAllMetrics(p.financials, ratesOn(day), null);
    return [{
      date:         day,
      price:        p.financials.price,
      fairValue:    m.composite.primary.median,
      conservative: m.composite.conservative.median,
      eps:          p.financials.eps,
      pe:           m.ratios.pe,
      ps:           m.evMultiples.priceToSales,
      pfcf:         m.evMultiples.priceToFCF,
      evEbitda:     m.evMultiples.evToEbitda,
    }];
  });
}

/**
 * The fallback: today's annual history, each fiscal year taken as known a
 * quarter after it ends. Per-share revenue and cash flow divide by the share
 * count the year's own EPS implies (net income ÷ EPS), so buybacks show up
 * rather than being flattened onto today's count. Yahoo gives no year-end
 * date, so December is assumed — the one approximation here, and it moves a
 * step by at most a few months.
 */
function fromAnnual(f: StockFinancials, px: PriceHistory, days: string[]): ValuationHistoryPoint[] {
  const h = f.fundamentalsHistory;
  const byYear = (s: { year: number; value: number }[]) => new Map(s.map((x) => [x.year, x.value]));
  const eps = byYear(h.eps), ni = byYear(h.netIncome), rev = byYear(h.revenue), fcf = byYear(h.freeCashFlow);
  const years = [...eps.keys()].sort((a, b) => a - b);
  const knownOn = (year: number) =>
    new Date(Date.UTC(year, 11, 31) + ANNUAL_REPORT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);

  return days.map((day) => {
    const price = px.close[indexAtOrBefore(px.dates, day)];
    const year = [...years].reverse().find((y) => knownOn(y) <= day);
    const e = year !== undefined ? eps.get(year) ?? null : null;
    const n = year !== undefined ? ni.get(year) ?? null : null;
    const shares = e !== null && n !== null && e !== 0 && n / e > 0 ? n / e : null;
    const perShare = (m: Map<number, number>) => {
      const v = year !== undefined ? m.get(year) : undefined;
      return v !== undefined && shares ? v / shares : null;
    };
    const rps = perShare(rev), fps = perShare(fcf);
    return {
      date: day, price,
      fairValue: null, conservative: null,
      eps: e,
      pe:   e !== null && e > 0 ? price / e : null,
      ps:   rps !== null && rps > 0 ? price / rps : null,
      pfcf: fps !== null && fps > 0 ? price / fps : null,
      evEbitda: null,
    };
  });
}
