# stock-cli

Fundamental stock analysis from the terminal. Fetches live financial data, runs 15 valuation models, then asks an LLM for a structured bull/bear analysis.

```
$ npx tsx src/cli.ts NOW --search brave

  Investment Analysis — NOW

→ Fetching market data...
✓ ServiceNow, Inc.  $88.89  $91.67B
→ Running valuation models...
✓ 15 models calculated
→ Running Brave web search...
✓ 12 search results
→ Calling Claude for analysis...
✓ LLM analysis complete

# NOW — Investment Analysis

## 📊 Snapshot          ## 💹 Valuation Multiples    ## 📈 Profitability
Price:     $88.89        P/E:       52.91x             Revenue:     $13.96B (+22.1%)
Market Cap: $91.67B      Forward P/E: 17.77x            FCF:         $5.11B
Beta:       N/A          EV/EBITDA: 31.36x             ROIC:        N/A

## 📐 Intrinsic Value Models
| Model                   | Fair Value  | vs. Price |
|-------------------------|-------------|-----------|
| DCF (5yr, 10% growth)   | $138.01     | ▲ 55.3%   |
| Peter Lynch             | $123.58     | ▲ 39.0%   |
| EPV (Greenwald)         | $25.45      | ▼ 71.4%   |

## 🏆 Piotroski F-Score       ## ⚠️  Altman Z-Score
Score: 4/8  NEUTRAL            Score: 8.62  →  safe zone

## 📊 Recommendation
Score: ███████░░░ 7/10  ·  BUY  ·  Fair Value: $123 – $145
```

## Setup

```bash
git clone <repo> && cd stock-cli
npm install
cp .env.example .env   # fill in your API keys
```

### API Keys

| Key | Service | Required | Where to get |
|-----|---------|----------|--------------|
| `ANTHROPIC_API_KEY` | Claude (default LLM) | yes | [console.anthropic.com](https://console.anthropic.com) |
| `FINNHUB_API_KEY` | News & Finnhub metrics | yes | [finnhub.io](https://finnhub.io) — free tier |
| `OPENAI_API_KEY` | GPT-4 Turbo | optional | [platform.openai.com](https://platform.openai.com) |
| `GOOGLE_GEMINI_API_KEY` | Gemini 1.5 Pro | optional | [ai.google.dev](https://ai.google.dev) |
| `BRAVE_API_KEY` | Brave web search | optional | [brave.com/search/api](https://brave.com/search/api/) — $5 free credits/mo |
| `TAVILY_API_KEY` | Tavily web search | optional | [tavily.com](https://tavily.com) |
| `FRED_API_KEY` | Live interest rates | optional | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — free |

Minimum to get started: `ANTHROPIC_API_KEY` + `FINNHUB_API_KEY`.

With `FRED_API_KEY`, the Graham Revised, DDM and Sortino models use live 10-year Treasury and Moody's AAA yields instead of hardcoded fallbacks.

## Usage

```bash
# Basic analysis (Claude, no search)
npx tsx src/cli.ts NOW

# Recommended: Brave search for current events (~$0.015/analysis, free up to 1000 req/mo)
npx tsx src/cli.ts NOW --search brave

# Best quality: Claude native search (~$0.12/analysis, ideal for earnings season)
npx tsx src/cli.ts NOW --search claude-native

# Other LLM providers
npx tsx src/cli.ts AAPL --model openai
npx tsx src/cli.ts MSFT --model gemini --search brave

# Save output
npx tsx src/cli.ts NOW --output report.md
npx tsx src/cli.ts NOW --output report.json

# Skip cache (always refetch)
npx tsx src/cli.ts NOW --cache disable

# Debug logging
npx tsx src/cli.ts NOW --verbose
```

## Options

```
Usage: investment-cli [options] <symbol>

Arguments:
  symbol              Stock ticker (e.g. NOW, AAPL, MSFT, NVDA)

Options:
  -m, --model         anthropic | openai | gemini        (default: anthropic)
  -s, --search        none | brave | claude-native | tavily | openai-tavily  (default: none)
  -o, --output        Save report — .md or .json
  -c, --cache         enable | disable                   (default: enable, TTL 1h)
  -v, --verbose       Debug logging
  -h, --help          Show help
```

### Search modes

| `--search` | Works with | Quality | Cost/analysis |
|---|---|---|---|
| `none` | any model | financial data only | free |
| `brave` | any model | current news + snippets | ~$0.015 (free up to 1k req/mo) |
| `claude-native` | `anthropic` only | live web, best quality | ~$0.12 |
| `tavily` | any model | current news | ~$0.005 |
| `openai-tavily` | `openai` only | alias for tavily | ~$0.005 |

**Recommendation:** `--search brave` for daily use, `--search claude-native` during earnings season or after major news events.

## Valuation models

| # | Model | Method |
|---|-------|--------|
| 1 | **DCF** | 5-year FCF projection at 10% growth, 8% WACC, 3% terminal |
| 2 | **Reverse DCF** | Binary search for FCF growth rate implied by current price |
| 3 | **Graham Number** | `√(22.5 × EPS × Book Value)` |
| 4 | **Graham Revised (V\*)** | `EPS × (8.5 + 2g) × 4.4 / AAA_yield` — uses live FRED rate |
| 5 | **Peter Lynch** | `EPS × EPS_growth_rate_pct` — uses 3-year EPS CAGR from Finnhub |
| 6 | **EPV (Greenwald)** | Normalized EBIT × (1 − tax) / WACC + cash − debt |
| 7 | **DDM** | Gordon Growth Model with CAPM required return — uses live FRED rate |
| 8 | **EV Multiples** | EV/EBITDA, EV/Revenue, EV/FCF, P/FCF, P/S |
| 9 | **Rule of 40** | Revenue growth % + operating margin % |
| 10 | **Piotroski F-Score** | 9-signal fundamental quality screen (F1–F9) |
| 11 | **Altman Z-Score** | Original (manufacturing) or Modified Z' (services/tech) |
| 12 | **Interest Coverage** | EBIT / interest expense |
| 13 | **Sortino Ratio** | Risk-adjusted return using downside deviation only — uses live FRED rate |
| 14 | **Beneish M-Score** | 8-variable earnings manipulation detector |
| 15 | **Key Ratios** | P/E, Forward P/E, PEG, P/B, ROE, ROA, ROIC, D/E, margins, growth |

## Data sources

| Source | Data |
|--------|------|
| Yahoo Finance (`yahoo-finance2`) | Price, fundamentals, balance sheet, cash flow, historical prices |
| Finnhub `/stock/metric` | ROIC, 3-year EPS CAGR, 5-year dividend growth rate |
| Finnhub `/company-news` | Recent company news (last 7 days) |
| FRED | Live 10-year Treasury yield (DGS10), Moody's AAA bond yield (DAAA) |
| Brave / Tavily / Claude | Optional web search for current events |

## Cost per analysis

| LLM | Search | Approx. total |
|-----|--------|---------------|
| Claude | none | ~$0.01 |
| Claude | brave | ~$0.025 |
| Claude | claude-native | ~$0.12 |
| OpenAI | none | ~$0.08 |
| OpenAI | brave | ~$0.095 |
| Gemini | none | free tier |

## Project structure

```
src/
├── cli.ts               Entry point & orchestration
├── config.ts            Env vars (Zod validated)
├── types.ts             Shared TypeScript interfaces
├── cache.ts             File-based JSON cache (1h TTL, versioned)
├── providers/           LLM abstraction layer
│   ├── anthropic.ts     Claude + native web_search tool
│   ├── openai.ts        GPT-4 Turbo
│   ├── gemini.ts        Gemini 1.5 Pro
│   └── factory.ts
├── search/
│   ├── base.ts          Abstract SearchProvider
│   ├── brave.ts         Brave Search (extra_snippets)
│   └── tavily.ts        Tavily
├── data/
│   ├── yfinance.ts      Yahoo Finance — fundamentalsTimeSeries + chart()
│   ├── finnhub.ts       News, sentiment, basic metrics
│   └── fred.ts          Live interest rates (10Y Treasury, AAA yield)
├── analysis/
│   └── metrics.ts       15 valuation models + formatting helpers
├── output/
│   ├── prompt.ts        LLM prompt builder
│   └── markdown.ts      Terminal output formatter
└── utils/
    └── logger.ts        Chalk-based structured logging
```

## Development

```bash
npm run dev        # watch mode (tsx)
npm run build      # compile TypeScript → dist/
npm run typecheck  # type-check without emitting
```

## License

MIT
