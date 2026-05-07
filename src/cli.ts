#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';

import { getConfig, requireApiKey } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, getOptionsSignals, resolveSymbol, searchByQuery } from './data/yfinance.js';
import { getNews, getBasicFinancials, getSectorMedians } from './data/finnhub.js';
import {
  calculateDCF, calculateGraham, calculateRatios,
  calculateReverseDCF, calculatePeterLynch, calculateEVMultiples,
  calculateRuleOf40, calculateGrahamRevised, calculatePiotroski,
  calculateAltmanZ, calculateDDM, calculateEPV, calculateInterestCoverage,
  calculateSortino, calculateBeneish,
  calculateRIM, calculateNCAV, calculatePeerMultiples, calculateCompositeFairValue,
  fmtBig,
} from './analysis/metrics.js';
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
  readSubmissions,   symbolDir,
} from './cache.js';
import { fetchEdgarFilings } from './data/edgar.js';
import { getMarketRates } from './data/fred.js';
import { getMacroBundle } from './data/macro.js';
import { fetchPerplexity } from './data/perplexity.js';
import { buildAnalysisPrompt } from './output/prompt.js';
import { formatMarkdown } from './output/markdown.js';
import { saveReports } from './output/report.js';
import {
  AnalysisOptions, AnalysisResult, EarningsRevisions, LLMAnalysis,
  MarketSignals, NewsItem, OptionsSignals, SearchResult, StockFinancials,
} from './types.js';

// ─── Model defaults ───────────────────────────────────────────────────────────

const CLAUDE_DEFAULT = 'claude-sonnet-4-6';
const OPENAI_DEFAULT = 'gpt-5.4-mini';
const GEMINI_DEFAULT = 'gemini-1.5-pro';

// ─── CLI Setup ───────────────────────────────────────────────────────────────

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
  .option(
    '-m, --model <id>',
    'Model to use — shortcut or full model ID:\n' +
    '  claude          Claude Sonnet 4.6 (default)\n' +
    '  openai          GPT default model\n' +
    '  gemini          Gemini 1.5 Pro\n' +
    '  haiku           claude-haiku-4-5-20251001\n' +
    '  opus            claude-opus-4-7\n' +
    '  gpt-5.4         any OpenAI model ID\n' +
    '  claude-opus-4-7 any Claude model ID',
    'claude',
  )
  .option(
    '-s, --search [type]',
    'Web search enrichment (omit value to use native search for the active model):\n' +
    '  claude        Claude built-in search  (requires --model claude/*)\n' +
    '  openai        OpenAI built-in search  (requires --model openai/gpt-*)\n' +
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
  $ npx tsx src/cli.ts MSFT --model openai --search          # native OpenAI search
  $ npx tsx src/cli.ts NVDA --model haiku  --search brave
  $ npx tsx src/cli.ts NOW  --model gpt-5.4 --search tavily
  $ npx tsx src/cli.ts NOW  --output report.md
  $ npx tsx src/cli.ts NVDA --model gemini --verbose
  $ npx tsx src/cli.ts AAPL --fetch                  # refresh financials + download filings
  $ npx tsx src/cli.ts AAPL --fetch financials        # refresh market data only
  $ npx tsx src/cli.ts AAPL --fetch submissions       # download SEC 10-K/10-Q/8-K
  $ npx tsx src/cli.ts AAPL --pplx                   # add Perplexity AI synthesis (12h cache)

Required API keys (set in .env):
  ANTHROPIC_API_KEY     for --model claude / haiku / opus / claude-*
  OPENAI_API_KEY        for --model openai / gpt-*
  GOOGLE_GEMINI_API_KEY for --model gemini / gemini-*
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

program.parse();

// ─── Main Flow ───────────────────────────────────────────────────────────────

async function run(rawSymbol: string | undefined, opts: Record<string, string | boolean | undefined>): Promise<void> {
  if (opts.verbose) process.env.LOG_LEVEL = 'debug';

  const { provider, modelId } = resolveModel(String(opts.model ?? 'claude'));
  const search = normalizeSearch(opts.search, provider);
  validateSearch(search, provider);

  const fetchRaw  = opts.fetch;
  type FetchMode  = 'financials' | 'submissions' | 'all' | false;
  const fetchMode: FetchMode = fetchRaw === true ? 'all'
    : fetchRaw === 'financials'   ? 'financials'
    : fetchRaw === 'submissions'  ? 'submissions'
    : false;

  const options: AnalysisOptions = {
    provider, modelId, search,
    cache:   true,
    output:  opts.output as string | undefined,
    verbose: Boolean(opts.verbose),
  };

  const cfg = getConfig();

  // ── 0. Resolve ticker → canonical Yahoo Finance symbol ───────────────────
  let symbol: string;
  if (opts.query) {
    logger.step(`Searching for "${opts.query}"...`);
    symbol = await searchByQuery(String(opts.query));
  } else {
    symbol = await resolveSymbol(rawSymbol!);
  }

  console.log(chalk.bold.white(`\n  Investment Analysis — ${symbol}\n`));
  logger.info(`Model: ${modelId}  |  Search: ${search}`);

  // ── 1. Fetch Financials ───────────────────────────────────────────────────
  logger.step('Fetching market data...');

  const bypassFinancials = fetchMode === 'financials' || fetchMode === 'all';
  let financialsCached   = false;
  let financials: StockFinancials | null = bypassFinancials ? null : readFinancials(cfg.cacheDir, symbol);

  // Daily bars + revisions live alongside StockFinancials in the bundle from getFinancials.
  // When financials is cache-hit, we don't have them yet — refetch lazily below if marketSignals is missing.
  let bundleDailyBars: DailyBar[] | null = null;
  let bundleRevisions: EarningsRevisions | null = null;

  if (financials) {
    financialsCached = true;
  } else {
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

  // ── 1a. Fetch mode: download only, skip LLM ──────────────────────────────
  if (fetchMode) {
    if (fetchMode === 'submissions' || fetchMode === 'all') {
      await fetchEdgarFilings(symbol, cfg.cacheDir);
    }
    logger.success(`Data saved → ${symbolDir(cfg.cacheDir, symbol)}`);
    return;
  }

  // ── 1b. News (cached 30 min) + Rates + Sector Medians + Perplexity ────────
  const usePplx   = Boolean(opts.pplx) || Boolean(opts.pplxPro);
  const pplxModel: 'sonar' | 'sonar-pro' = opts.pplx && !opts.pplxPro ? 'sonar' : 'sonar-pro';

  let news: NewsItem[] = readNews(cfg.cacheDir, symbol) ?? [];
  let perplexity = usePplx ? readPerplexity(cfg.cacheDir, symbol) : null;

  const [freshNews, marketRates, sectorMedians, freshPerplexity] = await Promise.all([
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
  ]);

  if (freshNews && freshNews.length > 0) {
    news = freshNews;
    writeNews(cfg.cacheDir, symbol, news);
  }
  if (freshPerplexity) {
    perplexity = freshPerplexity;
    writePerplexity(cfg.cacheDir, symbol, perplexity);
  }

  logger.success(`${financials.companyName}  $${financials.price.toFixed(2)}  ${fmtBig(financials.marketCap)}`);

  // ── 1c. Market Signals (technicals + revisions + options + macro) ────────
  let marketSignals: MarketSignals | null = readMarketSignals(cfg.cacheDir, symbol);

  if (!marketSignals) {
    logger.step('Computing market signals...');

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
  const rates = marketRates ?? undefined;
  const dcf              = calculateDCF(financials, rates);
  const grahamNumber     = calculateGraham(financials);
  const ratios           = calculateRatios(financials);
  const reverseDCF       = calculateReverseDCF(financials, rates);
  const peterLynch       = calculatePeterLynch(financials);
  const evMultiples      = calculateEVMultiples(financials);
  const ruleOf40         = calculateRuleOf40(financials);
  const grahamRevised    = calculateGrahamRevised(financials, marketRates?.aaaBondYield);
  const piotroski        = calculatePiotroski(financials);
  const altmanZ          = calculateAltmanZ(financials);
  const ddm              = calculateDDM(financials, marketRates?.riskFreeRate);
  const epv              = calculateEPV(financials, rates);
  const rim              = calculateRIM(financials, rates);
  const ncav             = calculateNCAV(financials);
  const peerMultiples    = calculatePeerMultiples(financials, sectorMedians);
  const interestCoverage = calculateInterestCoverage(financials);
  const sortino          = calculateSortino(financials, marketRates?.riskFreeRate);
  const beneish          = calculateBeneish(financials);
  const composite        = calculateCompositeFairValue(financials, {
    dcf, graham: grahamNumber, grahamRevised, peterLynch, ddm, epv, rim,
    peerMultiples, beneish,
  });
  logger.success('19 models calculated');

  // ── 3. Optional Web Search ────────────────────────────────────────────────
  let searchResults: SearchResult[] = [];
  const name = financials.companyName;
  const year = new Date().getFullYear();
  if (options.search === 'tavily' || options.search === 'openai-tavily') {
    const searcher = new TavilySearch(requireApiKey('tavily'));
    logger.step('Running Tavily web search...');
    searchResults = await searcher.searchMultiple([
      `${name} stock analysis ${year}`,
      `${name} earnings outlook`,
      `${name} analyst rating price target`,
    ]);
    logger.success(`${searchResults.length} search results`);
  } else if (options.search === 'brave') {
    const searcher = new BraveSearch(requireApiKey('brave'));
    logger.step('Running Brave web search...');
    searchResults = await searcher.searchMultiple([
      `${name} stock analysis ${year}`,
      `${name} earnings outlook`,
      `${name} analyst rating price target`,
    ]);
    logger.success(`${searchResults.length} search results`);
  }

  // ── 4. LLM Analysis + EDGAR (run in parallel) ────────────────────────────
  const canUseAnalysisCache = financialsCached && search === 'none' && !usePplx;
  let llmAnalysis: LLMAnalysis | null = canUseAnalysisCache
    ? readAnalysis(cfg.cacheDir, symbol)
    : null;

  const edgarNeeded = !readSubmissions(cfg.cacheDir, symbol);

  if (!llmAnalysis) {
    const llm    = createProvider(options);
    const prompt = buildAnalysisPrompt(financials, {
      dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
      ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, interestCoverage,
      sortino, beneish, rim, ncav, peerMultiples, composite,
      sectorMedians, news, marketSignals,
    }, perplexity ?? undefined);
    const [analysis] = await Promise.all([
      llm.analyze(prompt, searchResults),
      edgarNeeded ? fetchEdgarFilings(symbol, cfg.cacheDir) : Promise.resolve(null),
    ]);
    llmAnalysis = analysis;
    writeAnalysis(cfg.cacheDir, symbol, llmAnalysis);
    logger.success('LLM analysis complete');
  } else {
    if (edgarNeeded) await fetchEdgarFilings(symbol, cfg.cacheDir);
    logger.success('LLM analysis loaded from cache');
  }

  // ── 5. Assemble & Output ──────────────────────────────────────────────────
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

  const isJson = options.output?.endsWith('.json');
  const output = isJson ? JSON.stringify(result, null, 2) : formatMarkdown(result);

  console.log('\n' + output);

  if (options.output) {
    writeFileSync(options.output, output, 'utf-8');
    logger.success(`Saved to ${options.output}`);
  }

  await saveReports(symbol, cfg.cacheDir, formatMarkdown(result));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveModel(input: string): { provider: AnalysisOptions['provider']; modelId: string } {
  const l = input.toLowerCase();
  if (l === 'claude' || l === 'sonnet') return { provider: 'claude', modelId: CLAUDE_DEFAULT };
  if (l === 'haiku')  return { provider: 'claude', modelId: 'claude-haiku-4-5-20251001' };
  if (l === 'opus')   return { provider: 'claude', modelId: 'claude-opus-4-7' };
  if (l.startsWith('claude-')) return { provider: 'claude', modelId: input };
  if (l === 'openai') return { provider: 'openai', modelId: OPENAI_DEFAULT };
  if (/^(gpt|o1|o3|o4)/.test(l)) return { provider: 'openai', modelId: input };
  if (l === 'gemini') return { provider: 'gemini', modelId: GEMINI_DEFAULT };
  if (l.startsWith('gemini-')) return { provider: 'gemini', modelId: input };
  throw new Error(
    `Unknown model "${input}".\n` +
    `  Shortcuts:  claude | openai | gemini | haiku | opus | sonnet\n` +
    `  Full IDs:   claude-* | gpt-* | o1-* | gemini-*`,
  );
}

function normalizeSearch(
  raw: string | boolean | undefined,
  provider: AnalysisOptions['provider'],
): AnalysisOptions['search'] {
  // --search without a value: use native search for the current provider
  if (raw === true) {
    if (provider === 'claude') return 'claude';
    if (provider === 'openai') return 'openai';
    return 'none';
  }
  if (!raw || raw === 'none') return 'none';
  if (raw === 'claude') return 'claude';
  if (raw === 'openai') return 'openai';
  if (raw === 'brave')  return 'brave';
  if (raw === 'openai-tavily') return 'openai-tavily';
  if (raw === 'tavily') return provider === 'openai' ? 'openai-tavily' : 'tavily';
  return 'none';
}

function validateSearch(search: AnalysisOptions['search'], provider: AnalysisOptions['provider']): void {
  if (search === 'claude' && provider !== 'claude') {
    throw new Error('--search claude requires a Claude model (--model claude | haiku | opus | claude-*)');
  }
  if (search === 'openai' && provider !== 'openai') {
    throw new Error('--search openai requires an OpenAI model (--model openai | gpt-* | o1-* | o3-*)');
  }
}
