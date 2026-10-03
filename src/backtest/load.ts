/**
 * The companies and everything the backtest reads about them: who was in the
 * index and from when, their SEC filings, their prices and — unless left out —
 * the analysts' rating history. From the cache under the data directory where
 * it is fresh, from the sources where it is not.
 *
 * The month-end run (`run.ts`) and the comparison with the live scores
 * (`fidelity.ts`) read the same data the same way, so a difference between
 * the two is never a difference in what was loaded.
 */

import { join } from 'path';

import { logger } from '../utils/logger.js';
import { companyFacts, type CompanyFacts } from '../data/edgar-facts.js';
import { lookupCIK } from '../data/edgar.js';
import {
  fetchSp1500Constituents, fetchSp500Constituents, type CompositeIndex, type Constituent,
} from '../data/universe.js';
import { sectorToEtf } from '../data/macro.js';
import type { AnalystAction } from '../analysis/analyst-accuracy.js';
import { analystHistory } from './analysts.js';
import { resolveDeparted, type DepartedResolution } from './departed.js';
import type { Company } from './payload.js';
import { priceHistory, type PriceHistory } from './prices.js';

export const BENCHMARK = '^GSPC';
/** The S&P 1500 by default; the 500 alone to compare with the runs before it. */
export type BacktestUniverse = 'sp500' | 'sp1500';
/** Prices from a year before the first month-end: momentum reads twelve months back. */
const PRICE_LEAD_YEARS = 2;

export type BacktestCompany = Company & { segment: CompositeIndex };

export interface BacktestData {
  companies: BacktestCompany[];
  /** Index members without a SEC number, which the backtest cannot read. */
  withoutCik: number;
  departed:  DepartedResolution['counts'] | null;
  facts:     Map<string, CompanyFacts>;
  /** Each company's, the benchmark's and the sector ETFs' prices. */
  prices:    Map<string, PriceHistory>;
  bench:     PriceHistory;
  analysts:  Map<string, AnalystAction[]>;
  /** The first day prices were read from. */
  priceFrom: string;
}

/** A fixed number of downloads in flight, results in input order. */
export async function pooled<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
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

export async function loadBacktestData(opts: {
  dir: string;
  /** The first month-end the run scores. */
  from: string;
  universe: BacktestUniverse;
  limit?: number;
  analysts: boolean;
  /** Those that left since `from` too, as far as they can still be found. */
  departed: boolean;
  progress: (phase: string) => void;
}): Promise<BacktestData> {
  const { dir, from, universe, progress } = opts;
  const priceFrom = `${Number(from.slice(0, 4)) - PRICE_LEAD_YEARS}-01-01`;

  const withDeparted = universe === 'sp1500' && opts.departed;
  const sp1500 = universe === 'sp1500' ? await fetchSp1500Constituents(withDeparted ? from : undefined) : null;
  const listed: Constituent[] = sp1500
    ? sp1500.members
    : (await fetchSp500Constituents()).map((c) => ({ ...c, index: 'sp500' as const }));
  // The 400's table gives some filers by ticker rather than number; the SEC's
  // own list has them. One at a time: the first lookup loads the list, and the
  // rest read it from memory rather than each asking the SEC again.
  const constituents: Constituent[] = [];
  for (const c of listed) {
    const cik = c.cik ?? (await lookupCIK(c.symbol))?.cik ?? null;
    if (cik) constituents.push({ ...c, cik });
  }
  const companies: BacktestCompany[] = constituents.slice(0, opts.limit ?? constituents.length).map((c) => ({
    symbol: c.symbol, name: c.name, cik: c.cik!, sector: c.sector, subIndustry: c.subIndustry, added: c.added,
    segment: c.index ?? 'sp500',
  }));
  logger.info(`Backtest: ${companies.length} companies (${listed.length - constituents.length} without a SEC number), from ${from}`);

  // Those that left, as far as they can still be found, each up to the day it left.
  const departed = withDeparted && sp1500 && !opts.limit
    ? await resolveDeparted(sp1500.departed.filter((d) => !companies.some((c) => c.symbol === d.symbol)), join(dir, 'profiles'))
    : null;
  if (departed) {
    companies.push(...departed.companies.map((d) => ({
      symbol: d.symbol, name: d.name, cik: d.cik, sector: d.sector, subIndustry: d.subIndustry, added: d.added,
      removed: d.removed, segment: d.index ?? 'sp500',
    })));
    logger.info(`  Departed since ${from}: ${departed.counts.departed}, found ${departed.counts.included} `
      + `(${departed.counts.noFiler} without a matching SEC filer, ${departed.counts.noProfile} without a Yahoo profile)`);
  }

  const facts = new Map<string, CompanyFacts>();
  let done = 0;
  await pooled(companies, 4, async (c) => {
    const f = await companyFacts(c.cik, join(dir, 'facts'));
    if (f) facts.set(c.symbol, f);
    if (++done % 50 === 0) {
      logger.info(`  SEC filings: ${done}/${companies.length}`);
      progress(`SEC-Abschlüsse ${done}/${companies.length}`);
    }
  });

  const etfs = [...new Set(companies.map((c) => sectorToEtf(c.sector)).filter((e): e is string => !!e))];
  const prices = new Map<string, PriceHistory>();
  done = 0;
  await pooled([...companies.map((c) => c.symbol), BENCHMARK, ...etfs], 4, async (symbol) => {
    const p = await priceHistory(symbol, priceFrom, join(dir, 'prices'));
    // The closes, the adjusted closes and the splits are all the run reads;
    // the rest of each bar stays in the cache file, not in memory sixteen
    // hundred times over.
    if (p) prices.set(symbol, { dates: p.dates, close: p.close, adj: p.adj, splits: p.splits });
    if (++done % 50 === 0) {
      logger.info(`  Prices: ${done}/${companies.length + etfs.length + 1}`);
      progress(`Kurse ${done}/${companies.length + etfs.length + 1}`);
    }
  });
  const bench = prices.get(BENCHMARK);
  if (!bench) throw new Error(`No ${BENCHMARK} history — cannot build the calendar`);

  const analysts = new Map<string, AnalystAction[]>();
  if (opts.analysts) {
    done = 0;
    await pooled(companies, 4, async (c) => {
      const a = await analystHistory(c.symbol, join(dir, 'analysts'));
      if (a && a.length) analysts.set(c.symbol, a);
      if (++done % 50 === 0) {
        logger.info(`  Analyst histories: ${done}/${companies.length}`);
        progress(`Analysten-Historien ${done}/${companies.length}`);
      }
    });
  }

  return {
    companies, withoutCik: listed.length - constituents.length, departed: departed?.counts ?? null,
    facts, prices, bench, analysts, priceFrom,
  };
}
