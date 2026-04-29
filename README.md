# investment-cli

Fundamental stock analysis from the terminal. Fetches live financial data, runs DCF and Graham Number valuations, then asks an LLM (Claude, GPT-4, or Gemini) for a structured bull/bear analysis.

```
$ npx tsx src/cli.ts NOW

  Investment Analysis — NOW

→ Fetching market data...
✓ Data fetched for ServiceNow Inc. ($1049.20 · $211B)

## 📊 Financial Snapshot
| Metric           | Value   |
|------------------|---------|
| P/E (trailing)   | 159.28x |
| Forward P/E      | 42.10x  |
| ROE              | 12.3%   |
| Revenue Growth   | 21.5%   |
...

## 📈 Valuation
DCF Fair Value:  $987 – $1,205
Graham Number:   $312  (above Graham Number)

## 🚀 Bull Case   ## 🐻 Bear Case   ## 📊 Recommendation
...              ...               Score: 7/10 · BUY
```

## Setup

```bash
git clone <repo> && cd investment-cli
npm install
cp .env.example .env   # then fill in your API keys
```

### Required API keys

| Key | Service | Where to get it |
|-----|---------|-----------------|
| `ANTHROPIC_API_KEY` | Claude (default model) | [console.anthropic.com](https://console.anthropic.com) |
| `FINNHUB_API_KEY` | News & sentiment | [finnhub.io](https://finnhub.io) — free tier |
| `OPENAI_API_KEY` | GPT-4 (optional) | [platform.openai.com](https://platform.openai.com) |
| `GOOGLE_GEMINI_API_KEY` | Gemini (optional) | [ai.google.dev](https://ai.google.dev) |
| `TAVILY_API_KEY` | Web search (optional) | [tavily.com](https://tavily.com) — free tier |

Minimum to get started: `ANTHROPIC_API_KEY` + `FINNHUB_API_KEY`.

## Usage

```bash
# Basic analysis with Claude (default)
npx tsx src/cli.ts NOW

# Different LLM providers
npx tsx src/cli.ts AAPL --model openai
npx tsx src/cli.ts MSFT --model gemini

# Add web search
npx tsx src/cli.ts NOW  --model anthropic --search claude-native
npx tsx src/cli.ts AAPL --model openai    --search tavily

# Save output
npx tsx src/cli.ts NOW --output report.md
npx tsx src/cli.ts NOW --output report.json

# Debug mode
npx tsx src/cli.ts NOW --verbose
```

## Options

```
Usage: investment-cli [options] <symbol>

Arguments:
  symbol              Stock ticker (e.g. NOW, AAPL, MSFT)

Options:
  -m, --model         anthropic | openai | gemini          (default: anthropic)
  -s, --search        none | claude-native | tavily | openai-tavily  (default: none)
  -o, --output        Path to save report (.md or .json)
  -c, --cache         enable | disable                      (default: enable)
  -v, --verbose       Debug logging
  -h, --help          Show help
```

### Search compatibility

| `--search`       | Works with              |
|------------------|-------------------------|
| `claude-native`  | `--model anthropic` only |
| `tavily`         | any model               |
| `openai-tavily`  | `--model openai` (alias for tavily) |

## What it calculates

**DCF (Discounted Cash Flow)**
Projects free cash flow 5 years forward at 10% growth, discounts at 8% WACC, adds a terminal value at 3% perpetual growth. Outputs a fair value range ±10%.

**Graham Number**
`√(22.5 × EPS × Book Value per Share)` — Benjamin Graham's intrinsic value formula. Shows margin of safety vs. current price.

**Financial Ratios**
P/E, Forward P/E, PEG, P/B, ROE, ROA, Debt/Equity, Current Ratio, Operating Margin, Net Margin, Revenue Growth, Dividend Yield.

## Data sources

| Source | Data |
|--------|------|
| Yahoo Finance (`yahoo-finance2`) | Price, market cap, ratios, fundamentals |
| Finnhub | Recent company news |
| Tavily / Claude web search | Optional: analyst ratings, recent news |

## Cost per run

| Provider | Approx. cost |
|----------|-------------|
| Claude   | ~$0.01      |
| OpenAI   | ~$0.08      |
| Gemini   | free tier   |

## Project structure

```
src/
├── cli.ts               Entry point & output formatter
├── config.ts            Env vars (Zod validated)
├── types.ts             Shared TypeScript interfaces
├── providers/           LLM abstraction layer
│   ├── anthropic.ts     Claude + native web_search tool
│   ├── openai.ts        GPT-4 Turbo
│   ├── gemini.ts        Gemini 1.5 Pro
│   └── factory.ts
├── search/
│   └── tavily.ts        Tavily web search
├── data/
│   ├── yfinance.ts      Yahoo Finance (yahoo-finance2)
│   └── finnhub.ts       News & sentiment
├── analysis/
│   └── metrics.ts       DCF, Graham Number, ratio calculations
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
