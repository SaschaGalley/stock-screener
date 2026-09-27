import { getConfig } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, getOptionsSignals, resolveSymbol } from './data/yfinance.js';
import { getNews, getBasicFinancials } from './data/finnhub.js';
import { getOperatingLeaseLiabilities } from './data/edgar.js';
import { getSectorMediansCached, REFERENCE_PEER_TTL_MS } from './sector-medians.js';
import { getMacroBundle } from './data/macro.js';
import { LOCAL_TEN_YEAR, RateCurrency, getMarketRates } from './data/fred.js';
import { countryRiskFor, getCountryRiskTable } from './data/country-risk.js';
import { majorCurrency } from './currencies.js';
import { computeTechnicals } from './analysis/technical.js';
import { deriveTechnicalSignals } from './analysis/signals.js';
import {
  latestScoreCard, markReference, promoteSymbol,
  recordRunData, writeFinancials, writeMarketSignals, writeNews,
} from './db/store.js';
import { distillHintsFor } from './distill-service.js';
import { syncDistillDossiers } from './distill-content.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import { rescore } from './score-service.js';
import { readAppConfig } from './app-config.js';
import { noteVerdict } from './alerts.js';
import {
  MarketSignals, NewsItem, OptionsSignals, ScoreCard, StockFinancials,
} from './types.js';

type FinancialsBundle = Awaited<ReturnType<typeof getFinancials>>;

/**
 * Yahoo's financials with everything the models expect on the payload: Finnhub's
 * ROIC and growth rates, the operating leases in a US filer's debt, and the
 * country tables that price its cost of capital.
 *
 * One definition for every path that fetches financials. The analysis used to
 * fetch its own when the stored ones had expired, and wrote a payload without
 * the country premium — so a stock's cost of equity depended on whether the
 * data step or the analysis had fetched last.
 */
export async function fetchFinancialsBundle(symbol: string): Promise<FinancialsBundle> {
  const cfg = getConfig();
  const [bundle, finnhubMetrics] = await Promise.all([
    getFinancials(symbol),
    cfg.finnhubApiKey ? getBasicFinancials(symbol, cfg.finnhubApiKey) : Promise.resolve(null),
  ]);
  if (finnhubMetrics) {
    bundle.financials.roic                 = finnhubMetrics.roic;
    bundle.financials.epsGrowth3Y          = finnhubMetrics.epsGrowth3Y;
    bundle.financials.dividendGrowthRate5Y = finnhubMetrics.dividendGrowthRate5Y;
  }
  // US GAAP puts operating lease costs inside operating cash flow while Yahoo's
  // total debt also carries the liability; the SEC filing says how much of it
  // that is. Only asked where there are leases in the debt to separate.
  if (bundle.financials.financialCurrency === 'USD' && (bundle.financials.leaseObligations ?? 0) > 0) {
    bundle.financials.operatingLeaseLiabilities = await getOperatingLeaseLiabilities(symbol);
  }
  // What the headquarters country adds to a US-measured cost of capital, and
  // what the trading currency's government yield carries over risk-free —
  // recorded on the payload so a re-score of this day reads this day's table.
  const countryRisk = await getCountryRiskTable();
  if (countryRisk) {
    const own = countryRiskFor(countryRisk, bundle.financials.country);
    bundle.financials.countryRiskPremium   = own?.premium ?? null;
    bundle.financials.countryDefaultSpread = own?.defaultSpread ?? null;
    bundle.financials.marginalTaxRate      = own?.taxRate ?? null;
    const major = majorCurrency(bundle.financials.tradingCurrency);
    const issuer = major && major in LOCAL_TEN_YEAR ? LOCAL_TEN_YEAR[major as RateCurrency].issuer : null;
    bundle.financials.currencyDefaultSpread = issuer ? countryRiskFor(countryRisk, issuer)?.defaultSpread ?? null : null;
  }
  return bundle;
}

export interface RefreshedData {
  symbol:        string;
  financials:    StockFinancials;
  news:          NewsItem[];
  marketSignals: MarketSignals;
  /** The card recorded with this refresh. */
  scoreCard:     ScoreCard;
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
  /**
   * Refresh a member of the reference universe (`src/universe.ts`): only what
   * the factor score reads. No news, no options chain, no Distill, peers once a
   * month. The symbol is registered as a reference symbol if it is new, and a
   * watchlist stock that happens to be in the index stays on the watchlist.
   */
  reference?: boolean;
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
  const reference = opts.reference === true;
  const includeDistill = !reference && opts.includeDistill !== false;
  const runId = opts.runId ?? null;
  // A reference symbol arrives from the index list in Yahoo's spelling already;
  // resolving it would spend a quote per stock to learn nothing.
  const symbol = reference ? rawSymbol.toUpperCase() : await resolveSymbol(rawSymbol);

  // Before the first write, which creates the row: a new reference symbol must
  // never exist, even for a moment, as a watchlist stock.
  if (reference) await markReference(symbol);
  else await promoteSymbol(symbol);

  logger.step(`Refreshing ${reference ? 'reference ' : ''}data for ${symbol}…`);

  const bundle = await fetchFinancialsBundle(symbol);
  await writeFinancials(symbol, bundle.financials, runId);

  // News (best effort)
  let news: NewsItem[] = [];
  if (cfg.finnhubApiKey && !reference) {
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
      await syncDistillDossiers(
        distillHintsFor(symbol, bundle.financials),
        cfg.distillApiKey,
        cfg.distillApiUrl,
        runId,
      );
    } catch (e) {
      logger.warn(`Distill refresh failed: ${(e as Error).message}`);
    }
  }

  // Macro context (SPY, sector ETF, yield curve, FX) + options + technicals.
  // Rates are also what the valuation models discount with, so the same fetch
  // that re-validates the feeds feeds the models recorded below. No FRED key
  // still yields a premium: Damodaran's series needs none.
  const marketRates = await getMarketRates(cfg.fredApiKey).catch(() => null);
  const [macro, optionsRaw] = await Promise.all([
    getMacroBundle(bundle.financials.sector, cfg.fredApiKey ?? null),
    // The score never reads the options chain; the detail page does.
    reference ? Promise.resolve(null) : getOptionsSignals({
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
    ? await getSectorMediansCached(
      symbol, cfg.finnhubApiKey, bundle.financials, reference ? REFERENCE_PEER_TTL_MS : undefined,
    )
    : null;

  const technicalSignals = deriveTechnicalSignals(technicals, bundle.financials.price);
  const metrics = computeAllMetrics(bundle.financials, marketRates, sectorMedians);

  // Re-score on every refresh, not only when the analysis step runs.
  //
  // The deterministic half costs nothing and its inputs have just changed — a
  // new price, a new filing, a fresh peer median. Recomputing it here is what
  // makes `score.final.score` a genuine daily series rather than a step
  // function that jumps whenever the (five-day) analysis cadence comes round.
  // The prose half is carried forward from the last stored card and decays with
  // its own age, so a stock with no verdict yet simply scores on arithmetic.
  const scoring = (await readAppConfig()).scoring;
  const scoreCard = rescore({
    financials:   bundle.financials,
    metrics,
    sectorMedians,
    marketSignals,
    technicalSignals,
    previous:           await latestScoreCard(symbol),
    narrativeMaxWeight: scoring.narrativeMaxWeight,
    adjustmentLimit:    scoring.adjustmentLimit,
  });

  await recordRunData({
    symbol,
    runId,
    financials:       bundle.financials,
    marketSignals,
    sectorMedians,
    marketRates,
    technicalSignals,
    metrics,
    scoreCard,
  });

  if (!reference) await noteVerdict(symbol, 'refresh');

  logger.success(`Data refreshed for ${symbol}`);
  return { symbol, financials: bundle.financials, news, marketSignals, scoreCard };
}
