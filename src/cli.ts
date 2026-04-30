#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';

import { getConfig, requireApiKey } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials, resolveSymbol } from './data/yfinance.js';
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
  .argument('<symbol>', 'Stock ticker symbol (e.g. NOW, AAPL, MSFT, NVDA, FACC)')
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
  .option('-c, --cache <setting>', 'Financial data cache: enable | disable', 'enable')
  .option('-v, --verbose', 'Debug logging')
  .addHelpText('after', `
Examples:
  $ npx tsx src/cli.ts NOW
  $ npx tsx src/cli.ts FACC --model claude --search brave
  $ npx tsx src/cli.ts AAPL --model claude --search          # native Claude search
  $ npx tsx src/cli.ts MSFT --model openai --search          # native OpenAI search
  $ npx tsx src/cli.ts NVDA --model haiku  --search brave
  $ npx tsx src/cli.ts NOW  --model gpt-5.4 --search tavily
  $ npx tsx src/cli.ts NOW  --output report.md
  $ npx tsx src/cli.ts NVDA --model gemini --verbose

Required API keys (set in .env):
  ANTHROPIC_API_KEY     for --model claude / haiku / opus / claude-*
  OPENAI_API_KEY        for --model openai / gpt-*
  GOOGLE_GEMINI_API_KEY for --model gemini / gemini-*
  FINNHUB_API_KEY       for news & peer data  (free tier: https://finnhub.io)
  BRAVE_API_KEY         for --search brave    (https://brave.com/search/api/)
  TAVILY_API_KEY        for --search tavily   (https://tavily.com)
  FRED_API_KEY          for live rates        (https://fred.stlouisfed.org — free)
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

async function run(symbol: string, opts: Record<string, string | boolean | undefined>): Promise<void> {
  if (opts.verbose) process.env.LOG_LEVEL = 'debug';

  const { provider, modelId } = resolveModel(String(opts.model ?? 'claude'));
  const search = normalizeSearch(opts.search, provider);
  validateSearch(search, provider);

  const options: AnalysisOptions = {
    provider, modelId, search,
    cache:   opts.cache !== 'disable',
    output:  opts.output as string | undefined,
    verbose: Boolean(opts.verbose),
  };

  const cfg = getConfig();

  // ── 0. Resolve ticker → canonical Yahoo Finance symbol ───────────────────
  symbol = await resolveSymbol(symbol);

  console.log(chalk.bold.white(`\n  Investment Analysis — ${symbol}\n`));
  logger.info(`Model: ${modelId}  |  Search: ${search}`);

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

  // ── 4. LLM Analysis ───────────────────────────────────────────────────────
  const llm = createProvider(options);
  const prompt = buildAnalysisPrompt(financials, {
    dcf, grahamNumber, ratios, reverseDCF, peterLynch, evMultiples,
    ruleOf40, grahamRevised, piotroski, altmanZ, ddm, epv, interestCoverage,
    sortino, beneish, sectorMedians, news,
  });

  const llmAnalysis = await llm.analyze(prompt, searchResults);
  logger.success('LLM analysis complete');

  // ── 5. Assemble & Output ──────────────────────────────────────────────────
  const result: AnalysisResult = {
    symbol, timestamp: new Date().toISOString(),
    provider: options.modelId, searchProvider: options.search,
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
