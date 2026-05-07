import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, getOptionsSignals, resolveSymbol } from './data/yfinance.js';
import { getNews, getBasicFinancials } from './data/finnhub.js';
import { getMacroBundle } from './data/macro.js';
import { getMarketRates } from './data/fred.js';
import { computeTechnicals } from './analysis/technical.js';
import { writeFinancials, writeNews, writeMarketSignals } from './cache.js';
import {
  MarketSignals, NewsItem, OptionsSignals, StockFinancials,
} from './types.js';

export interface RefreshedData {
  symbol:        string;
  financials:    StockFinancials;
  news:          NewsItem[];
  marketSignals: MarketSignals;
}

/**
 * Force-refresh the data layer for a symbol without touching anything LLM-
 * related. Re-fetches:
 *   - Yahoo Finance (financials, daily bars, options snapshot)
 *   - Finnhub (sector medians, news, basic metrics)
 *   - FRED (risk-free + AAA yield)
 *   - Macro bundle (SPY, sector ETF, yield curve)
 *   - Computes fresh technicals
 *
 * Does NOT touch:
 *   - Cached LLM analyses (`analyses/<hash>.json`)
 *   - Perplexity context
 *   - EDGAR submissions
 *   - Reports (`report.md/.html/.pdf`) — those reflect the last full analysis run
 */
export async function refreshStockData(rawSymbol: string): Promise<RefreshedData> {
  const cfg = getConfig();
  const symbol = await resolveSymbol(rawSymbol);

  logger.step(`Refreshing data for ${symbol}…`);

  // Yahoo financials + Finnhub enrichment
  const [bundle, finnhubMetrics] = await Promise.all([
    getFinancials(symbol),
    cfg.finnhubApiKey ? getBasicFinancials(symbol, cfg.finnhubApiKey) : Promise.resolve(null),
  ]);
  if (finnhubMetrics) {
    bundle.financials.roic                 = finnhubMetrics.roic;
    bundle.financials.epsGrowth3Y          = finnhubMetrics.epsGrowth3Y;
    bundle.financials.dividendGrowthRate5Y = finnhubMetrics.dividendGrowthRate5Y;
  }
  writeFinancials(cfg.cacheDir, symbol, bundle.financials);

  // News (best effort)
  let news: NewsItem[] = [];
  if (cfg.finnhubApiKey) {
    try {
      news = await getNews(symbol, cfg.finnhubApiKey);
      if (news.length > 0) writeNews(cfg.cacheDir, symbol, news);
    } catch (e) {
      logger.warn(`News refresh failed: ${(e as Error).message}`);
    }
  }

  // Macro context (SPY, sector ETF, yield curve, FX) + options + technicals.
  // Rates fetched purely so we re-validate the FRED feed; not cached separately.
  await (cfg.fredApiKey ? getMarketRates(cfg.fredApiKey).catch(() => null) : Promise.resolve(null));
  const [macro, optionsRaw] = await Promise.all([
    getMacroBundle(bundle.financials.sector, cfg.fredApiKey ?? null),
    getOptionsSignals({
      symbol,
      spot:             bundle.financials.price,
      nextEarningsDate: bundle.financials.nextEarningsDate,
      hv90:             null,
    }),
  ]);
  const technicals = computeTechnicals({
    bars:       bundle.dailyBars,
    spyBars:    macro.spyBars,
    sectorBars: macro.sectorBars ?? undefined,
  });
  let options: OptionsSignals | null = optionsRaw;
  if (options && options.ivAtm30d !== null && technicals.hv90 !== null && technicals.hv90 > 0) {
    options = { ...options, ivVsHv90Ratio: options.ivAtm30d / technicals.hv90 };
  }
  const marketSignals: MarketSignals = {
    technicals,
    revisions: bundle.revisions,
    options,
    macro:     macro.context,
  };
  writeMarketSignals(cfg.cacheDir, symbol, marketSignals);

  logger.success(`Data refreshed for ${symbol}`);
  return { symbol, financials: bundle.financials, news, marketSignals };
}
