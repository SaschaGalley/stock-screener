#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';

import { getConfig, requireApiKey } from './config.js';
import { logger } from './utils/logger.js';
import { getFinancials } from './data/yfinance.js';
import { getNews } from './data/finnhub.js';
import { calculateDCF, calculateGraham, calculateRatios, fmt, fmtPct, fmtBig } from './analysis/metrics.js';
import { createProvider } from './providers/factory.js';
import { TavilySearch } from './search/tavily.js';
import { AnalysisOptions, AnalysisResult, SearchResult, StockFinancials } from './types.js';

const program = new Command();

program
  .name('investment-cli')
  .description('Fundamental stock analysis powered by LLMs\n\nFetches live financial data (Yahoo Finance, Finnhub), calculates DCF\nand Graham Number valuations, then asks an LLM for a bull/bear analysis.')
  .version('1.0.0')
  .argument('<symbol>', 'Stock ticker symbol (e.g. NOW, AAPL, MSFT, NVDA)')
  .option(
    '-m, --model <type>',
    'LLM provider to use for analysis\n  anthropic  Claude (claude-sonnet-4-6) — recommended\n  openai     GPT-4 Turbo\n  gemini     Gemini 1.5 Pro',
    'anthropic',
  )
  .option(
    '-s, --search <type>',
    'Optional web search to enrich the analysis\n  none           No web search (default)\n  claude-native  Claude built-in search (requires --model anthropic)\n  tavily         Tavily API (works with any model)\n  openai-tavily  Tavily injected into OpenAI prompt',
    'none',
  )
  .option('-o, --output <path>', 'Save report to file — format detected from extension\n  report.md   Markdown\n  report.json Full JSON data')
  .option('-c, --cache <setting>', 'Financial data cache (default: enable)', 'enable')
  .option('-v, --verbose', 'Debug logging — shows raw API responses and timings')
  .addHelpText('after', `
Examples:
  $ npx tsx src/cli.ts NOW
  $ npx tsx src/cli.ts AAPL --model openai
  $ npx tsx src/cli.ts MSFT --model anthropic --search claude-native
  $ npx tsx src/cli.ts NOW  --search tavily --output report.md
  $ npx tsx src/cli.ts NVDA --model gemini  --verbose

Required API keys (set in .env):
  ANTHROPIC_API_KEY    for --model anthropic (default)
  OPENAI_API_KEY       for --model openai
  GOOGLE_GEMINI_API_KEY for --model gemini
  FINNHUB_API_KEY      for news data (free tier: https://finnhub.io)
  TAVILY_API_KEY       for --search tavily (free tier: https://tavily.com)
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

async function run(symbol: string, opts: Record<string, string | boolean>): Promise<void> {
  if (opts.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  const options: AnalysisOptions = {
    model: (opts.model as AnalysisOptions['model']) ?? 'anthropic',
    search: normalizeSearch(opts.search as string, opts.model as string),
    cache: opts.cache !== 'disable',
    output: opts.output as string | undefined,
    verbose: Boolean(opts.verbose),
  };

  validateOptions(options);
  const cfg = getConfig();

  console.log(chalk.bold.white(`\n  Investment Analysis — ${symbol}\n`));
  logger.info(`Provider: ${options.model}  Search: ${options.search}`);

  // --- Parallel data fetch ---
  logger.step('Fetching market data...');
  const [financials, news] = await Promise.all([
    getFinancials(symbol),
    cfg.finnhubApiKey
      ? getNews(symbol, cfg.finnhubApiKey).catch((e) => { logger.warn(`News unavailable: ${e.message}`); return []; })
      : Promise.resolve([]),
  ]);

  logger.success(`Data fetched for ${financials.companyName}`);
  logger.info(`Price: $${financials.price.toFixed(2)}  Market Cap: ${fmtBig(financials.marketCap)}`);

  // --- Metrics ---
  const dcf = calculateDCF(financials);
  const grahamResult = calculateGraham(financials);
  const ratios = calculateRatios(financials);

  // --- Optional web search ---
  let searchResults: SearchResult[] = [];
  if (options.search === 'tavily' || options.search === 'openai-tavily') {
    const tavilyKey = requireApiKey('tavily');
    const searcher = new TavilySearch(tavilyKey);
    const queries = [
      `${symbol} stock analysis 2025`,
      `${financials.companyName} earnings outlook`,
      `${symbol} analyst rating price target`,
    ];
    logger.step('Running Tavily web search...');
    searchResults = await searcher.searchMultiple(queries);
    logger.success(`Got ${searchResults.length} search results`);
  }

  // --- LLM analysis ---
  const provider = createProvider(options);
  const prompt = buildAnalysisPrompt(symbol, financials, dcf, grahamResult, ratios, news);

  const llmAnalysis = await provider.analyze(prompt, financials, searchResults);
  logger.success('Analysis complete');

  // --- Assemble result ---
  const result: AnalysisResult = {
    symbol,
    timestamp: new Date().toISOString(),
    provider: options.model,
    searchProvider: options.search,
    financials,
    dcf,
    grahamNumber: grahamResult,
    ratios,
    llmAnalysis,
    news,
  };

  // --- Output ---
  const isJson = options.output?.endsWith('.json');
  const output = isJson ? JSON.stringify(result, null, 2) : formatMarkdown(result);

  console.log('\n' + output);

  if (options.output) {
    writeFileSync(options.output, output, 'utf-8');
    logger.success(`Saved to ${options.output}`);
  }
}

function normalizeSearch(search: string, model: string): AnalysisOptions['search'] {
  if (!search || search === 'none') return 'none';
  if (search === 'openai-tavily') return 'openai-tavily';
  if (search === 'claude-native') return 'claude-native';
  if (search === 'tavily') return model === 'openai' ? 'openai-tavily' : 'tavily';
  return 'none';
}

function validateOptions(options: AnalysisOptions): void {
  if (options.search === 'claude-native' && options.model !== 'anthropic') {
    throw new Error('--search claude-native requires --model anthropic');
  }
  const validModels = ['anthropic', 'openai', 'gemini'];
  if (!validModels.includes(options.model)) {
    throw new Error(`Invalid model: ${options.model}. Choose from: ${validModels.join(', ')}`);
  }
}

function buildAnalysisPrompt(
  symbol: string,
  f: StockFinancials,
  dcf: ReturnType<typeof calculateDCF>,
  graham: ReturnType<typeof calculateGraham>,
  ratios: ReturnType<typeof calculateRatios>,
  news: Awaited<ReturnType<typeof getNews>>,
): string {
  const newsBlock = news.length > 0
    ? news.slice(0, 5).map((n) => `- ${n.headline} (${n.source})`).join('\n')
    : 'No recent news available.';

  return `## Stock Analysis Request: ${symbol} (${f.companyName})

### Financial Snapshot
- Price: $${f.price.toFixed(2)}
- Market Cap: ${fmtBig(f.marketCap)}
- Sector: ${f.sector ?? 'N/A'} / ${f.industry ?? 'N/A'}

### Valuation
- P/E (trailing): ${fmt(ratios.pe, 'x')}
- P/E (forward): ${fmt(ratios.forwardPE, 'x')}
- PEG Ratio: ${fmt(ratios.peg)}
- P/B Ratio: ${fmt(ratios.pb, 'x')}
- EPS: ${fmt(f.eps, '')}
- Book Value: ${fmt(f.bookValue, '')}

### Profitability
- ROE: ${fmtPct(ratios.roe)}
- ROA: ${fmtPct(ratios.roa)}
- Operating Margin: ${fmtPct(ratios.operatingMargin)}
- Net Margin: ${fmtPct(ratios.netMargin)}
- Revenue: ${fmtBig(f.revenue)}
- Revenue Growth YoY: ${fmtPct(f.revenueGrowth)}
- Free Cash Flow: ${fmtBig(f.freeCashFlow)}
- EBITDA: ${fmtBig(f.ebitda)}

### Risk
- Beta: ${fmt(f.beta)}
- Debt/Equity: ${fmt(f.debtToEquity, 'x')}
- Current Ratio: ${fmt(f.currentRatio, 'x')}
- Dividend Yield: ${fmtPct(f.dividendYield)}

### 52-Week Range
- High: $${fmt(f.fiftyTwoWeekHigh)} / Low: $${fmt(f.fiftyTwoWeekLow)}

### DCF Valuation
- Fair Value (base): $${dcf.fairValue.toFixed(2)}
- Fair Value Range: $${dcf.fairValueLow.toFixed(2)} – $${dcf.fairValueHigh.toFixed(2)}
- ${dcf.assumptions}

### Graham Number
- Intrinsic Value: ${graham.grahamNumber ? `$${graham.grahamNumber.toFixed(2)}` : 'N/A'}
- Margin of Safety: ${graham.marginOfSafety !== null ? fmtPct(graham.marginOfSafety) : 'N/A'}
- Verdict: ${graham.isUndervalued ? 'Potentially undervalued' : 'Above Graham Number'}

### Recent News
${newsBlock}

---
Based on the above data, provide a comprehensive investment analysis in valid JSON format.
Focus on the fundamental picture, competitive moat, growth trajectory, and risk-adjusted return potential.`;
}

function formatMarkdown(r: AnalysisResult): string {
  const { financials: f, dcf, grahamNumber: g, ratios, llmAnalysis: llm, news } = r;

  const scoreBar = '█'.repeat(Math.round(llm.score)) + '░'.repeat(10 - Math.round(llm.score));
  const recColor = (rec: string) => {
    if (rec.includes('STRONG BUY')) return chalk.green.bold(rec);
    if (rec.includes('BUY')) return chalk.green(rec);
    if (rec.includes('HOLD')) return chalk.yellow(rec);
    if (rec.includes('SELL')) return chalk.red(rec);
    return rec;
  };

  const lines: string[] = [
    chalk.bold.white(`# ${r.symbol} — Investment Analysis`),
    chalk.gray(`Generated: ${r.timestamp}  |  Provider: ${r.provider}  |  Search: ${r.searchProvider}`),
    '',
    chalk.bold('## 📊 Financial Snapshot'),
    '',
    `| Metric             | Value        |`,
    `|--------------------|--------------|`,
    `| Current Price      | $${f.price.toFixed(2).padEnd(11)} |`,
    `| Market Cap         | ${fmtBig(f.marketCap).padEnd(12)} |`,
    `| P/E (trailing)     | ${fmt(ratios.pe, 'x').padEnd(12)} |`,
    `| P/E (forward)      | ${fmt(ratios.forwardPE, 'x').padEnd(12)} |`,
    `| PEG Ratio          | ${fmt(ratios.peg).padEnd(12)} |`,
    `| P/B Ratio          | ${fmt(ratios.pb, 'x').padEnd(12)} |`,
    `| ROE                | ${fmtPct(ratios.roe).padEnd(12)} |`,
    `| Revenue Growth     | ${fmtPct(f.revenueGrowth).padEnd(12)} |`,
    `| Operating Margin   | ${fmtPct(ratios.operatingMargin).padEnd(12)} |`,
    `| Debt/Equity        | ${fmt(ratios.debtToEquity, 'x').padEnd(12)} |`,
    `| Beta               | ${fmt(f.beta).padEnd(12)} |`,
    '',
    chalk.bold('## 📈 Valuation'),
    '',
    chalk.underline('DCF Analysis'),
    `  Fair Value:    $${dcf.fairValue.toFixed(2)}`,
    `  Range:         $${dcf.fairValueLow.toFixed(2)} – $${dcf.fairValueHigh.toFixed(2)}`,
    `  Assumptions:   ${dcf.assumptions}`,
    '',
    chalk.underline('Graham Number'),
    `  Intrinsic Value: ${g.grahamNumber ? `$${g.grahamNumber.toFixed(2)}` : 'N/A'}`,
    `  Margin of Safety: ${g.marginOfSafety !== null ? fmtPct(g.marginOfSafety) : 'N/A'} ${g.isUndervalued ? '(undervalued ✓)' : '(above Graham Number)'}`,
    '',
    chalk.bold('## 🚀 Bull Case'),
    '',
    llm.bullCase,
    '',
    chalk.bold('## 🐻 Bear Case'),
    '',
    llm.bearCase,
    '',
    chalk.bold('## ⚠️ Key Risks'),
    '',
    ...llm.keyRisks.map((r) => `  • ${r}`),
    '',
    chalk.bold('## 💡 Investment Thesis'),
    '',
    llm.thesis,
    '',
    chalk.bold('## 📊 Recommendation'),
    '',
    `  Score:         ${scoreBar} ${llm.score}/10`,
    `  Recommendation: ${recColor(llm.recommendation)}`,
    `  Fair Value Est: ${llm.fairValueEstimate}`,
  ];

  if (news.length > 0) {
    lines.push('', chalk.bold('## 📰 Recent News'), '');
    news.slice(0, 5).forEach((n) => {
      const date = new Date(n.datetime * 1000).toLocaleDateString();
      lines.push(`  [${date}] ${n.headline} — ${n.source}`);
    });
  }

  lines.push(
    '',
    chalk.gray(`---`),
    chalk.gray(`Data: Yahoo Finance, Finnhub`),
  );

  return lines.join('\n');
}
