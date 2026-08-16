import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, getOptionsSignals, resolveSymbol } from './data/yfinance.js';
import { getNews, getBasicFinancials } from './data/finnhub.js';
import { getSectorMediansCached } from './sector-medians.js';
import { getMacroBundle } from './data/macro.js';
import { getMarketRates } from './data/fred.js';
import { computeTechnicals } from './analysis/technical.js';
import { deriveTechnicalSignals } from './analysis/signals.js';
import {
  recordRunData, writeDistill, writeFinancials, writeMarketSignals, writeNews,
} from './db/store.js';
import { distillHintsFor, loadDistillBundle } from './distill-service.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import {
  MarketSignals, NewsItem, OptionsSignals, StockFinancials,
} from './types.js';

export interface RefreshedData {
  symbol:        string;
  financials:    StockFinancials;
  news:          NewsItem[];
  marketSignals: MarketSignals;
}

export interface RefreshOptions {
  /**
   * Pull the current Distill briefing along the way. On by default, because a
   * user hitting "Refresh data" expects everything on the page to be current.
   * The nightly pipeline turns it off: it runs Distill as its own step (which
   * can also POST a refresh), and a symbol should reach Distill once per run.
   */
  includeDistill?: boolean;
  /** Pipeline run this refresh belongs to; recorded on everything it writes. */
  runId?: number | null;
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
 *   - Stored LLM verdicts, Perplexity context, EDGAR filings
 *   - Reports (`report.md/.pdf`) — those reflect the last full analysis run
 */
export async function refreshStockData(rawSymbol: string, opts: RefreshOptions = {}): Promise<RefreshedData> {
  const cfg = getConfig();
  const includeDistill = opts.includeDistill !== false;
  const runId = opts.runId ?? null;
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
  await writeFinancials(symbol, bundle.financials, runId);

  // News (best effort)
  let news: NewsItem[] = [];
  if (cfg.finnhubApiKey) {
    try {
      news = await getNews(symbol, cfg.finnhubApiKey);
      if (news.length > 0) await writeNews(symbol, news, runId);
    } catch (e) {
      logger.warn(`News refresh failed: ${(e as Error).message}`);
    }
  }

  // Distill briefings (best effort — non-fatal). Always-on when the key is
  // configured; admins publish briefings on Distill's own schedule, so a
  // header-refresh just pulls whatever's newest from the upstream corpus.
  if (includeDistill && cfg.distillApiKey) {
    try {
      const distill = await loadDistillBundle(
        distillHintsFor(symbol, bundle.financials),
        cfg.distillApiKey,
        cfg.distillApiUrl,
        cfg.distillBriefingTypeId,
      );
      await writeDistill(symbol, distill, runId);
    } catch (e) {
      logger.warn(`Distill refresh failed: ${(e as Error).message}`);
    }
  }

  // Macro context (SPY, sector ETF, yield curve, FX) + options + technicals.
  // Rates are also what the valuation models discount with, so the same fetch
  // that re-validates the FRED feed feeds the models recorded below.
  const marketRates = await (cfg.fredApiKey ? getMarketRates(cfg.fredApiKey).catch(() => null) : Promise.resolve(null));
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
  await writeMarketSignals(symbol, marketSignals, runId);

  // Record where this stock stands today. Peer medians are fetched for this
  // alone — without them the models would drop their peer-multiples
  // contributor and the recorded series wouldn't line up with what the UI
  // shows. The 19 valuation models are computed here rather than only on
  // request, because their outputs are the series the whole store exists for.
  const sectorMedians = cfg.finnhubApiKey
    ? await getSectorMediansCached(symbol, cfg.finnhubApiKey)
    : null;

  await recordRunData({
    symbol,
    runId,
    financials:       bundle.financials,
    marketSignals,
    sectorMedians,
    marketRates,
    technicalSignals: deriveTechnicalSignals(technicals, bundle.financials.price),
    metrics:          computeAllMetrics(bundle.financials, marketRates, sectorMedians),
  });

  logger.success(`Data refreshed for ${symbol}`);
  return { symbol, financials: bundle.financials, news, marketSignals };
}
