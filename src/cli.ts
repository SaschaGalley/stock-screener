#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';

import { getConfig, requireApiKey } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials } from './data/yfinance.js';
import { getNews, getBasicFinancials, getSectorMedians } from './data/finnhub.js';
import {
  calculateDCF, calculateGraham, calculateRatios,
  calculateReverseDCF, calculatePeterLynch, calculateEVMultiples,
  calculateRuleOf40, calculateGrahamRevised, calculatePiotroski,
  calculateAltmanZ, calculateDDM, calculateEPV, calculateInterestCoverage,
  calculateSortino, calculateBeneish,
  fmtBig,
} from './analysis/metrics.js';
import { createProvider } from './providers/factory.js';
import { TavilySearch } from './search/tavily.js';
import { BraveSearch } from './search/brave.js';
import { readCache, writeCache } from './cache.js';
import { getMarketRates } from './data/fred.js';
import { buildAnalysisPrompt } from './output/prompt.js';
import { formatMarkdown } from './output/markdown.js';
import { AnalysisOptions, AnalysisResult, SearchResult } from './types.js';

// ─── CLI Setup ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('investment-cli')
  .description(
    'Fundamental stock analysis powered by LLMs\n\n' +
    'Fetches live financial data, runs 13 valuation models (DCF, Graham,\n' +
    'Piotroski, Altman Z, EPV, DDM, and more), then asks an LLM for a\n' +
    'structured bull/bear analysis.',
  )
  .version('1.0.0')
  .argument('<symbol>', 'Stock ticker symbol (e.g. NOW, AAPL, MSFT, NVDA)')
  .option(
    '-m, --model <type>',
    'LLM provider\n  anthropic  Claude (claude-sonnet-4-6) — recommended\n  openai     GPT-4 Turbo\n  gemini     Gemini 1.5 Pro',
    'anthropic',
  )
  .option(
    '-s, --search <type>',
    'Web search enrichment\n  none           No web search (default)\n  claude-native  Claude built-in search (requires --model anthropic)\n  brave          Brave Search API — fresh results, free tier (recommended)\n  tavily         Tavily API (works with any model)\n  openai-tavily  Tavily injected into OpenAI prompt',
    'none',
  )
  .option(
    '-o, --output <path>',
    'Save report — format from extension (.md or .json)',
  )
  .option('-c, --cache <setting>', 'Financial data cache: enable | disable', 'enable')
  .option('-v, --verbose', 'Debug logging')
  .addHelpText('after', `
Examples:
  $ npx tsx src/cli.ts NOW
  $ npx tsx src/cli.ts AAPL --model openai
  $ npx tsx src/cli.ts MSFT --model anthropic --search claude-native
  $ npx tsx src/cli.ts NOW  --search tavily --output report.md
  $ npx tsx src/cli.ts NVDA --model gemini  --verbose

Required API keys (set in .env):
  ANTHROPIC_API_KEY     for --model anthropic (default)
  OPENAI_API_KEY        for --model openai
  GOOGLE_GEMINI_API_KEY for --model gemini
  FINNHUB_API_KEY       for news data  (free tier: https://finnhub.io)
  BRAVE_API_KEY         for web search (free tier: https://brave.com/search/api/)
  TAVILY_API_KEY        for web search (free tier: https://tavily.com)
`)
  .action(async (symbol: string, opts: Record<string, string | boolean>) => {
    try {
      await run(symbol.toUpperCase(), opts);
    } catch (err) {
      logger.error((err as Error).message);
      if (opts.verbose) console.error(err);
      process.exit(1);
    }
  });

program.parse();

// ─── Main Flow ───────────────────────────────────────────────────────────────

async function run(symbol: string, opts: Record<string, string | boolean>): Promise<void> {
  if (opts.verbose) process.env.LOG_LEVEL = 'debug';

  const options: AnalysisOptions = {
    model:   (opts.model  as AnalysisOptions['model'])  ?? 'anthropic',
    search:  normalizeSearch(opts.search as string, opts.model as string),
    cache:   opts.cache !== 'disable',
    output:  opts.output as string | undefined,
    verbose: Boolean(opts.verbose),
  };

  validateOptions(options);
  const cfg = getConfig();

  console.log(chalk.bold.white(`\n  Investment Analysis — ${symbol}\n`));
  logger.info(`Provider: ${options.model}  |  Search: ${options.search}`);

  // ── 1. Fetch Financials (with cache) ─────────────────────────────────────
  logger.step('Fetching market data...');

  let financials = options.cache ? readCache(cfg.cacheDir, symbol) : null;

  if (!financials) {
    const [fresh, finnhubMetrics] = await Promise.all([
      getFinancials(symbol),
      cfg.finnhubApiKey ? getBasicFinancials(symbol, cfg.finnhubApiKey) : Promise.resolve(null),
    ]);

    if (finnhubMetrics) {
      fresh.roic                 = finnhubMetrics.roic;
      fresh.epsGrowth3Y          = finnhubMetrics.epsGrowth3Y;
      fresh.dividendGrowthRate5Y = finnhubMetrics.dividendGrowthRate5Y;
    }

    financials = fresh;
    if (options.cache) writeCache(cfg.cacheDir, symbol, financials);
  }

  // Rates + news + peer data are always live (not cached)
  const [news, marketRates, sectorMedians] = await Promise.all([
    cfg.finnhubApiKey
      ? getNews(symbol, cfg.finnhubApiKey).catch((e) => {
          logger.warn(`News unavailable: ${(e as Error).message}`);
          return [];
        })
      : Promise.resolve([]),
    cfg.fredApiKey
      ? getMarketRates(cfg.fredApiKey)
      : Promise.resolve(null),
    cfg.finnhubApiKey
      ? getSectorMedians(symbol, cfg.finnhubApiKey).catch(() => null)
      : Promise.resolve(null),
  ]);

  logger.success(`${financials.companyName}  $${financials.price.toFixed(2)}  ${fmtBig(financials.marketCap)}`);

  // ── 2. Calculate All Metrics ──────────────────────────────────────────────
  logger.step('Running valuation models...');
  const dcf              = calculateDCF(financials);
  const grahamNumber     = calculateGraham(financials);
  const ratios           = calculateRatios(financials);
  const reverseDCF       = calculateReverseDCF(financials);
  const peterLynch       = calculatePeterLynch(financials);
  const evMultiples      = calculateEVMultiples(financials);
  const ruleOf40         = calculateRuleOf40(financials);
  const grahamRevised    = calculateGrahamRevised(financials, marketRates?.aaaBondYield);
  const piotroski        = calculatePiotroski(financials);
  const altmanZ          = calculateAltmanZ(financials);
  const ddm              = calculateDDM(financials, marketRates?.riskFreeRate);
  const epv              = calculateEPV(financials);
  const interestCoverage = calculateInterestCoverage(financials);
  const sortino          = calculateSortino(financials, marketRates?.riskFreeRate);
  const beneish          = calculateBeneish(financials);
  logger.success('15 models calculated');

  // ── 3. Optional Web Search ────────────────────────────────────────────────
  let searchResults: SearchResult[] = [];
  if (options.search === 'tavily' || options.search === 'openai-tavily') {
    const searcher = new TavilySearch(requireApiKey('tavily'));
    logger.step('Running Tavily web search...');
    searchResults = await searcher.searchMultiple([
      `${symbol} stock analysis 2025`,
      `${financials.companyName} earnings outlook`,
      `${symbol} analyst rating price target`,
    ]);
    logger.success(`${searchResults.length} search results`);
  } else if (options.search === 'brave') {
    const searcher = new BraveSearch(requireApiKey('brave'));
    logger.step('Running Brave web search...');
    searchResults = await searcher.searchMultiple([
      `${symbol} stock analysis ${new Date().getFullYear()}`,
      `${financials.companyName} earnings outlook`,
      `${symbol} analyst rating price target`,
    ]);
    logger.success(`${searchResults.length} search results`);
  }

  // ── 4. LLM Analysis ───────────────────────────────────────────────────────
  const provider = createProvider(options);
  const prompt = buildAnalysisPrompt(financials, {
    dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
    ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, interestCoverage,
    sortino, beneish, sectorMedians, news,
  });

  const llmAnalysis = await provider.analyze(prompt, searchResults);
  logger.success('LLM analysis complete');

  // ── 5. Assemble & Output ──────────────────────────────────────────────────
  const result: AnalysisResult = {
    symbol, timestamp: new Date().toISOString(),
    provider: options.model, searchProvider: options.search,
    financials, dcf, grahamNumber, ratios,
    reverseDCF, peterLynch, evMultiples, ruleOf40, grahamRevised,
    piotroski, altmanZ, ddm, epv, interestCoverage,
    sortino, beneish, sectorMedians,
    llmAnalysis, news,
  };

  const isJson = options.output?.endsWith('.json');
  const output = isJson ? JSON.stringify(result, null, 2) : formatMarkdown(result);

  console.log('\n' + output);

  if (options.output) {
    writeFileSync(options.output, output, 'utf-8');
    logger.success(`Saved to ${options.output}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSearch(search: string, model: string): AnalysisOptions['search'] {
  if (!search || search === 'none') return 'none';
  if (search === 'openai-tavily') return 'openai-tavily';
  if (search === 'claude-native') return 'claude-native';
  if (search === 'brave') return 'brave';
  if (search === 'tavily') return model === 'openai' ? 'openai-tavily' : 'tavily';
  return 'none';
}

function validateOptions(options: AnalysisOptions): void {
  if (options.search === 'claude-native' && options.model !== 'anthropic') {
    throw new Error('--search claude-native requires --model anthropic');
  }
  const valid = ['anthropic', 'openai', 'gemini'];
  if (!valid.includes(options.model)) {
    throw new Error(`Invalid model: ${options.model}. Choose from: ${valid.join(', ')}`);
  }
}
