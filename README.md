# stock-cli

Fundamental stock analysis from the terminal. Fetches live financial data, runs 15 valuation models, then asks an LLM for a structured bull/bear analysis.

## Setup

```bash
git clone <repo> && cd stock-cli
npm install
cp .env.example .env   # fill in your API keys
```

### API Keys

| Key | Service | Required | Where to get |
|-----|---------|----------|--------------|
| `ANTHROPIC_API_KEY` | Claude — `--model claude/haiku/opus/claude-*` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `FINNHUB_API_KEY` | News & Finnhub metrics | yes | [finnhub.io](https://finnhub.io) — free tier |
| `OPENAI_API_KEY` | OpenAI — `--model openai/gpt-*/o1-*` | optional | [platform.openai.com](https://platform.openai.com) |
| `GOOGLE_GEMINI_API_KEY` | Gemini — `--model gemini/gemini-*` | optional | [ai.google.dev](https://ai.google.dev) |
| `BRAVE_API_KEY` | Brave web search | optional | [brave.com/search/api](https://brave.com/search/api/) — $5 free credits/mo |
| `TAVILY_API_KEY` | Tavily web search | optional | [tavily.com](https://tavily.com) |
| `FRED_API_KEY` | Live interest rates | optional | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — free |

Minimum to get started: `ANTHROPIC_API_KEY` + `FINNHUB_API_KEY`.

With `FRED_API_KEY`, the Graham Revised, DDM and Sortino models use live 10-year Treasury and Moody's AAA yields instead of hardcoded fallbacks.

## Usage

```bash
# Basic analysis (Claude Sonnet, no search)
npx tsx src/cli.ts NOW

# Native search (no value = auto-selects native for the active model)
npx tsx src/cli.ts AAPL --model claude  --search
npx tsx src/cli.ts AAPL --model openai  --search

# Explicit search provider
npx tsx src/cli.ts FACC --search brave
npx tsx src/cli.ts NOW  --search tavily --output report.md

# Model shortcuts
npx tsx src/cli.ts AAPL --model haiku       # claude-haiku-4-5-20251001
npx tsx src/cli.ts AAPL --model opus        # claude-opus-4-7
npx tsx src/cli.ts MSFT --model gemini

# Full model ID override
npx tsx src/cli.ts NOW  --model gpt-5.4
npx tsx src/cli.ts NOW  --model claude-opus-4-7 --search brave

# Save output
npx tsx src/cli.ts NOW --output report.md
npx tsx src/cli.ts NOW --output report.json

# Misc
npx tsx src/cli.ts NOW --cache disable   # skip cache
npx tsx src/cli.ts NOW --verbose         # debug logging
```

## Options

```
Usage: investment-cli [options] <symbol>

Arguments:
  symbol              Stock ticker — local exchange symbols auto-resolved
                      (e.g. NOW, AAPL, FACC → 0QW9.IL)

Options:
  -m, --model <id>    Model shortcut or full model ID  (default: claude)
                        Shortcuts:  claude | openai | gemini | haiku | opus | sonnet
                        Full IDs:   claude-* | gpt-* | o1-* | gemini-*
  -s, --search [type] Web search — omit value for native search of active model
                        none | claude | openai | brave | tavily
  -o, --output        Save report — .md or .json
  -c, --cache         enable | disable                 (default: enable, TTL 1h)
  -v, --verbose       Debug logging
  -h, --help          Show help
```

### Search modes

| `--search` | Works with | Quality | Cost/analysis |
|---|---|---|---|
| *(omitted)* | any model | financial data only | free |
| `brave` | any model | current news + snippets | ~$0.015 (free up to 2k req/mo) |
| `tavily` | any model | current news | ~$0.005 |
| `openai` | `openai` / `gpt-*` only | live web via Responses API | ~$0.02 |
| `claude` | `claude` / `claude-*` only | live web, best quality | ~$0.12 |

Pass `--search` without a value to auto-select the native search for the active model (`claude` → claude search, `openai` → openai search).

**Recommendation:** `--search brave` for daily use, `--search` (native) during earnings season or after major news events.

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
| Yahoo Finance (`yahoo-finance2`) | Price, fundamentals, balance sheet, cash flow, historical prices, analyst targets & ratings |
| Yahoo Finance search API | Symbol auto-resolution — type `FACC` and it resolves to the correct exchange ticker |
| Finnhub `/stock/metric` | ROIC, 3-year EPS CAGR, 5-year dividend growth rate |
| Finnhub `/stock/peers` + `/stock/metric` | Peer group median multiples & profitability (up to 8 peers) |
| Finnhub `/company-news` | Recent company news (last 7 days) |
| FRED | Live 10-year Treasury yield (DGS10), Moody's AAA bond yield (DAAA) |
| Brave / Tavily / Claude / OpenAI | Optional web search for current events |

## Project structure

```
src/
├── cli.ts               Entry point & orchestration
├── config.ts            Env vars (Zod validated)
├── types.ts             Zod schemas with field descriptions (types inferred via z.infer<>)
├── cache.ts             File-based JSON cache (1h TTL, versioned)
├── providers/           LLM abstraction layer
│   ├── anthropic.ts     Claude + native web_search_20250305 tool
│   ├── openai.ts        OpenAI chat completions + Responses API web_search_preview
│   ├── gemini.ts        Gemini 1.5 Pro
│   └── factory.ts
├── search/
│   ├── base.ts          Abstract SearchProvider
│   ├── brave.ts         Brave Search (extra_snippets)
│   └── tavily.ts        Tavily
├── data/
│   ├── yfinance.ts      Yahoo Finance — symbol resolution, fundamentalsTimeSeries, chart(), analyst ratings
│   ├── finnhub.ts       News, basic metrics (ROIC, EPS CAGR), peer group medians
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
