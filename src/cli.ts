#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';

import { getConfig, requireApiKey } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, getOptionsSignals, resolveSymbol, searchByQuery } from './data/yfinance.js';
import { getNews, getBasicFinancials, getSectorMedians } from './data/finnhub.js';
import { fmtBig } from './analysis/metrics.js';
import { computeAllMetrics } from './analysis/computeMetrics.js';
import { computeTechnicals, DailyBar } from './analysis/technical.js';
import { createProvider } from './providers/factory.js';
import { TavilySearch } from './search/tavily.js';
import { BraveSearch } from './search/brave.js';
import {
  readFinancials,    writeFinancials,
  readAnalysis,      writeAnalysis,
  readNews,          writeNews,
  readMarketSignals, writeMarketSignals,
  readPerplexity,    writePerplexity,
  readDistill,       writeDistill,
  readSubmissions,   symbolDir,
  AnalysisFlagsKey, analysisHash,
} from './cache.js';
import { fetchEdgarFilings } from './data/edgar.js';
import { getMarketRates } from './data/fred.js';
import { getMacroBundle } from './data/macro.js';
import { fetchPerplexity } from './data/perplexity.js';
import { fetchDistillBriefings, DistillBundle } from './data/distill.js';
import { buildAnalysisPrompt } from './output/prompt.js';
import { formatMarkdown } from './output/markdown.js';
// import { saveReports } from './output/report.js';  // disabled — see comment in run()
import {
  AnalysisOptions, AnalysisResult, EarningsRevisions, LLMAnalysis,
  MarketSignals, NewsItem, OptionsSignals, SearchResult, StockFinancials,
  SearchTrace, SearchProviderTrace,
} from './types.js';
import {
  acceptedModels, DEFAULT_MODEL_ID, fullIdList, MODELS, providerFor, resolveModelId, shortcutList,
} from './models.js';

// ─── CLI Setup ───────────────────────────────────────────────────────────────

// Help text is derived from the model registry so `--help` can never drift
// from what `resolveModel` actually accepts.
const MODEL_HELP = (() => {
  const width = Math.max(...MODELS.map((m) => m.id.length));
  return [
    'Model to use — shortcut or full model ID:',
    ...MODELS.map((m) =>
      `  ${m.id.padEnd(width)}  ${m.resolved}${m.id === DEFAULT_MODEL_ID ? '  (default)' : ''}`),
    `  …or any full model ID: ${fullIdList()}`,
  ].join('\n');
})();

const program = new Command();

program
  .name('investment-cli')
  .description(
    'Fundamental stock analysis powered by LLMs\n\n' +
    'Fetches live financial data, runs 15 valuation models (DCF, Graham,\n' +
    'Piotroski, Altman Z, EPV, DDM, and more), then asks an LLM for a\n' +
    'structured bull/bear analysis.',
  )
  .version('1.0.0')
  .argument('[symbol]', 'Stock ticker symbol (e.g. NOW, AAPL, MSFT, NVDA, FACC). Mutually exclusive with --query.')
  .option('-q, --query <name>', 'Resolve by company name instead of ticker (e.g. "Siemens Energy")')
  .option('-m, --model <id>', MODEL_HELP, DEFAULT_MODEL_ID)
  .option(
    '-s, --search [type]',
    'Web search enrichment (omit value to use native search for the active model):\n' +
    `  claude        Claude built-in search  (requires --model ${acceptedModels('claude')})\n` +
    `  openai        OpenAI built-in search  (requires --model ${acceptedModels('openai')})\n` +
    '  brave         Brave Search API — recommended for daily use\n' +
    '  tavily        Tavily API\n' +
    '  none          No search (default)',
  )
  .option(
    '-o, --output <path>',
    'Save report — format from extension (.md or .json)',
  )
  .option(
    '--fetch [type]',
    'Download data without running LLM analysis.\n' +
    '  financials    Refresh market data cache\n' +
    '  submissions   Download SEC/EDGAR filings\n' +
    '  (omit value to fetch both)',
  )
  .option('--pplx', 'Enrich with Perplexity sonar (fast, cheap — requires PPLX_API_KEY, cached 12h)')
  .option('--pplx-pro', 'Enrich with Perplexity sonar-pro (better coverage, default when using Perplexity)')
  .option('-v, --verbose', 'Debug logging')
  .addHelpText('after', `
Examples:
  $ npx tsx src/cli.ts NOW
  $ npx tsx src/cli.ts --query "Siemens Energy"
  $ npx tsx src/cli.ts --query "Airbus" --search brave
  $ npx tsx src/cli.ts FACC --model claude --search brave
  $ npx tsx src/cli.ts AAPL --model claude --search          # native Claude search
  $ npx tsx src/cli.ts MSFT --model terra  --search          # native OpenAI search
  $ npx tsx src/cli.ts NVDA --model mini   --search brave
  $ npx tsx src/cli.ts NOW  --model luna   --search tavily
  $ npx tsx src/cli.ts NOW  --output report.md
  $ npx tsx src/cli.ts NVDA --model opus   --verbose
  $ npx tsx src/cli.ts AAPL --fetch                  # refresh financials + download filings
  $ npx tsx src/cli.ts AAPL --fetch financials        # refresh market data only
  $ npx tsx src/cli.ts AAPL --fetch submissions       # download SEC 10-K/10-Q/8-K
  $ npx tsx src/cli.ts AAPL --pplx                   # add Perplexity AI synthesis (12h cache)

Required API keys (set in .env):
  ANTHROPIC_API_KEY     for --model claude / opus / claude-*
  OPENAI_API_KEY        for --model terra / luna / mini / gpt-*
  FINNHUB_API_KEY       for news & peer data  (free tier: https://finnhub.io)
  BRAVE_API_KEY         for --search brave    (https://brave.com/search/api/)
  TAVILY_API_KEY        for --search tavily   (https://tavily.com)
  FRED_API_KEY          for live rates        (https://fred.stlouisfed.org — free)
`)
  .action(async (symbol: string | undefined, opts: Record<string, string | boolean>) => {
    try {
      if (!symbol && !opts.query) {
        console.error(chalk.red('Error: provide a ticker symbol or --query <company name>'));
        process.exit(1);
      }
      await run(symbol ? symbol.toUpperCase() : undefined, opts);
    } catch (err) {
      logger.error((err as Error).message);
      if (opts.verbose) console.error(err);
      process.exit(1);
    }
  });

// Only parse argv when this file is the entry point (not when imported by server.ts)
const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('cli.ts') ||
  process.argv[1].endsWith('cli.js')
);
if (invokedDirectly) program.parse();

// ─── Public API: runAnalysis ─────────────────────────────────────────────────

/** Stages emitted by runAnalysis() via onProgress callback. */
export type ProgressStage =
  | 'resolve' | 'financials' | 'rates' | 'sector-medians'
  | 'news' | 'perplexity' | 'market-signals' | 'metrics'
  | 'search' | 'llm' | 'edgar' | 'reports' | 'done';

export interface ProgressEvent {
  stage:    ProgressStage;
  message:  string;
  cached?:  boolean;
  /** Optional structured payload (e.g. summary stats) — kept loose. */
  data?:    Record<string, unknown>;
}

/** Structured input for a stock analysis (used by both CLI and HTTP server). */
export interface AnalysisRunInput {
  symbol?:    string;
  query?:     string;
  model:      string;                 // shortcut ('claude') or full model id
  /** Search providers — accepts:
   *   • single string: 'brave', 'tavily', 'claude', 'openai', 'none'
   *   • comma-separated: 'brave,tavily'
   *   • array: ['brave', 'tavily']
   * The list is normalised to a sorted, deduped joined string for the cache key. */
  search?:    string | string[];
  pplx?:      'sonar' | 'sonar-pro' | null;
  verbose?:   boolean;
  /**
   * Bypass the LLM cache and force a fresh call. The cached entry for this
   * flag combo (if any) gets *overwritten* with the new result. Used by the
   * web UI's "Re-run (without cache)" button — without this the analysis
   * would silently hit the still-valid cache (since we removed TTL gating)
   * and "Re-run" would be a no-op.
   */
  force?:     boolean;
  onProgress?: (event: ProgressEvent) => void;
}

/** Parse a search input (string | string[] | comma-separated) into a clean list. */
function parseSearchList(input: AnalysisRunInput['search']): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const out: string[] = [];
  for (const s of raw) {
    const t = s.trim().toLowerCase();
    if (!t || t === 'none') continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Stable, sorted, joined form for cache hashing. Empty list → 'none'. */
function searchKey(list: string[]): string {
  return list.length === 0 ? 'none' : [...list].sort().join(',');
}

/** Resolved high-level meta returned alongside the analysis result. */
export interface AnalysisRunMeta {
  symbol:        string;
  modelId:       string;
  searchUsed:    AnalysisOptions['search'];
  pplxUsed:      'sonar' | 'sonar-pro' | null;
  fromCache:     boolean;             // true when the LLM analysis was served from cache
  flagsHash:     string;
}

/**
 * Run the full analysis pipeline for a stock and return the structured result
 * + metadata. Reusable from the CLI and the HTTP server. Console output is
 * still emitted via the shared logger.
 */
export async function runAnalysis(input: AnalysisRunInput): Promise<{ result: AnalysisResult; meta: AnalysisRunMeta }> {
  if (input.verbose) process.env.LOG_LEVEL = 'debug';
  const emit = input.onProgress ?? (() => {});

  const { provider, modelId } = resolveModel(input.model);

  // Multi-select search resolution:
  //   - Parse input into a clean list (e.g. ['brave', 'tavily', 'claude'])
  //   - Validate native-search compatibility with the selected provider
  //   - Pick a single value for `options.search` (used by the LLM provider for
  //     native-search routing); always prefer the matching native option if
  //     present so the LLM can call its built-in web search.
  //   - External searches (Brave/Tavily) run independently before the LLM call.
  const requested = parseSearchList(input.search);
  if (provider !== 'claude' && requested.includes('claude')) {
    throw new Error(`search "claude" requires a Claude model (${acceptedModels('claude')})`);
  }
  if (provider !== 'openai' && (requested.includes('openai') || requested.includes('openai-tavily'))) {
    throw new Error(`search "openai" requires an OpenAI model (${acceptedModels('openai')})`);
  }
  // Resolve `options.search` (single value the provider sees):
  //   • 'openai' + 'tavily'  → 'openai-tavily' (special routing)
  //   • 'openai'             → 'openai'
  //   • 'claude'             → 'claude'
  //   • 'brave'/'tavily' alone → that value (no native search)
  //   • else                 → 'none'
  let optionsSearch: AnalysisOptions['search'] = 'none';
  if (requested.includes('openai-tavily')) optionsSearch = 'openai-tavily';
  else if (requested.includes('openai') && requested.includes('tavily')) optionsSearch = 'openai-tavily';
  else if (requested.includes('openai')) optionsSearch = 'openai';
  else if (requested.includes('claude')) optionsSearch = 'claude';
  else if (requested.includes('brave'))  optionsSearch = 'brave';
  else if (requested.includes('tavily')) optionsSearch = 'tavily';

  const options: AnalysisOptions = {
    provider, modelId, search: optionsSearch,
    cache:   true,
    output:  undefined,
    verbose: Boolean(input.verbose),
  };

  const cfg = getConfig();

  // ── 0. Resolve ticker → canonical Yahoo Finance symbol ───────────────────
  let symbol: string;
  if (input.query) {
    logger.step(`Searching for "${input.query}"...`);
    emit({ stage: 'resolve', message: `Searching for "${input.query}"…` });
    symbol = await searchByQuery(input.query);
  } else if (input.symbol) {
    emit({ stage: 'resolve', message: `Resolving symbol ${input.symbol}…` });
    symbol = await resolveSymbol(input.symbol);
  } else {
    throw new Error('runAnalysis requires either symbol or query');
  }
  emit({ stage: 'resolve', message: `Resolved → ${symbol}`, data: { symbol } });

  console.log(chalk.bold.white(`\n  Investment Analysis — ${symbol}\n`));
  logger.info(`Model: ${modelId}  |  Search: ${searchKey(requested)}`);

  // ── 1. Fetch Financials ───────────────────────────────────────────────────
  logger.step('Fetching market data...');

  let financials: StockFinancials | null = readFinancials(cfg.cacheDir, symbol);
  let financialsCached = !!financials;

  let bundleDailyBars: DailyBar[] | null = null;
  let bundleRevisions: EarningsRevisions | null = null;

  if (!financials) {
    emit({ stage: 'financials', message: 'Fetching financials from Yahoo + Finnhub…' });
    const [bundle, finnhubMetrics] = await Promise.all([
      getFinancials(symbol),
      cfg.finnhubApiKey ? getBasicFinancials(symbol, cfg.finnhubApiKey) : Promise.resolve(null),
    ]);

    if (finnhubMetrics) {
      bundle.financials.roic                 = finnhubMetrics.roic;
      bundle.financials.epsGrowth3Y          = finnhubMetrics.epsGrowth3Y;
      bundle.financials.dividendGrowthRate5Y = finnhubMetrics.dividendGrowthRate5Y;
    }

    financials       = bundle.financials;
    bundleDailyBars  = bundle.dailyBars;
    bundleRevisions  = bundle.revisions;
    writeFinancials(cfg.cacheDir, symbol, financials);
  }
  emit({ stage: 'financials', message: `${financials.companyName} · $${financials.price.toFixed(2)} · ${fmtBig(financials.marketCap)}`, cached: financialsCached });

  // ── 1b. News (cached 30 min) + Rates + Sector Medians + Perplexity ────────
  const usePplx   = input.pplx !== null && input.pplx !== undefined;
  const pplxModel: 'sonar' | 'sonar-pro' = input.pplx === 'sonar' ? 'sonar' : 'sonar-pro';
  // Distill is always-on when the key is configured — there's no per-run
  // toggle. The briefings are upstream-curated, so they're cheap to include
  // and consistently the highest-signal context block we can hand the LLM.
  const useDistill = !!cfg.distillApiKey;
  emit({ stage: 'rates', message: 'Fetching macro rates + news + sector medians'
    + (usePplx ? ' + Perplexity' : '')
    + (useDistill ? ' + Distill briefings' : '')
    + '…' });

  let news: NewsItem[] = readNews(cfg.cacheDir, symbol) ?? [];
  let perplexity = usePplx ? readPerplexity(cfg.cacheDir, symbol) : null;
  let distill: DistillBundle | null = useDistill ? readDistill(cfg.cacheDir, symbol) : null;

  const [freshNews, marketRates, sectorMedians, freshPerplexity, freshDistill] = await Promise.all([
    news.length === 0 && cfg.finnhubApiKey
      ? getNews(symbol, cfg.finnhubApiKey).catch((e) => {
          logger.warn(`News unavailable: ${(e as Error).message}`);
          return [] as NewsItem[];
        })
      : Promise.resolve(null),
    cfg.fredApiKey
      ? getMarketRates(cfg.fredApiKey)
      : Promise.resolve(null),
    cfg.finnhubApiKey
      ? getSectorMedians(symbol, cfg.finnhubApiKey).catch(() => null)
      : Promise.resolve(null),
    usePplx && !perplexity
      ? fetchPerplexity(symbol, financials.companyName, requireApiKey('perplexity'), pplxModel)
          .catch((e) => {
            logger.warn(`Perplexity unavailable: ${(e as Error).message}`);
            return null;
          })
      : Promise.resolve(null),
    useDistill && !distill
      ? fetchDistillBriefings(symbol, cfg.distillApiKey!, cfg.distillApiUrl, cfg.distillBriefingTypeId)
          .catch((e) => {
            logger.warn(`Distill unavailable: ${(e as Error).message}`);
            return null;
          })
      : Promise.resolve(null),
  ]);

  if (freshNews && freshNews.length > 0) {
    news = freshNews;
    writeNews(cfg.cacheDir, symbol, news);
  }
  if (freshPerplexity) {
    perplexity = freshPerplexity;
    writePerplexity(cfg.cacheDir, symbol, perplexity);
  }
  if (freshDistill) {
    distill = freshDistill;
    writeDistill(cfg.cacheDir, symbol, distill);
  }

  logger.success(`${financials.companyName}  $${financials.price.toFixed(2)}  ${fmtBig(financials.marketCap)}`);

  // ── 1c. Market Signals (technicals + revisions + options + macro) ────────
  let marketSignals: MarketSignals | null = readMarketSignals(cfg.cacheDir, symbol);

  if (!marketSignals) {
    logger.step('Computing market signals...');
    emit({ stage: 'market-signals', message: 'Computing technicals, options & macro…' });

    // If financials came from cache, daily bars + revisions weren't fetched yet.
    if (!bundleDailyBars || !bundleRevisions) {
      const refresh = await getFinancials(symbol);
      bundleDailyBars = refresh.dailyBars;
      bundleRevisions = refresh.revisions;
    }

    const [macro, optionsRaw] = await Promise.all([
      getMacroBundle(financials.sector, cfg.fredApiKey ?? null),
      getOptionsSignals({
        symbol,
        spot: financials.price,
        nextEarningsDate: financials.nextEarningsDate,
        hv90: null,
      }),
    ]);

    const technicals = computeTechnicals({
      bars:       bundleDailyBars,
      spyBars:    macro.spyBars,
      sectorBars: macro.sectorBars ?? undefined,
    });

    // Backfill IV/HV90 ratio now that hv90 is known.
    let options: OptionsSignals | null = optionsRaw;
    if (options && options.ivAtm30d !== null && technicals.hv90 !== null && technicals.hv90 > 0) {
      options = { ...options, ivVsHv90Ratio: options.ivAtm30d / technicals.hv90 };
    }

    marketSignals = {
      technicals,
      revisions: bundleRevisions,
      options,
      macro: macro.context,
    };
    writeMarketSignals(cfg.cacheDir, symbol, marketSignals);
    logger.success('Market signals ready');
  }

  // ── 2. Calculate All Metrics ──────────────────────────────────────────────
  logger.step('Running valuation models...');
  emit({ stage: 'metrics', message: 'Running 19 valuation models…' });
  const metrics = computeAllMetrics(financials, marketRates, sectorMedians);
  const {
    dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
    ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, rim, ncav,
    peerMultiples, interestCoverage, sortino, beneish, composite,
  } = metrics;
  logger.success('19 models calculated');
  emit({
    stage:   'metrics',
    message: `Composite fair value: ${composite.median ? '$' + composite.median.toFixed(2) : 'N/A'} across ${composite.contributingModels.length} models`,
    data:    { compositeMedian: composite.median, contributingCount: composite.contributingModels.length },
  });

  // ── 3. Optional Web Search (multi-provider — run all selected externals) ─
  let searchResults: SearchResult[] = [];
  // Trace of every provider invocation — gets persisted alongside the LLM
  // verdict so the web UI's Research & News section can show what each engine
  // returned (debug / provenance / sanity-check the LLM's input).
  const searchTrace: SearchProviderTrace[] = [];
  const name = financials.companyName;
  const year = new Date().getFullYear();
  const queries = [
    `${name} stock analysis ${year}`,
    `${name} earnings outlook`,
    `${name} analyst rating price target`,
  ];
  // Brave and Tavily can both be requested at once; merge their results.
  const wantsTavily = requested.includes('tavily') || requested.includes('openai-tavily');
  const wantsBrave  = requested.includes('brave');
  if (wantsTavily) {
    emit({ stage: 'search', message: 'Running Tavily web search…' });
    logger.step('Running Tavily web search...');
    const tav = await new TavilySearch(requireApiKey('tavily')).searchMultiple(queries);
    searchResults.push(...tav);
    searchTrace.push({
      provider: 'tavily', queries, results: tav, fetchedAt: new Date().toISOString(),
    });
    logger.success(`${tav.length} Tavily results`);
    emit({ stage: 'search', message: `${tav.length} Tavily results` });
  }
  if (wantsBrave) {
    emit({ stage: 'search', message: 'Running Brave web search…' });
    logger.step('Running Brave web search...');
    const br = await new BraveSearch(requireApiKey('brave')).searchMultiple(queries);
    searchResults.push(...br);
    searchTrace.push({
      provider: 'brave', queries, results: br, fetchedAt: new Date().toISOString(),
    });
    logger.success(`${br.length} Brave results`);
    emit({ stage: 'search', message: `${br.length} Brave results` });
  }

  // ── 4. LLM Analysis + EDGAR (run in parallel) ────────────────────────────
  const flags: AnalysisFlagsKey = {
    model:  modelId,
    search: searchKey(requested),
    pplx:   usePplx ? pplxModel : null,
  };
  // Honour `force` — caller explicitly asked for a fresh LLM call. We still
  // call readAnalysis for symmetry/debug but discard the result.
  const cachedAnalysis = input.force ? null : readAnalysis(cfg.cacheDir, symbol, flags);
  let llmAnalysis: LLMAnalysis | null = cachedAnalysis?.llmAnalysis ?? null;
  const llmFromCache = llmAnalysis !== null;

  const edgarNeeded = !readSubmissions(cfg.cacheDir, symbol);

  if (!llmAnalysis) {
    emit({ stage: 'llm', message: `Calling ${modelId}…`, cached: false });
    const llm    = createProvider(options);
    const prompt = buildAnalysisPrompt(financials, {
      dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
      ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, interestCoverage,
      sortino, beneish, rim, ncav, peerMultiples, composite,
      sectorMedians, marketSignals,
    }, perplexity ?? undefined, distill ?? undefined);
    const [analysis] = await Promise.all([
      llm.analyze(prompt, searchResults),
      // EDGAR is a non-essential sidecar — never let its failure reject the
      // Promise.all and throw away the (paid-for) LLM result.
      edgarNeeded
        ? fetchEdgarFilings(symbol, cfg.cacheDir).catch((e) => {
            logger.warn(`EDGAR filings unavailable: ${(e as Error).message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    llmAnalysis = analysis;

    // After analyze() returns, query the provider for any native-search
    // queries it issued (Claude / OpenAI built-in web search). The actual
    // URLs the LLM fetched are processed server-side by the vendor and not
    // observable here — the queries are the best breadcrumb we have.
    const nativeQueries = llm.getNativeSearchQueries();
    if (nativeQueries.length > 0) {
      const nativeProvider: 'claude-web-search' | 'openai-web-search' =
        llm.name === 'openai' ? 'openai-web-search' : 'claude-web-search';
      searchTrace.push({
        provider:  nativeProvider,
        queries:   nativeQueries,
        results:   [],  // not exposed by the LLM SDK
        fetchedAt: new Date().toISOString(),
      });
    }

    const trace: SearchTrace | undefined = searchTrace.length > 0
      ? { providers: searchTrace }
      : undefined;
    writeAnalysis(cfg.cacheDir, symbol, flags, llmAnalysis, trace);
    logger.success('LLM analysis complete');
    emit({
      stage:   'llm',
      message: `${analysis.recommendation} · score ${analysis.score}/10 · fair value ${analysis.fairValueEstimate}`,
      data:    { recommendation: analysis.recommendation, score: analysis.score },
    });
  } else {
    if (edgarNeeded) {
      await fetchEdgarFilings(symbol, cfg.cacheDir).catch((e) =>
        logger.warn(`EDGAR filings unavailable: ${(e as Error).message}`));
    }
    logger.success('LLM analysis loaded from cache');
    emit({ stage: 'llm', message: 'LLM analysis loaded from cache', cached: true });
  }

  // ── 5. Assemble Result ────────────────────────────────────────────────────
  const result: AnalysisResult = {
    symbol, timestamp: new Date().toISOString(),
    provider: options.modelId, searchProvider: options.search,
    financials, dcf, grahamNumber, ratios,
    reverseDCF, peterLynch, evMultiples, ruleOf40, grahamRevised,
    piotroski, altmanZ, ddm, epv, rim, ncav, peerMultiples, composite,
    interestCoverage,
    sortino, beneish, sectorMedians,
    marketSignals,
    llmAnalysis: llmAnalysis!, news,
    perplexity: perplexity ?? null,
  };

  const meta: AnalysisRunMeta = {
    symbol,
    modelId,
    searchUsed: optionsSearch,
    pplxUsed:   usePplx ? pplxModel : null,
    fromCache:  llmFromCache,
    flagsHash:  analysisHash(flags),
  };
  emit({ stage: 'done', message: 'Analysis complete', data: { fromCache: llmFromCache } });

  return { result, meta };
}

// ─── CLI Wrapper (calls runAnalysis + handles --output / --fetch / report writing) ─

async function run(rawSymbol: string | undefined, opts: Record<string, string | boolean | undefined>): Promise<void> {
  if (opts.verbose) process.env.LOG_LEVEL = 'debug';

  const cfg = getConfig();

  // ── --fetch mode: download data only, skip LLM ───────────────────────────
  const fetchRaw  = opts.fetch;
  type FetchMode  = 'financials' | 'submissions' | 'all' | false;
  const fetchMode: FetchMode = fetchRaw === true ? 'all'
    : fetchRaw === 'financials'   ? 'financials'
    : fetchRaw === 'submissions'  ? 'submissions'
    : false;

  if (fetchMode) {
    const symbol = opts.query
      ? await searchByQuery(String(opts.query))
      : await resolveSymbol(rawSymbol!);
    if (fetchMode === 'financials' || fetchMode === 'all') {
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
    }
    if (fetchMode === 'submissions' || fetchMode === 'all') {
      await fetchEdgarFilings(symbol, cfg.cacheDir);
    }
    logger.success(`Data saved → ${symbolDir(cfg.cacheDir, symbol)}`);
    return;
  }

  // ── Normal analysis flow ─────────────────────────────────────────────────
  const pplx: 'sonar' | 'sonar-pro' | null = opts.pplx && !opts.pplxPro
    ? 'sonar'
    : (opts.pplx || opts.pplxPro) ? 'sonar-pro' : null;

  console.log(chalk.bold.white(`\n  Investment Analysis — ${rawSymbol ?? opts.query}\n`));

  const { result } = await runAnalysis({
    symbol:  rawSymbol,
    query:   opts.query as string | undefined,
    model:   String(opts.model ?? 'claude'),
    search:  opts.search as string | undefined,
    pplx,
    verbose: Boolean(opts.verbose),
  });

  const isJson = typeof opts.output === 'string' && opts.output.endsWith('.json');
  const output = isJson ? JSON.stringify(result, null, 2) : formatMarkdown(result);

  console.log('\n' + output);

  if (typeof opts.output === 'string') {
    writeFileSync(opts.output, output, 'utf-8');
    logger.success(`Saved to ${opts.output}`);
  }

  // Markdown/HTML/PDF report generation (saveReports) intentionally skipped —
  // PDF via puppeteer adds 5–10s per analysis with little benefit when the
  // web UI is the primary consumer. Pass --output report.md if you need a
  // standalone file, or call saveReports() manually from a script.
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveModel(input: string): { provider: AnalysisOptions['provider']; modelId: string } {
  const provider = providerFor(input);
  if (!provider) {
    throw new Error(
      `Unknown model "${input}".\n` +
      `  Shortcuts:  ${shortcutList()}\n` +
      `  Full IDs:   ${fullIdList()}`,
    );
  }
  return { provider, modelId: resolveModelId(input) };
}

