# stock-cli

Fundamental stock analysis from the terminal *and* a local web UI. Fetches live financial data, runs 19 valuation models, then asks an LLM for a structured bull/bear/risks analysis with a composite fair-value range.

```
CLI mode  →  one-shot analysis, prints markdown or JSON to stdout
Web mode  →  persistent local app: sidebar of cached stocks, flag toggling,
             chart-rich detail view, no LLM call until you explicitly Run
```

## Setup

```bash
git clone <repo> && cd stock-cli
corepack enable        # pins the pnpm version from package.json
pnpm install           # installs the server and the web/ frontend together
cp .env.example .env   # fill in your API keys
```

The frontend under `web/` is a workspace package, so one install covers both —
there is no second step and one lockfile describes the whole tree.

### API Keys

| Key | Service | Required | Where to get |
|-----|---------|----------|--------------|
| `ANTHROPIC_API_KEY` | Claude — `--model claude/opus/claude-*` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `FINNHUB_API_KEY` | News, peer medians, sector ETF mapping | yes | [finnhub.io](https://finnhub.io) — free tier |
| `OPENAI_API_KEY` | OpenAI — `--model terra/luna/mini/gpt-*/o1-*` | optional | [platform.openai.com](https://platform.openai.com) |
| `PPLX_API_KEY` | Perplexity Sonar — web-sourced context paragraph | optional | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| `DISTILL_API_KEY` + `DISTILL_API_URL` | Distill — rolling dossiers per company and sector, plus raw insights | optional | mint in Distill Admin → Project → Access keys, scope `dossiers:write` (no `briefings:write` needed) |
| `BRAVE_API_KEY` | Brave web search | optional | [brave.com/search/api](https://brave.com/search/api/) — $5 free credits/mo |
| `TAVILY_API_KEY` | Tavily web search | optional | [tavily.com](https://tavily.com) |
| `FRED_API_KEY` | Live macro rates (10Y, AAA, VIX, DXY, yield curve) | optional | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — free |

Minimum to get started: `ANTHROPIC_API_KEY` + `FINNHUB_API_KEY`.

With `FRED_API_KEY`, Graham Revised, DDM, EPV, the 2-Stage DCF, RIM and Sortino models pull live rates instead of hardcoded fallbacks. Also unlocks the macro context block (VIX regime, yield curve, HY spreads, DXY).

`DATABASE_URL` is required — everything the app records lives in Postgres.
`pnpm dev` starts one matching the URL in `.env.example` and migrates it.

Optional env: `DATA_DIR=.data` (EDGAR filings and generated reports — the only
things still stored as files), `LOG_LEVEL=info|debug|warn|error`.

## Web UI

```bash
pnpm dev             # Postgres + migrations + API + Vite, in that order
```

One command brings the whole stack up: it starts the `postgres` container and
waits for its healthcheck, applies any pending migrations, then runs `tsx watch
src/server.ts` (port 4317) and `vite` (port 4316) in parallel via
[concurrently](https://www.npmjs.com/package/concurrently). Open
<http://localhost:4316>.

Run the pieces separately if you prefer:

```bash
pnpm dev:infra           # just the Postgres container (waits for healthy)
pnpm dev:apps            # just API + Vite, assumes the DB is already up
pnpm run serve:watch     # API on :4317 (auto-restarts on file changes)
pnpm run web:dev         # Vite dev server on :4316 with HMR
```

Stop the container again with `pnpm dev:stop`.

Production build:

```bash
pnpm run web:build       # → web/dist/ static assets
pnpm run serve           # API only — serve dist/ behind your own reverse proxy
```

### What the web UI does

A toolbar at the top switches between two working views; the cog on the far right opens administration.

**Tab „Analyse"** — the single-stock view the app has always opened on:

- **Left sidebar**: every stock you've ever analysed, with a 3-segment buy/hold/sell consensus stripe (AI verdicts + analyst counts, AI weighted 0.6).
- **Center pane**: full analysis — AI verdict card, composite fair value (primary + conservative tiers), bull/bear/risks, valuation models, peer comparison, fundamentals history, technical signals gauge (TradingView-style), price action, ownership flow, news & research.
- **Right sidebar**: model + search-provider + Perplexity toggles. Each flag combo is its own cached entry. Clicking an outdated combo still loads it (older entries get a ⚠ marker) — a warning banner sits on top with a one-click re-run.
- **Refresh data** (header `↻`) re-fetches the data layer (Yahoo + Finnhub + FRED + technicals) without a single LLM call. **Re-run** in the right sidebar or in the stale banner forces a fresh LLM call, overwriting the cached verdict.

Adding a stock (`+ Hinzufügen` at the bottom of the Analyse tab) resolves the ticker or company name and fetches the data layer — **no LLM call**. The verdict is a separate, explicit `Run Analysis` in the right sidebar, so looking a company up never costs an API bill.

**Tab „Übersicht"** — every cached stock in one ranked table: AI score (with the change since the first recorded verdict), a sparkline of the score over time, the verdict label and model, price, analyst mean target, composite fair value, both upside percentages, market cap and how old the data and the verdict are. Sorted by score descending by default; other columns and a watchlist-only filter are one click away. A row click opens that stock in the Analyse tab.

**⚙ Administration** — schedule, pipeline steps, watchlist and run log. See [Nightly pipeline](#nightly-pipeline) below.

**URLs**: `#/stock/AAPL`, `#/overview`, `#/admin` — reload and browser back/forward work everywhere. Old `#AAPL` links still resolve to the analysis view.

Switching tabs never interrupts a running analysis: the Analyse view stays mounted (hidden) so its progress stream survives a detour to the overview.

### Theming

Edit hex values in `web/src/styles.css` — your editor opens a colour picker. The Tailwind config is a thin wrapper over CSS vars (`--color-success`, `--color-danger`, `--color-bg-deep`, …), so no rebuild is needed for runtime tweaks.

Consensus-bar palette uses dedicated vars: `--color-consensus-buy/-hold/-sell`.

## CLI

```bash
# Basic analysis (Claude Sonnet, no search)
npx tsx src/cli.ts NOW

# Native search (no value = auto-selects native for the active model)
npx tsx src/cli.ts AAPL --model claude  --search
npx tsx src/cli.ts AAPL --model terra   --search

# Explicit search provider
npx tsx src/cli.ts FACC --search brave
npx tsx src/cli.ts NOW  --search tavily --output report.md

# Perplexity Sonar context (separate from --search; pulls a web-sourced paragraph)
npx tsx src/cli.ts MSFT --pplx sonar
npx tsx src/cli.ts MSFT --pplx sonar-pro

# Model IDs — the registry lives in src/models.ts
npx tsx src/cli.ts NOW  --model claude-opus-5 --search brave
npx tsx src/cli.ts NOW  --model gpt-5.6-terra

# …or the short alias for the same thing
npx tsx src/cli.ts AAPL --model opus        # claude-opus-5
npx tsx src/cli.ts MSFT --model terra       # gpt-5.6-terra
npx tsx src/cli.ts MSFT --model luna        # gpt-5.6-luna
npx tsx src/cli.ts MSFT --model mini        # gpt-5.4-mini

# Save output
npx tsx src/cli.ts NOW --output report.md
npx tsx src/cli.ts NOW --output report.json

# Misc
npx tsx src/cli.ts NOW --cache disable   # skip cache
npx tsx src/cli.ts NOW --verbose         # debug logging
```

### Options

```
Usage: investment-cli [options] <symbol>

Arguments:
  symbol              Stock ticker — local exchange symbols auto-resolved
                      (e.g. NOW, AAPL, FACC → 0QW9.IL, Airbus → AIR.PA)

Options:
  -m, --model <id>    Model shortcut or full model ID  (default: claude)
                        Model IDs: claude-sonnet-5 | claude-opus-5 |
                                   gpt-5.6-terra | gpt-5.6-luna | gpt-5.4-mini
                        Aliases:   claude | sonnet | opus | terra | luna | mini
                        Any other: claude-* | gpt-* | o1-*
  -s, --search [type] Web search — omit value for native search of active model
                        none | claude | openai | brave | tavily
                        (can be comma-separated for multi-source: brave,tavily)
      --pplx <model>  Perplexity Sonar context — sonar | sonar-pro
  -o, --output        Save report — .md or .json
  -c, --cache         enable | disable                 (default: enable)
  -v, --verbose       Debug logging
  -h, --help          Show help
```

### Search modes

| `--search` | Works with | Quality | Cost/analysis |
|---|---|---|---|
| *(omitted)* | any model | financial data only | free |
| `brave` | any model | current news + snippets | ~$0.015 (free up to 2k req/mo) |
| `tavily` | any model | current news | ~$0.005 |
| `openai` | `terra` / `luna` / `mini` / `gpt-*` only | live web via Responses API | ~$0.02 |
| `claude` | `claude` / `opus` / `claude-*` only | live web, best quality | ~$0.12 |

Pass `--search` without a value to auto-select the native search for the active model. Multiple providers can be combined (`--search brave,tavily`); results are merged before the LLM call.

**Recommendation:** `brave` for daily use, native (`claude` / `openai`) during earnings season, `--pplx sonar` as a complement when you want a curated paragraph of web context instead of raw snippets.

## Valuation models

| # | Model | Method |
|---|-------|--------|
| 1 | **2-Stage DCF (FCFF)** | Stage-1 growth (analyst-forward, capped) → linear fade → terminal. CAPM discount rate from live β + risk-free. Equity bridge (− debt + cash). |
| 2 | **Reverse DCF** | Binary search for FCF growth implied by the current price, same 2-stage geometry. |
| 3 | **Graham Number** | `√(22.5 × EPS × Book Value)` |
| 4 | **Graham Revised (V\*)** | `EPS × (8.5 + 2g) × 4.4 / AAA_yield` — live FRED rate |
| 5 | **Peter Lynch** | `EPS × growth_rate_pct`, prefers analyst-forward growth |
| 6 | **EPV (Greenwald)** | Normalised EBIT × (1 − tax) / WACC + cash − debt |
| 7 | **DDM** | Gordon Growth with CAPM required return |
| 8 | **RIM (Residual Income / EBO)** | Book value + Σ excess returns over cost of equity |
| 9 | **NCAV (Graham Net-Net)** | Current assets − total liabilities, ⅔ × NCAV buy threshold |
| 10 | **Peer Multiples** | P/E, EV/EBITDA, EV/Revenue, P/FCF, P/B, P/S vs Finnhub sector medians — implied fair price per multiple + median fair price |
| 11 | **Composite Fair Value** | Median + IQR over all *applicable* models, split into Primary (market-aligned) and Conservative (value-investor) tiers. Sanity-bounded 0.02× – 30× of price. |
| 12 | **EV Multiples** | EV/EBITDA, EV/Revenue, EV/FCF, P/FCF, P/S TTM, forward P/S |
| 13 | **Simple Valuation Ratio (P/S Run-Rate)** | `marketCap / (latest_quarter_revenue × 4)` — reacts to growth inflections faster than TTM P/S |
| 14 | **Rule of 40** | Revenue growth % + operating margin % |
| 15 | **Piotroski F-Score** | 9-signal fundamental quality screen (F1–F9) |
| 16 | **Altman Z-Score** | Original (manufacturing) or Modified Z′ (services/tech) |
| 17 | **Interest Coverage** | EBIT / interest expense |
| 18 | **Sortino Ratio** | Risk-adjusted return using downside deviation, live risk-free rate |
| 19 | **Beneish M-Score** | 8-variable earnings-manipulation detector, gated on min variable coverage |

## Technical signals gauge

Indicators come from [`trading-signals`](https://github.com/bennycode/trading-signals);
`src/analysis/technical.ts` feeds it the daily bars and snapshots the latest value of each.
TradingView-style aggregation on top of that in `src/analysis/signals.ts`:

- **Moving averages** — SMA/EMA 10, 20, 50, 100, 200 vs price
- **Oscillators** — RSI14, Stochastic %K/%D, MACD histogram, CCI20, Williams %R, momentum
- **Overall** — weighted blend mapped to STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL

## Data sources

| Source | Data |
|--------|------|
| Yahoo Finance (`yahoo-finance2`) | Price, fundamentals, annual + quarterly income statements, balance sheet, cash flow, daily/monthly price history, analyst targets & ratings, earnings history + estimates, options chain, insider transactions, institutional ownership |
| Yahoo Finance search API | Symbol auto-resolution (`FACC` → `0QW9.IL`) |
| Finnhub `/stock/metric` | ROIC, 3-year EPS CAGR, 5-year dividend growth rate |
| Finnhub `/stock/peers` + `/stock/metric` | Peer-group median multiples & profitability |
| Finnhub `/company-news` | Recent news (last 7 days) |
| FRED | 10Y Treasury, Moody's AAA, VIX, DXY, yield curve, HY spreads, sector ETF prices |
| SEC EDGAR | Latest 10-K / 10-Q filings (US tickers only) |
| Wikidata `P946` | ISIN lookup (Yahoo dropped the field; Wikidata is curated and global). German WKN derived from `DE0…` ISINs. |
| Perplexity Sonar | Optional web-sourced context paragraph included verbatim in the LLM prompt |
| Distill | Optional curated multi-source briefings per ticker (RSS, YouTube, web). Weighted **above** Perplexity / raw search in the LLM prompt because the editorial filter happens upstream |
| Brave / Tavily / Claude / OpenAI | Optional web search for current events |

## Project structure

```
src/
├── cli.ts                 Entry point + runAnalysis() shared by CLI & web
├── server.ts              Express API: /api/stocks, /api/analyze/stream, …
├── refresh.ts             Force-refresh data layer without LLM (web "↻ Refresh" button)
├── config.ts              Env vars (Zod validated)
├── types.ts               Zod schemas — types inferred via z.infer<>
├── db/
│   ├── client.ts          Postgres pool
│   ├── migrate.ts         Numbered .sql migrations, applied once, in order
│   ├── walk.ts            Generic zod-schema walker — every leaf becomes a metric
│   ├── catalog.ts         Metric catalogue derived from the schemas (418 series)
│   ├── store.ts           Symbols, snapshots, observations, documents
│   ├── admin.ts           Runs, settings, entity mappings, filing index
│   └── backfill.ts        One-shot import of the old file cache
├── files.ts               The two things that stay files (filings, reports)
├── sector-medians.ts      Peer-group medians (the app's most expensive read)
├── app-config.ts          Operational settings edited from the admin page
├── scheduler.ts           Nightly pipeline — one cron, one queue, one symbol at a time
├── distill-service.ts     Distill orchestration: symbol → entity UUID → briefings
├── distill-dossiers.ts    Mirrors the watchlist onto Distill's dossier switches
├── distill-sectors.ts     Yahoo sector/industry → Distill sector handles (1:n)
├── distill-content.ts     Assembles the company + sector dossier prose for a stock
├── models.ts              Model registry — single source for CLI, server and web UI
├── providers/             LLM abstraction layer (anthropic, openai, factory)
├── search/                Brave + Tavily clients (LLM-native search is in providers/)
├── data/
│   ├── yfinance.ts        Yahoo: financials, quarterly revenues, ISIN via Wikidata
│   ├── finnhub.ts         News, basic metrics, peer-group medians
│   ├── fred.ts            FRED rates (live 10Y, AAA, …)
│   ├── macro.ts           SPY + sector-ETF bundles, yield curve, VIX
│   ├── perplexity.ts      Sonar / Sonar-Pro web-research paragraph
│   ├── distill.ts         Distill briefing service — briefings for a resolved entity
│   ├── distill-entities.ts Distill entity registry — identifier → entity UUID
│   ├── distill-dossier.ts Distill dossier switch — GET/PUT /entities/{id}/dossier
│   ├── distill-errors.ts  Typed Distill failures (shared by all three clients)
│   └── edgar.ts           SEC EDGAR filings
├── analysis/
│   ├── metrics.ts         19 valuation models
│   ├── computeMetrics.ts  Orchestrates the bundle of models for the web GET
│   ├── signals.ts         TradingView-style buy/sell signal aggregation
│   └── technical.ts       SMA/EMA/RSI/MACD/Bollinger/Stoch/CCI via `trading-signals`
├── output/
│   ├── prompt.ts          LLM prompt builder
│   ├── markdown.ts        Terminal + report markdown
│   └── report.ts          PDF/HTML report (Puppeteer)
└── utils/logger.ts        Chalk-based structured logging

web/
├── index.html
├── vite.config.ts
├── tailwind.config.js     Maps Tailwind colour tokens → CSS vars in styles.css
├── src/
│   ├── App.tsx            Routing (hash), state, SSE wiring
│   ├── pages/             Übersicht (ranked table) + Administration
│   ├── api.ts             Thin fetch wrappers
│   ├── types.ts           Mirror of server schemas (StockBundle, AnalysisFlagsKey, …)
│   ├── format.ts          fmt*, mosColor, recommendationColor helpers
│   ├── styles.css         ALL theme tokens as :root HEX vars
│   └── components/
│       ├── StockSidebar.tsx       Left list + ConsensusBar
│       ├── SettingsSidebar.tsx    Right pane: model/search/pplx + cached combos
│       ├── AnalysisView.tsx       Centre detail; renders all sections
│       ├── VerdictHero.tsx        AI verdict + composite + analyst hero cards
│       ├── BullBearRisks.tsx      3-column bull/bear/risks block
│       ├── ConsensusBar.tsx       3px buy/hold/sell stripe per sidebar item
│       ├── StockHeader.tsx        Logo, price, refresh button
│       ├── StockLogo.tsx          Multi-source logo cascade (Logo.dev → Brandfetch → …)
│       ├── ProgressBanner.tsx     SSE progress events while a run is in flight
│       ├── AnalyzeForm.tsx        Bottom "analyze a new symbol" input
│       ├── Toolbar.tsx            Tabs (Analyse · Übersicht) + admin cog
│       ├── Section.tsx            Collapsible section with localStorage state
│       ├── charts/                ECharts wrappers (Composite, FundamentalsHistory, …)
│       └── sections/              ValuationDetail, QualityScores, FundamentalsGrid,
│                                  PeerCompare, TechnicalSignalsPanel, PriceAction,
│                                  MarketContext, OwnershipFlow, EarningsBlock,
│                                  NewsAndResearch, CompanyInfo
```

## Storage

One rule runs through the schema: **snapshots are the truth, observations are a
projection.** The raw payload of every run lands in `snapshots` as JSONB; the
narrow rows in `observations` are derived from it by walking the same zod schema
the app validates with. Because the projection is derived, it can be dropped and
rebuilt at any time — which is what makes a schema change cheap. The file cache
this replaced could only grow its history by bumping a version number, and its
reader discarded the entire series on a mismatch. Extending history must never
cost history.

| Table | Holds |
| --- | --- |
| `symbols` | The registry, plus slow-moving identity (name, sector, ISIN) |
| `metrics` | The catalogue — one row per series, generated from the `.describe()` strings in `types.ts` |
| `snapshots` | Raw payloads (financials, market signals, models, peers, news), deduplicated by content hash |
| `observations` | `(symbol, metric, timestamp, value)` — the chart surface, ~325 values per symbol per run |
| `documents` | Distill briefings, Perplexity syntheses, verdicts, search traces — one row per version that actually changed |
| `fundamental_periods` | Reported figures keyed by fiscal period *and* observation date, so restatements are visible |
| `macro_observations` | VIX, yield curve, HY spread, DXY, FRED rates — global, stored once rather than per symbol |
| `runs` / `run_steps` | Pipeline provenance; every row above can point at the run that produced it |
| `distill_entities`, `filings`, `settings` | Mappings and operational state |
| `distill_dossiers` | Which dossier switches we have set upstream, and why any are out of sync — for companies *and* the sectors they sit in. Keyed by subject text, not by `symbols(id)`: deleting a stock is exactly when the switch has to be turned off, and a cascading row would erase that intent first |

Nothing in the codebase lists field names. Adding a valuation model to
`AnalysisResultSchema` adds its outputs to the catalogue on the next boot, and
they are historised from the next run — no `HistoryPoint` to extend, no version
to bump.

Two things stay files, under `$DATA_DIR/$SYMBOL/`:

```
submissions/           # EDGAR filings — immutable documents, indexed in `filings`
report.md/.html/.pdf   # last full CLI analysis output (CLI only, regenerable)
```

### Migrating an existing install

```bash
docker compose up -d postgres          # or point DATABASE_URL at an existing server
pnpm run migrate                        # apply the schema, seed the catalogue
pnpm run backfill --data-dir .cache --dry-run   # see what it would import
pnpm run backfill --data-dir .cache
```

Afterwards, point `DATA_DIR` at the old cache directory (`DATA_DIR=.cache`) so
the downloaded EDGAR filings under `.cache/$SYMBOL/submissions/` stay where the
`filings` index expects them — or move those directories to a fresh `DATA_DIR`.
Once the backfill has run, every `.json` file in there is inert and can be
deleted; only `submissions/` and `report.*` are still read.

The backfill distinguishes what it is rescuing: `history.json` is real past and
is imported at its original timestamps, everything else is current state and is
imported at the file's mtime. The 19 valuation models are re-run over the stored
financials on the way in, so the series that were never persisted at all start
with a value rather than a gap. It is idempotent — running it twice changes
nothing.

The web UI never silently invalidates an analysis — outdated entries stay selectable but show a ⚠ marker and a stale banner that prompts a one-click re-run.

## Nightly pipeline

One cron, one queue, one symbol at a time — configured in **⚙ Administration**,
stored in `app-config.json`, executed in-process by `src/scheduler.ts`.

Per symbol, in order:

| # | Step | What it does | Default |
| --- | --- | --- | --- |
| 1 | **Marktdaten** | Yahoo + Finnhub + FRED + macro + technicals, and one recorded history point | on |
| 2 | **Distill** | The rolling dossiers for the company and each sector it sits in, plus the raw insights those dossiers do not reproduce (`GET …/dossier/content?include=insights`). Free, with nothing to configure | on |
| 3 | **Analyse** | Only when the newest verdict is older than *max. Alter*; forced past the LLM cache so it produces a genuinely new one | on, 5 days, `gpt-5.6-terra` |

Default schedule is `0 0 * * *` (daily at midnight, `Europe/Berlin`).

Serial by design: every step talks to a rate-limited third party and writes into
the same symbol's history, and a run that has all night has nothing to
gain from racing itself. A second trigger while a run is active is refused, not
queued — cron ticks that land on a busy pipeline are skipped with a log line.

A failing step is recorded and the run continues: one dead ticker must not cost
the other forty their nightly update. The run finishes as `partial` and the admin
page shows exactly which step failed and why.

The **watchlist** decides coverage. Symbols are opted in by default — only an
explicit *off* is stored — so a stock you analyse today joins tonight's run
without anyone remembering to enable it. `▶` next to a symbol runs the pipeline
for that one stock, `▶ Jetzt laufen` runs the whole watchlist, `■ Stoppen` ends
the run after the symbol it is on.

### Recorded history

`financials.json` and `analyses/<hash>.json` are snapshots that get overwritten —
they answer "where does this stock stand now?" and throw away "where was it three
weeks ago?". `history.json` keeps the second question answerable: price, market
cap, P/E, analyst mean target, composite fair value, both upside percentages,
and — on analysis points — the verdict score, label, model and fair-value range.

Points are deduplicated per (source, calendar day), so a nightly run leaves
exactly one data point and one analysis point per day, while hitting Refresh ten
times in an afternoon does not distort the series. The Übersicht sparkline reads
from it, and `GET /api/stocks/:symbol/history` returns it raw.

## Deployment (Coolify / Docker)

One container: the Express API also serves the built SPA, so there is a single
image, a single port and a single volume.

```bash
docker compose up -d --build          # http://localhost:4317
```

In **Coolify**: new resource → *Docker Compose* (or *Dockerfile*) → point it at
this repository. Set the port to `4317`, add your API keys under *Environment
Variables* (including `POSTGRES_PASSWORD`), and let compose create both named
volumes: `stock-db` holds Postgres — the record of how every number moved, and
the one thing that cannot be refetched — and `stock-files` holds `/data`, which
is now just downloaded EDGAR filings and generated reports.

Notes that matter in production:

- **Keep it always-on.** The scheduler runs inside the process; a container that
  scales to zero has no cron.
- **Health check** is `GET /api/health`. It reads the process clock and nothing
  else, so a slow Yahoo or a two-hour pipeline run can never trigger a restart
  loop.
- **Timezone**: cron expressions are interpreted in the zone stored in
  `app-config.json` (`Europe/Berlin` by default); `tzdata` is installed in the
  image so DST switches are handled.
- **Volume ownership**: the container runs as the unprivileged `node` user
  (uid 1000). A named volume inherits ownership from the image and just works; a
  bind mount keeps the host's, so `chown 1000:1000` it first.
- **Secrets** stay in the environment. The admin page only ever reports whether a
  key is present — values are never sent to the browser.

## Distill entity resolution

Distill addresses entities by opaque UUID (`6d59e35b-…`, handle `company:microsoft`).
The old guessable refs (`ticker:MSFT`) are gone and 404 by design — an unknown
prefix is never silently reinterpreted as free text. Every Distill call therefore
goes through `src/distill-service.ts`:

1. **Resolve** via `GET /api/v1/entities/search?q=…`, using the identifiers we
   hold, best-first: **ISIN → Yahoo symbol → company name**. The ISIN is the only
   globally unique one, so it settles ticker collisions without a human.
2. **Trust by tier.** `matched_on` reports *how* a hit was found, which decides
   whether it may be taken unattended:

   | tier | auto-accept |
   | --- | --- |
   | `id`, `ref` | always |
   | `key` | ISIN/FIGI/LEI always; a ticker key only when `total === 1` |
   | `symbol`, `alias` | only when `total === 1` |
   | `name` | never — a human picks |

3. **Cache the UUID, not the ref.** `distill-entity.json` has no TTL: ids are
   stable forever, handles change on rename. It is dropped only on a version
   bump, a `DISTILL_API_URL` change, or a 404 from Distill.
4. **Never retry a 404 verbatim.** `POST /briefings/refresh` 404s on a stale id;
   `GET /api/v1/entities/{id}` then explains it — the endpoint follows merges
   (returns the merge root, which replaces our cached id) and reports the
   `quarantined`/`rejected` statuses search hides. Only then do we retry, exactly
   once. `GET /briefings` answers 200-with-empty rather than 404, so a cached id
   that suddenly yields no briefing gets the same check.

A symbol that cannot be pinned to exactly one entity is never guessed: the CLI
logs the candidates and runs without the briefing, the server answers `409
distill_entity_unresolved` with them, and the web UI lists them under a disabled
Refresh button.

## Distill dossier switch

Distill builds a dossier only while an entity's switch is on, and each one costs
money per day — so the switch is not set by hand, it follows the watchlist. It
also gates the build upstream: with nothing switched on, Distill's sweep produces
no dossiers at all, which makes this sync the thing that feeds the dossier system
rather than an optimisation of it.

`PUT /api/v1/entities/{id}/dossier` with `{"enabled": true|false}`, on the entity
UUID resolved above. The watchlist is the truth and Distill follows it, in three
rules:

1. **A failed switch never fails the watchlist write.** Adding or deleting a
   stock records the intent in `distill_dossiers` first, then fires the call
   after the response. `dossiersFollow()` does not throw, by contract — with
   Distill *and* the database unreachable it still returns quietly.
2. **The switch is idempotent both ways**, so the full sync may be blunt. What
   the ledger buys is not correctness but cost: it keeps the sync from
   re-searching the registry for symbols it already resolved, and makes a repeat
   sync send nothing at all.
3. **Off deletes nothing.** Existing dossiers stand; they stop being extended. A
   stock that comes back still has its history — which is what makes switching
   off on delete safe to do eagerly.

Wired at the three places a stock actually enters or leaves the watchlist —
`POST /api/stocks`, `DELETE /api/stocks/:symbol`, and the watchlist checkboxes in
`PUT /api/config` — so Distill is current within seconds, not at the next cron.
`syncWatchlistDossiers()` then runs at the *start of every pipeline run* (both the
in-process scheduler and the Hatchet task, since Hatchet's cron triggers the task
directly). That full pass is repair, not the mechanism: the switch that failed
while Distill was down, the symbol the registry did not know last week, the row
nobody wrote because the process died between the change and the call. Tying it
to the run means it happens exactly when the night's work is about to depend on it.

The four failure codes are four different actions, not four messages:

| code | meaning | what happens |
| --- | --- | --- |
| `401` | token missing or wrong | abort the sync; fix `DISTILL_API_KEY` |
| `403` | key has no `dossiers:write` | abort the sync — the scope is a property of the key, so every remaining symbol would fail identically. Re-issue the key |
| `404` | the entity id is stale | re-resolve (following merges) and retry exactly once, never the same call twice |
| `409` | this entity type may not host a dossier | a standing condition: recorded once, skipped from then on |
| `5xx` / network | transient | retried with backoff in the transport, then left `pending` for the next full sync |

A symbol Distill's registry does not know is a *state*, not an error: it is
recorded as `unresolved` and retried on the next run, rather than re-searched on
every config save.

### Sectors

Distill keeps sectors as entities of their own (`sector:information_technology`)
with their own rolling dossiers, so a stock's context is its company dossier plus
the dossiers of the sectors it sits in. Distill cannot derive that membership —
the `sector` field on a search hit is a different taxonomy and is often empty —
so the classification comes from us.

Ours is Yahoo's, and nothing derives one vocabulary from the other, so
`src/distill-sectors.ts` holds a translation table. It is audited against the
live `GET /entity-types` vocabulary on every sync, so a renamed or thirteenth
handle surfaces as a warning instead of stocks silently losing their sector. All
twelve are reachable today; `aerospace_defense` only from the *industry* field,
because it is a sector in Distill but an industry in ours — which is also what
makes the mapping a set rather than a value: `AIR.PA` is both `industrials` and
`aerospace_defense`.

The sectors are **derived, not switched on wholesale**. Three of the twelve touch
no stock we hold, and a dossier nobody reads still bills every day; deriving is
also the same rule companies already follow, so a sector goes off when its last
watched stock leaves. Adding a stock switches its sectors on immediately so they
start building that night; removing one does not switch them off, because whether
a sector is still wanted is a question about every *other* watched stock — the
full sync owns that.

### Reading the prose

`GET /entities/{ref}/dossier/content` is the normal path, and the briefing is the
fallback. Two reasons: the dossier read is **free** where `POST /briefings/refresh`
spends an LLM call per symbol per night on Distill's instance, and it carries a
rolling 30-day window rather than a point-in-time summary.

Branch on the `state` field, never on the status code — 404 means only "unknown
entity", everything else is 200 with a state:

| `state` | what it means | what we do |
| --- | --- | --- |
| `ready` | the prose is there | take it, plus the insights it does not reproduce |
| `not_enabled` | switch off | switch it on through the ledger; the insights already cover tonight |
| `not_built` | on, sweep has not reached it | the insights carry it until tomorrow |
| `empty` | built, nothing in the window | not a failure — the insights still come |

`not_enabled` deliberately carries no content: switching off deletes nothing, so
an artefact whose window stopped weeks ago is still lying there and would read as
the current state. `stale: true` is common and harmless — a late document landing
in an already-built tile — so it is carried through to the prompt as a note
rather than used to discard the block.

### Raw insights, and why nothing is filtered

`?include=insights` returns, alongside the dossier, the raw statements that
dossier does **not** reproduce. They arrive in every state, so a just-switched-on
entity has material immediately — which retired `POST /briefings/refresh`
entirely. Nothing here spends LLM budget on Distill's instance any more, so the
key needs no `briefings:write` scope, `DISTILL_BRIEFING_TYPE_ID` is gone, and so
is the `refresh`/`fetch` switch on the admin page: with no paid call left there
was nothing for it to decide. Bundles written before this still carry a
`briefing`, and the UI renders one if it finds it; nothing produces them.

The membership rule is Distill's and is about **provenance, not dates**, which is
the one thing easy to get wrong here. It is tempting to think the insights are
"everything since `period_end`" and to filter on that. They are not: a document
that arrives late, carrying a date inside the window, never makes it into the
dossier text — that is precisely what marks a dossier `stale` — and a cut at the
window's end would drop it from *both* sides. Hence `insights.from` is the period
**start**, and the list is passed through untouched. `from`/`to` exist to tell the
model which span it is looking at, not to derive a boundary from.

Three details the prompt depends on: `at` is the news date (Distill's period
axis), not when it was ingested; `count` is the length of the list, never a
total, so only `truncated` says more exist; and the list is cut newest-first
upstream but handed back chronologically.

The prompt renders them under the dossier as a separate, explicitly weaker class
— unsynthesised single statements, one line is one source — and caps sector
insights, since two sector blocks of thirty days of industry chatter would
otherwise outweigh the company's own dossier.

### Why the prompt has two sections, not one

Company and sector prose used to sit under a single heading that called its
contents "your strongest qualitative signal", and each sector block then spent a
paragraph walking that back. Structure outweighs prose in a prompt: material
filed under a strong-weight heading reads as strong-weight material however the
sentences hedge. So there are two sections — `### Distill Dossier — <symbol>`
carrying the strong-weight claim, and `### Sector Context (background, NOT about
<symbol>)` after it.

That also handles the volume problem the labelling alone could not. Two sector
dossiers routinely outrun the company's several times over — Airbus is 4k
characters of its own against 32k of industry — and length is a signal in itself.
Under a heading that says background, length reads as thoroughness about the
backdrop rather than as importance to the company.

Every block reaching the analysis prompt states its scope, and sector blocks say
plainly that a sector-level claim is not a company-level finding. That is not
decoration — a sector dossier read as company-specific is the observed failure
mode of this integration.

## Development

```bash
pnpm dev              # everything: Postgres + migrations + API + Vite
pnpm dev:stop         # stop the Postgres container again
pnpm dev:cli          # CLI watch mode (tsx)
pnpm run serve:watch  # API server watch mode
pnpm run build        # compile TypeScript → dist/
pnpm run web:build    # build the Vite bundle
pnpm run typecheck    # type-check src and test without emitting
pnpm test             # node:test via tsx — no database or network needed
```

## License

MIT
