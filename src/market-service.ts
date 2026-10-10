/**
 * The market today for the discover page (`src/analysis/market.ts`): Yahoo's
 * lists, fetched live and kept as they came, and a quote for every stock of
 * the universe for the day's moves on both sides of the Atlantic. Fetched at
 * most every few minutes, and only while someone looks.
 *
 * And the market as the depot check reads it: the sector funds against the
 * index from the price archive, and Perplexity's brief, bought at most twice
 * a day.
 */

import {
  MARKET_LISTS, MARKET_LIST_SIZE, quoteRow, type MarketList, type MarketListDef, type MarketRow, type MarketToday,
} from './analysis/market.js';
import type { MarketBrief } from './analysis/market-brief.js';
import { sectorTrends, type SectorTrend } from './analysis/sector-rotation.js';
import { getConfig } from './config.js';
import { fetchMarketBrief, MARKET_BRIEF_PROMPT_HASH } from './data/market-brief.js';
import { SECTOR_ETFS } from './data/macro.js';
import { quotesFor, screenerQuotes, trendingTickers } from './data/yahoo-market.js';
import { readPriceBarsMany } from './db/history-store.js';
import { latestMarketBrief, saveMarketBrief, saveMarketList } from './db/market-store.js';
import { gateway, perplexityModelForTask } from './llm/gateway.js';
import type { PerplexityModelId } from './models.js';
import { peersBySymbol, type StoredPeer } from './db/store.js';
import { universeStocks } from './discover-service.js';
import { logoDomain } from './symbols.js';
import { logger } from './utils/logger.js';

const TTL_MS = 10 * 60_000;
let memo: { at: number; value: Promise<MarketToday> } | null = null;

type QuoteRow = NonNullable<ReturnType<typeof quoteRow>>;
const isRow = (r: QuoteRow | null): r is QuoteRow => r !== null;

/** A list as Yahoo sends it. Trending is tickers only, so their quotes are fetched after, in its order. */
async function rawList(def: MarketListDef): Promise<Record<string, unknown>[]> {
  if (def.key === 'trending') {
    const tickers = await trendingTickers('US', MARKET_LIST_SIZE);
    const quotes = new Map((await quotesFor(tickers)).map((q) => [String(q.symbol).toUpperCase(), q]));
    return tickers.flatMap((t): Record<string, unknown>[] => { const q = quotes.get(t.toUpperCase()); return q ? [q] : []; });
  }
  // A list cut by size comes longer, so enough rows are left after the cut.
  return screenerQuotes(def.key, def.minCap ? MARKET_LIST_SIZE * 4 : MARKET_LIST_SIZE);
}

/** A quote with what the app knows of the stock: on the list, in the universe, or new. */
function known(r: QuoteRow, p: StoredPeer | undefined): MarketRow {
  return {
    ...r,
    name:       r.name ?? p?.companyName ?? null,
    status:     !p ? 'unknown' : p.reference ? 'reference' : 'list',
    score:      p?.score ?? null,
    verdict:    p?.verdict ?? null,
    logoDomain: logoDomain(p?.website ?? null),
    sector:     null,
    industry:   p?.industry ?? null,
  };
}

async function fetchList(def: MarketListDef): Promise<Omit<MarketList, 'rows'> & { rows: QuoteRow[] }> {
  try {
    const raw = await rawList(def);
    saveMarketList(def.key, raw).catch((e) => logger.warn(`Market list ${def.key} not archived: ${(e as Error).message}`));
    const rows = raw.map(quoteRow).filter(isRow)
      .filter((r) => !def.minCap || (r.marketCap ?? 0) >= def.minCap)
      .slice(0, MARKET_LIST_SIZE);
    return { key: def.key, rows, error: null };
  } catch (e) {
    logger.warn(`Market list ${def.key}: ${(e as Error).message}`);
    return { key: def.key, rows: [], error: (e as Error).message };
  }
}

/**
 * The day's move of every universe stock off the list. Not archived: these are
 * the intraday quotes of stocks whose daily closes the nightly refresh keeps.
 */
async function universeMoves(): Promise<MarketRow[]> {
  const stocks = await universeStocks();
  const quotes = new Map((await quotesFor(stocks.map((s) => s.symbol)))
    .map((q) => quoteRow(q)).filter(isRow).map((r) => [r.symbol, r]));
  return stocks.flatMap((s): MarketRow[] => {
    const q = quotes.get(s.symbol.toUpperCase());
    return q ? [{
      ...q,
      name: s.name ?? q.name, status: 'reference', score: s.score, verdict: s.verdict,
      logoDomain: s.logoDomain, sector: s.sector, industry: s.industry,
    }] : [];
  });
}

async function readMarket(): Promise<MarketToday> {
  const at = new Date().toISOString();
  const [fetched, universe] = await Promise.all([Promise.all(MARKET_LISTS.map(fetchList)), universeMoves()]);
  const stored = await peersBySymbol([...new Set(fetched.flatMap((l) => l.rows.map((r) => r.symbol)))]);
  return {
    at,
    lists: fetched.map((l) => ({ ...l, rows: l.rows.map((r) => known(r, stored.get(r.symbol))) })),
    universe,
  };
}

/**
 * Fetch and keep Yahoo's lists without anyone looking — once a day from the
 * nightly archive, so the record does not depend on the page being opened.
 */
export async function archiveMarketLists(): Promise<void> {
  await Promise.all(MARKET_LISTS.map(fetchList));
}

/** The market today, from the cache while it is fresh. */
export function marketToday(): Promise<MarketToday> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
  const entry = { at: Date.now(), value: readMarket() };
  entry.value.catch(() => { if (memo === entry) memo = null; });
  memo = entry;
  return entry.value;
}

/** The index the sector funds are measured against: the fund, so dividends count on both sides. */
const SECTOR_INDEX = 'SPY';
/** Seven months of sessions: six to measure, and the weekends and holidays. */
const SECTOR_DAYS = 230;

/** The US sector funds against the S&P 500, from the price archive. */
export async function sectorTrendsNow(): Promise<SectorTrend[]> {
  const from = new Date(Date.now() - SECTOR_DAYS * 86_400_000).toISOString().slice(0, 10);
  const bars = await readPriceBarsMany([SECTOR_INDEX, ...SECTOR_ETFS.map((s) => s.etf)], from);
  const closes = new Map([...bars].map(([t, xs]) => [t, xs.map((b) => ({ day: b.day, close: b.adjClose ?? b.close }))]));
  return sectorTrends(SECTOR_ETFS, closes, SECTOR_INDEX);
}

/** A brief younger than this is the morning's: the market has not turned since. */
const BRIEF_REUSE_MS = 12 * 60 * 60 * 1000;

/**
 * Perplexity's market brief: the stored one while it is fresh and from this
 * model and question, else a new one, kept. Throws without a key or an answer.
 */
export async function marketBrief(configured: PerplexityModelId): Promise<MarketBrief> {
  // Through the LiteLLM proxy the brief is its task's: stored and reused under the model that writes it there.
  const model = await perplexityModelForTask('market-brief', configured);
  const stored = await latestMarketBrief(model, MARKET_BRIEF_PROMPT_HASH, BRIEF_REUSE_MS);
  if (stored) return stored;
  const key = getConfig().pplxApiKey ?? '';
  if (!key && !gateway()) throw new Error('Kein PPLX_API_KEY und kein LiteLLM: ohne einen von beiden keine Marktlage.');
  const { brief, raw } = await fetchMarketBrief(model, key);
  await saveMarketBrief(brief, raw);
  return brief;
}
