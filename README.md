# stock-cli

Fundamental stock analysis from the terminal *and* a local web UI. Fetches live financial data, runs 19 valuation models, then asks an LLM for a structured bull and bear case — theses, figures and triggers per side — with a composite fair-value range.

```
CLI mode  →  one-shot analysis, prints markdown or JSON to stdout
Web mode  →  persistent local app: one ranked list of cached stocks at two
             densities, flag toggling, chart-rich detail view, no LLM call
             until you explicitly Run
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
| `PPLX_API_KEY` | Perplexity Sonar — forensic web research for the narrative stage | optional | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| `DISTILL_API_KEY` + `DISTILL_API_URL` | Distill — rolling dossiers per company and sector, plus raw insights | optional | mint in Distill Admin → Project → Access keys, scope `dossiers:write` (no `briefings:write` needed) |
| `BRAVE_API_KEY` | Brave web search | optional | [brave.com/search/api](https://brave.com/search/api/) — $5 free credits/mo |
| `TAVILY_API_KEY` | Tavily web search | optional | [tavily.com](https://tavily.com) |
| `FRED_API_KEY` | Live rates and macro (10Y, AAA, credit spreads, local 10Y yields, VIX, DXY, yield curve) | optional | [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) — free |

Minimum to get started: `ANTHROPIC_API_KEY` + `FINNHUB_API_KEY`.

With `FRED_API_KEY`, Graham Revised, DDM, EPV, the 2-Stage DCF, RIM and Sortino models pull live rates instead of hardcoded fallbacks: the 10-year Treasury, the Aaa yield, ICE BofA credit spreads per rating bucket (the cost of debt), and ten-year government yields for listings that trade outside the dollar (`LOCAL_TEN_YEAR` in `src/data/fred.ts`). The equity risk premium needs no key — it is Damodaran's monthly implied ERP. A rate that fails to load falls back to the last reading in this process, then to the last value recorded in the database (so a fresh CLI run or server start does not discount with a constant because Damodaran's spreadsheet timed out once — that put Apple's WACC at 11.0 % instead of 9.5 %), and only then to a constant; it is retried within minutes, a warning names which fallback the premium used, and only rates actually read are recorded. The key also unlocks the macro context block (VIX regime, yield curve, HY spreads, DXY).

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

There is one list of stocks, shown at two densities. There are no tabs and no toolbar above it: the list *is* the app, and whether a stock or the administration is open on top of it is a fact about state rather than a place you navigate to.

**Übersicht** — the list at full width, and the resting state: the headline score with its change since the first recorded point and, underneath, the two halves it was blended from (see [Score and verdict](#score-and-verdict)), a sparkline of the score over time, the verdict label, the factor score's rank among every stored stock (the reference universe included) and the model, price, analyst mean target, composite fair value, both upside percentages, where the price stands on its chart (see *When to buy* under [The backtest](#the-backtest)), the dividend yield, market cap and how old the data and the verdict are. Sorted by score descending by default; search, a watchlist-only filter, six other orderings and the ⚙ share one header row — the table's own, so the window spends no line on chrome that only navigates.

**Was ist passiert** (the pulse icon beside the chart icon, `#/feed`, `GET /api/feed?days=7`) — every watchlist stock's timeline over the last day, week or month on one axis: rating changes and target moves, insider trades, the quarter's numbers, our own verdict changes, dated research findings, the days a price jumped, headlines on request — and the reports due in the next two weeks above them. Built from the same per-stock timelines (`watchlistFeed` in `src/stock-history-service.ts`), so an event reads the same in the feed as on its stock's page. The strip of verdict changes above the list links to it.

**Journal** (the notebook icon, `#/journal`) — my own notes, purchases and sales, and why: a day, a kind, the stocks it names (in a field or as `$TICKER` in the markdown) and the text. Each entry shows how its stocks have moved since its day; an edit keeps the wording it replaces, one click away, because a reason rewritten after the fact is hindsight. Entering a purchase or a sale shows the situation first — the last five and twenty trading days, the volume against the usual, the year's high, our verdict, a report due within the week (`src/analysis/entry-context.ts`) — and asks whether the trade would happen without it. With umsatz connected, every purchase and sale there without an entry is listed under *Ohne Begründung*, one decision per stock and day, to be explained or dismissed (`src/trades-service.ts`). Entries also appear on the stock's timeline and in the feed. A stock page carries its own entries under *Mein Journal*. The journal feeds nothing into the score.

**Research by hand** (in *Research & News* on a stock page, and *Themen-Recherche* on the journal page) — prompts to copy into a chat app's research mode, and the answer pasted back (`src/research/`): the company brief (kept as the deep research report every analysis reads), *Vor den Zahlen* (the setup going into the next report), *Thesen-Check* (my journal entries on the stock, tested against the evidence, disconfirming evidence first), a theme across several stocks, and *Rückblick-Check* on the review page: one decision, its reason as written, the situation that day and the stock against the index since, judged on whether the reason held and whether the result came from it or from something it did not consider — with one lesson for the next decision. Shares and amounts never go into a prompt. What a paste was read as shows before it is kept; prose without JSON is kept as prose.

**Depot** (the briefcase icon, `#/depot`, `GET /api/depot`) — the positions summed from umsatz's trades at moving-average cost, valued at its euro prices, against the model: weight, gain, verdict, sector, the reason in the journal and the newest thesis check, with what stands out — a position above 15 % (funds excepted), a sector above 35 % of the stocks, a SELL verdict, a contradicted thesis, a purchase without a reason — and the watchlist's BUYs not held. No target weights: the score as a portfolio rule failed the test fixed before the backtest ran, so beside the verdicts stands what each has been worth there (`src/analysis/depot.ts`). The holdings are real; see CLAUDE.md for how to work with them.

**Rückblick** (linked from the journal and the depot, `#/review`, `GET /api/review`) — every purchase and sale, from the journal and from umsatz, each decision once (an entry and the trades it explains are one, dated by the trade), measured the way our verdicts are: against the S&P 500, one to twelve months on and up to today (`decisionOutcomes` in `src/stock-history-service.ts`, the verdict record's own `callOutcomes`). A purchase was right when the stock beat the index afterwards, a sale when it lagged. Beside each, the reason given and the situation it was made in, read as of that day; above them the groups compared — after a run, a jump or a crowd against the rest, with the model against it, with a reason against without — each with how many decisions it rests on, and sentences only where both sides have at least five (`src/analysis/review.ts`).

**Analyse** — the same list collapsed to a rail, with one stock open beside it. A row click opens it; clicking that same row again closes it, as does the **✕** at the top right of the analysis, or `Esc`.

The list does not move when any of that happens. The two densities share the row markup for every column both of them show (`StockRowCells.tsx`) and declare one row height between them, so a row is the same two lines at the same size on either side of the click. The scroll position travels as *which stock was at the top of the box, and how far down it sat* — the one thing a table and a rail can both honour, since pixels do not survive a trip between two different elements. The rail carries the same sticky column-label row as the table for the same reason: without it the two scroll boxes start their content at different places, and the list at the very top cannot be reproduced at all.

Measured across the list, the stock you clicked lands on the pixel it was on, going in and coming back. Where the browser supports view transitions the columns fade rather than vanish between frames.

- **Left rail**: the ranked list minus the columns 320px has no room for — name, ticker, score and a 3-segment buy/hold/sell consensus stripe (AI verdicts + analyst counts, AI weighted 0.6). It carries the search box and nothing else, with the count tucked inside the field: sorting and the watchlist filter belong to the table, and every row of header here is both a stock the rail cannot show and a row of drift in the transition. Both densities drive the same filter state, so neither can disagree with the other about what it is looking at.
- **Center pane**: full analysis — verdict card with the score's composition underneath, composite fair value (primary + conservative tiers), bull and bear case, valuation over five years, valuation models, fundamentals (history, margin trend and today's figures in one section), peer comparison, technical signals gauge (TradingView-style), price action, ownership flow, news & research.

  **Wie der Score entsteht** is a strip under the three verdict cards rather than a section of its own: the blend as one line (Zahlen × weight + Text × weight → score), the six pillars with their weights, and the five narrative dimensions. Findings, method and the two prose reads sit behind *Befunde & Begründung*, which remembers being opened; the two prose reads are also a hover on their half of the formula.

  **Five views read the archive back** (`src/stock-history-service.ts`, all reads, no fetches):
  - **Analysten: Trefferquote** — every archived price target against the close twelve months later, targets from before a split put on today's basis: how far the price ended from the target, whether it was reached within the year, whether the stock moved the way it implied — per firm and overall — and the consensus of a year ago drawn against the price it promised. For Apple, 839 targets since 2018: the price ended a median 12 % *above* the target, 76 % were reached; Barclays' underweight got the direction right in 28 % of cases.
  - **Unser Urteil: Trefferquote** — the same question turned on us (`src/analysis/verdict-record.ts`): every change of the published verdict, read off its stored series, as a dated call, with the stock against the S&P 500 (SPY, dividends included, a foreign listing restated in dollars) one, three, six and twelve months later and for as long as the verdict held. A buy was right when the stock beat the index, a sell when it lagged; a hold is only measured. A change counts once it has held through the next day's reading, as in the list of verdict changes. The same calls across every stock are a tab of their own under **Auswertung**, *Unsere Urteile*: the median excess return and the hit rate per verdict and horizon (`GET /api/verdict-record`).
  - **Zeitleiste** — rating changes and target moves, insider purchases and sales, the quarter's numbers, dividends and splits, our own verdict changes, dated findings from every research brief, headlines, and the days the price moved more than three of its own standard deviations (at least 5 %), filterable by kind, with the next report on top. A quarter's numbers are dated the day they were first stored — within a night of the report — and a quarter that came in with the history, long after its end, at the quarter's end.
  - **Aktionäre**, under ownership — the largest institutions and funds with the change since their previous report, the insiders' stakes, six months of net buying, every insider trade on file. Each institution's stake becomes a series as the reports accumulate.
  - **Vom Umsatz zum Gewinn**, under fundamentals — the income statement as filed, as a flow, for the last four quarters or any fiscal year, in the reporting currency. A loss is drawn as the shortfall it is, and other income that covers it flows into that shortfall: Ondas' operating loss of 225 million, covered by 360 million of revaluation gains, still ends in a net profit.

  **Bewertung im Zeitverlauf** answers what one day's numbers cannot — whether today is unusual for this stock. Every month-end of the last five years is rebuilt from the SEC filings known that day and run through the live models (`src/backtest/history.ts`, the backtest's own reconstruction for a single stock), giving three views: the reconstructed fair value against the price, with the range the gap usually sat in ("meist zwischen 54 % über und 17 % unter dem rekonstruierten Fair Value; heute 45 % darüber — teurer als in 70 % der Monate", worded from the fair value, so a price at a third of it reads 67 % below rather than 200 %); the price against earnings times the stock's median P/E, FAST-Graphs style; and each of P/E, P/S, P/FCF and EV/EBITDA against its own three- and five-year median, with the price the median multiple implies. Medians rather than means, because ServiceNow's P/E of 640 on near-zero 2021 earnings put its five-year mean at 210. Beside the history, each multiple's median and rank across the stock's industry in the universe, and a **fair P/E and P/S**: a regression of each multiple, in logs, on revenue growth, operating and gross margin, beta and sector across the universe (`src/analysis/fair-ratio.ts`), read through the stock's own inputs — whether the premium over the industry is one the fundamentals pay for. The R² travels with every answer (about 0.56 for P/S, 0.25 for P/E), below 0.2 there is none, and a loss-maker gets no fair P/E. The analyst target in it is the consensus of each month-end rebuilt from the archived rating history (each firm's newest target from the year before, `src/analysis/analyst-history.ts`); peer multiples cannot be rebuilt for one stock alone and are missing, so the rebuilt fair value differs from the headline composite — it is consistent with itself, and today's live value is drawn beside it. A listing without XBRL filings gets the earnings and multiples from Yahoo's fiscal years instead, without a fair value. The first open of a stock each day takes a few seconds (a SEC download and two price histories); the result is cached as a `valuation_history` snapshot for a day.
- **Analyse dialog** (the combination named on the verdict card, or „Andere Einstellungen…" in the refresh menu): every flag combo is its own cached entry, so the dialog lists what is stored — one click shows that one, and costs nothing — and underneath it holds the model, web-search and Perplexity pickers with the button that spends money. Outdated entries stay selectable and carry a ⚠.

  It used to be a permanent third column, which gave a panel you touch a few times a day the same standing as the analysis itself and a fifth of the window to say it. Both of its jobs are moments rather than states, and a run that costs an API call is better confirmed in a dialog than fired by a stray click on a sidebar button.
- **↻ Refresh** (header) is a menu, because pressing it can mean three things that cost different amounts. **Nur Daten** re-fetches the data layer (Yahoo + Finnhub + FRED + technicals + Distill) without a single LLM call. **Alles** does that, waits for it, and then re-runs the analysis with the combination on show — in that order because a run only fetches financials when they have *expired*, so re-running on its own can score a company on numbers that are hours old. **Andere Einstellungen…** opens the dialog.

  When something is out of date the button carries a yellow **!**; its tooltip says what, and the menu marks the entry that fixes it. That replaced a yellow banner across the page, which only appeared after a first refresh and put its own two buttons next to this one — so a full run used to take three places and the right order.

- **Peers** (header) opens a dialog listing who else is in the business, each with its score and market cap, the stock itself pinned on top for comparison. Two groups: **Finnhub's peer group**, the companies the peer medians in the analysis are computed from, and **the same Yahoo industry** across the list and the reference universe. The second group is what gives a European listing peers at all, since Finnhub's free tier has none for it. A company already on the list opens with one click; the rest carry **+ Hinzufügen**, which is the add below, so several can be added in a row without leaving the dialog. `GET /api/stocks/:symbol/peers` reads it all from the database; only a Finnhub peer never stored costs one batched Yahoo quote, for its name. Share classes and second listings of one company count once.

  A dialog rather than one more section: the question comes up when a stock is opened, not after scrolling past its valuation models, and it ends in adding stocks — a moment, not a state.

Adding a stock (`+ Hinzufügen` at the bottom of the window, under either density) resolves the ticker or company name and fetches the data layer — **no LLM call**. The verdict is a separate, explicit run from the Analyse dialog, so looking a company up never costs an API bill.

**⚙ Administration** — schedule, pipeline steps, watchlist and run log; closed by the same ✕, in the same corner. See [Nightly pipeline](#nightly-pipeline) below.

**URLs**: `#/stock/AAPL`, `#/overview`, `#/admin`, `#/feed`, `#/evaluation`, `#/journal`, `#/depot`, `#/review` — reload and browser back/forward work everywhere. No hash is the list. Old `#AAPL` links still resolve to a stock.

Collapsing back to the table never interrupts a running analysis: the analysis pane stays mounted (hidden) so its progress stream survives the detour.

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

# Perplexity research brief (separate from --search; a structured, graded brief)
npx tsx src/cli.ts MSFT --pplx                       # sonar-pro
npx tsx src/cli.ts MSFT --pplx sonar-reasoning-pro

# Model IDs — the registry lives in src/models.ts
npx tsx src/cli.ts NOW  --model claude-opus-5-5 --search brave
npx tsx src/cli.ts NOW  --model gpt-6.1-sol

# …or the short alias for the same thing
npx tsx src/cli.ts AAPL --model opus        # claude-opus-5-5
npx tsx src/cli.ts AAPL --model fable       # claude-fable-5-1
npx tsx src/cli.ts MSFT --model sol         # gpt-6.1-sol
npx tsx src/cli.ts MSFT --model astra       # gpt-6-astra
npx tsx src/cli.ts MSFT --model luna        # gpt-6-luna
npx tsx src/cli.ts MSFT --model mini        # gpt-5.4-mini
npx tsx src/cli.ts MSFT --model haiku       # claude-haiku-4-5-20251001

# --model picks the SYNTHESIS model — the one that writes the thesis. The two
# summariser stages run on the cheap model from `scoring.summaryModel`
# (default gpt-5.4-mini), and neither of them sets the score. See "Score and
# verdict" below.

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
                        Model IDs: claude-sonnet-5-5 | claude-opus-5-5 | claude-fable-5-1 |
                                   gpt-6.1-sol | gpt-6-astra | gpt-6-luna | gpt-5.4-mini
                        Aliases:   claude | sonnet | opus | fable | sol | astra | luna | mini
                        Any other: claude-* | gpt-* | o1-*
  -s, --search [type] Web search — omit value for native search of active model
                        none | claude | openai | brave | tavily
                        (can be comma-separated for multi-source: brave,tavily)
      --pplx [model]  Perplexity brief — sonar | sonar-pro | sonar-reasoning-pro | sonar-deep-research
                        (default sonar-pro)
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
| 1 | **DCF (revenue-driven, simulated)** | Revenue grows along the consensus path (current and next fiscal year) and fades to stable growth by year ten with a half-life of ~2.5 years; the operating margin moves over five years from today's to a target (the consensus-implied margin, else the recent years' average, else halfway to the peer median); tax converges to the country's marginal rate; growth is paid for with reinvestment at the firm's sales-to-capital ratio (revenue over tangible operating capital). Ten years of FCFF, mid-year discounting, terminal value NOPAT × (1 − g ÷ ROIC) / (WACC − g). 512 deterministic draws over growth, target margin, sales-to-capital, discount rate and terminal growth give a distribution and the probability that the value exceeds the price. Not applied to banks, insurers, brokers and lenders. |
| 2 | **Reverse DCF + margin the price requires** | The same model run backwards: the revenue growth (years 1–2) at which it equals today's price, beside the consensus; and the target operating margin the price requires, held against the best margin already shown (today's, the recent years', or the peer median). Works for pre-profit firms. |
| 3 | **Graham Number** | `√(22.5 × EPS × Book Value)` on normalised earnings per diluted share |
| 4 | **Graham Revised (V\*)** | `EPS × (8.5 + 2g) × 4.4 / Y` — Y the AAA spread over Treasuries on top of the stock's own currency's government yield; g the 3-year EPS CAGR, capped at 15 % |
| 5 | **Peter Lynch** | `EPS × (g + dividend yield)` in percent, g the next-year consensus EPS growth (else the 3-year CAGR), capped at 25 %, abstaining below 5 % or on a falling consensus |
| 6 | **EPV (Greenwald)** | Average operating margin of the last five fiscal years × trailing revenue, after the marginal tax rate, capitalised at WACC, plus the equity bridge; not applied to lenders |
| 7 | **DDM (two-stage)** | Dividend grows at its own five-year rate (≤ 15 %) for five years, fades over five to the firm's stable growth — the DCF's rule — Gordon after; CAPM required return, moving over the fade to a mature firm's at beta 1 |
| 8 | **Excess Return (RIM)** | Book value + PV of returns above the cost of equity, ROE fading over ten years to the cost of equity plus half of today's excess, then a perpetuity. The headline model for banks, insurers and lenders |
| 9 | **NCAV (Graham Net-Net)** | Current assets − total liabilities, ⅔ × NCAV buy threshold |
| 10 | **Peer Multiples** | P/E, EV/EBITDA, EV/Revenue, P/FCF, P/B, P/S vs Finnhub sub-industry medians (industry where the sub-industry is thin, except for financials); peers a fiftieth of the company's size, its own other share classes and negative multiples are left out; lenders are priced on P/E and P/B only. The median gives each fundamental one vote |
| 11 | **Composite Fair Value** | Primary (market-aligned) and Conservative (value-investor) tiers, each the weighted median of the models' log values — a DCF resting on its terminal value, a peer group under five and Lynch's rule of thumb count half. The valuation pillar aggregates the same models held to 0.4–2.5× of the price, as a weighted mean of logs |
| 12 | **EV Multiples** | EV/EBITDA, EV/Revenue, EV/FCF, P/FCF, P/S TTM, forward P/S |
| 13 | **Simple Valuation Ratio (P/S Run-Rate)** | `marketCap / (latest_quarter_revenue × 4)` — reacts to growth inflections faster than TTM P/S. A seasonally adjusted twin (last four quarters grown at the latest quarter's YoY rate) flags quarters that are seasonal highs or lows. Benchmarked against a peer run-rate P/S: each peer's P/S TTM converted with its latest-quarter growth |
| 14 | **Rule of 40** | Trailing revenue growth % + operating margin % |
| 15 | **Piotroski F-Score** | 9-signal fundamental quality screen (F1–F9); F5 passes a firm with no debt in either year, F7 compares weighted-average share counts year over year |
| 16 | **Altman Z-Score** | Original Z (manufacturing) or Z″ (everything else) |
| 17 | **Interest Coverage** | Trailing operating income / interest; unknown — not excellent — where there is debt but no interest reported |
| 18 | **Sortino Ratio** | Risk-adjusted return using downside deviation, live risk-free rate |
| 19 | **Beneish M-Score** | 8-variable earnings-manipulation detector on the newest fiscal year against the one before, gated on min variable coverage; one reading (`beneishReading`) for every consumer |

**The conservative tier only counts models that fit the company.** Measured
over the watchlist, its median sat below 0.3× the price for 20 of 31 stocks —
less a value lens than a price-to-book ratio in disguise, because three of its
five models were being run outside the firms they describe:

- **Graham Number and the excess return model abstain above 40 % ROE**
  (`BOOK_ANCHOR_MAX_ROE`) outside the financials. Both start from book value,
  which stops being the capital base once a company has handed it back through
  buybacks or never needed much. The Graham Number is √(22.5 · EPS · BVPS),
  i.e. a function of P/E × P/B alone; the old RIM capped ROE at 30 % *and* kept
  the shrunken book, and valued Mastercard (ROE 241 %) at 3 % of its price.
- **DDM abstains below a 40 % payout ratio** (`DDM_MIN_PAYOUT`). A dividend
  model values the dividend stream and nothing else — the business itself for a firm
  paying out most of its earnings, a rounding error for NVIDIA (1 %) or
  Alphabet (4 %), which it priced at 4 % of the share price.
- **The value-lens criterion needs two surviving models**
  (`CONSERVATIVE_MIN_MODELS`); one is not a lens — Berkshire's came down to
  Graham's V* alone and scored 10/10 on it.

Excluded models are listed with their reason in the composite's exclusions.
Graham's V* and EPV stay for everyone: they value earnings, not the balance
sheet, and a no-growth value that sits far below the price is exactly what the
lens is for. Where book value is the right anchor and the price is simply far
above it — Tesla, AMD, ServiceNow at 0.05–0.13× — the reading is unchanged.

### The DCF is built from revenue

The first DCF grew this year's free cash flow at next year's consensus *EPS*
growth for five years. On the watchlist that produced three kinds of error:

- **EPS growth is not cash-flow growth.** It carries buybacks, tax changes and
  margin recoveries. Honeywell's consensus EPS grew 20 % on revenue up 2 %, and
  five years of that priced it at 3.2× its share price.
- **A forecast the code disliked was replaced by the past.** A negative
  consensus was discarded and the three-year history took its place. Novo
  Nordisk, with analysts expecting earnings to fall 3 %, was compounded at 24 %
  a year and valued at 4.4× its price; Alphabet, at 3.3×, the same way.
- **It jumped.** Today's reinvestment rate was assumed for ten years and then
  replaced overnight by the steady-state one in the terminal value.

So `src/analysis/dcf.ts` builds the forecast the way Damodaran does. Revenue
follows the consensus for two years and then fades towards stable growth with
a half-life of about two and a half years — revenue growth is far less
persistent than it looks (Chan, Karceski and Lakonishok, 2003). The operating
margin moves in five years from today's to a target. Where the consensus
expects a different margin — earnings growing faster or slower than revenue —
that is the target. The target is derived from growth rates only, because
Yahoo quotes a foreign listing's EPS estimates in whatever unit the analysts use
(Alibaba's in yuan per ADS, Sanofi's in euros per ordinary share). Otherwise the
target is the firm's recent average, or halfway to the peer median. Tax moves
to the country's marginal rate. Every dollar of growth is paid for at the
firm's sales-to-capital ratio: revenue over tangible operating capital, so
AMD's Xilinx goodwill does not make its organic growth look three times as
expensive as it is.

Free cash flow is what is left. The model never reads this year's free cash
flow at all, so a capex spike or a working-capital release cannot become a
valuation. Stock compensation is a cost, because the operating margin is after
it.

The rest of the discounting follows from the same review:

| Input | Now | Why |
|---|---|---|
| Beta | Two thirds its own regression beta, one third the peers' median beta — else 1 — within 0.8–2.0 | A five-year regression beta drifts a third of the way back in the next window (Blume). Back towards what is known about stocks like it, not towards the market (Vasicek): a chipmaker measured at 1.1 on a quiet five years is likelier a 1.3 business than a 1.0 one. A stock with no beta takes its peers'. The floor stays because a European ADR against the S&P 500 read 0.28 and discounted Sanofi at 7 % |
| Equity premium | Damodaran's implied ERP + the headquarters country's premium over the US | The implied ERP is measured on the S&P 500. Nu and MercadoLibre were being discounted as if they operated in Ohio |
| Local risk-free rate | The currency's ten-year yield less its government's default spread over the US | A Mexican or Indian yield prices that government's credit risk too |
| Cost of debt | Risk-free + rating spread + the country's default spread | — |
| Terminal WACC | Beta 1, debt capped at 30 % of capital (`MATURE_MAX_DEBT_SHARE`) | Fresenius Medical's 50 % debt put its terminal WACC at 6.8 % against 5.2 % growth, a perpetuity worth 60 years of profit |
| Stable growth | The second-year growth rate, held between half and all of the risk-free rate, and two points under the terminal WACC (`stableGrowth`); the dividend model's perpetuity follows the same rule, under its cost of equity at beta 1 | No firm outgrows the economy for ever, and one the consensus has growing at 3 % does not accelerate into perpetuity. The dividend model used to grow every payer's dividend at the risk-free rate for ever: at a 5 % Treasury yield and a low beta the perpetuity was worth thirty years of the dividend |

The model answers with a distribution. Five inputs are uncertain: growth
(±25 % of the rate + 3 points), the target margin (±20 %), sales-to-capital
(±30 %), the discount rate (±1 point) and terminal growth (up to 1.5 points
below the risk-free rate). 512 draws from a Halton sequence give the same
answer every run and every re-score (`sampling.ts`). The share of draws above
the price is kept as `distribution.probabilityAbovePrice`, and p10/p90 replace
the old fixed ±50 % bear and bull cases.

Only an implausibly *high* value counts as a data anomaly now that shares and
currencies are reconciled upstream. A value near nothing is an answer — Intel's
foundry build-out consumes every dollar the forecast earns — and discarding it
had left a peer multiple to speak for the whole valuation.

**Banks, insurers and lenders** get the excess return model instead: book value
plus the return earned above the cost of equity, fading over ten years to the
cost of equity plus the durable half of today's excess. A lender is anything
filed as a bank, insurer or broker, or a financial company paying at least 15 %
of revenue in interest. The old residual-income model stopped excess returns
dead after year five and so priced every good bank at little above its book.
Finnhub's sub-industry for Berkshire holds only shell companies, dropped by the
size filter, and an insurer does not fall back to the industry grouping of
payment networks. No peer group is the honest answer there.

**Aggregating the models.** Each tier's published median is the weighted
median of the models' logs, where a model at half the price and one at twice it
balance. The valuation pillar holds every model to 0.4–2.5× of the price first
and then takes the weighted *mean* of the logs. A median over two models is
whichever one weighs more, so Intel's half-weight DCF next to a full-weight peer
multiple had come out as the peer multiple alone. The bounded mean lets both
speak and neither shout.

**The model's own premium.** Damodaran's implied premium is the one at which
*his* cash flows for the S&P 500 equal its price. Ours are harsher: growth fades
within ten years, taxes converge to the marginal rate, and reinvestment is paid
for at the firm's own sales-to-capital. At his premium the DCF valued the
median stock of the universe at 71 % of its price, and seventy per cent of all
stocks below it. That was a statement about the model, and it was printed on
every detail page as though it were one about the market.

So the models discount at the market's premium plus an adjustment
(`modelPremiumAdjustment`). `pnpm run calibrate` measures the adjustment: for
every stock, it finds the shift of the premium at which the model that carries
it — the DCF's base case, or for a bank, insurer or lender the excess return
model — equals the price, and takes the median of each group of stocks. A
stock that no shift within four points can reach sits at the edge of that
range rather than dropping out. The ones the model finds dearest need the
largest cut, and leaving them out pulled the median towards zero. The
adjustments are committed with the calibration table. At runtime a stock's
premium is Damodaran's month plus its group's adjustment, never below 1.5 %. The DCF's assumptions line shows both parts. A fair value now says
which stocks are cheap for this model, and the market as a whole sits near its
price, as the implied premium says it should.

Measured on 27 September over 527 DCFs, the adjustment is −1.75 points. The
median DCF moved from 0.72 of the price to 1.04, and the median probability of
a value above the price from 13 % to 43 %. The monthly backtest measures the
same thing for every month since 2013 and finds between −2.2 and +1.3 points.
The model is harsher than the market in expensive years and gentler in cheap
ones, which is what a fixed set of cash-flow assumptions against a moving
market does.

**By group (8 October 2026).** One adjustment for every stock did not fit. The
universe is nine tenths American, so the −1.75 points were the American
firms'. Measured by group, the euro area's firms needed +1.3, and banks and
insurers, carried by the excess return model, needed none in dollars and +1.8
in euros. With the one number the euro firms' median DCF stood at 2.4 times the
price, the median lender's excess return value at 1.7 times, and the verdicts
followed: 23 % of the euro firms and 8 of the 13 euro lenders read as buys,
against 8 % of the American firms. Damodaran's premium had also fallen from
4.09 % to 3.70 % since the calibration, so even the American DCFs had drifted
to 1.06 times the price.

Now a stock's group is its trading currency and whether it lends
(`premiumGroups`); a group under 20 stocks takes the next wider one's — the
currency's, then the lenders' or firms', then all stocks'. Recalibrated on the
same 595 stocks: American firms −1.70 points, American lenders +0.05, euro
firms +1.30, and the euro area as a whole +1.60, which its thirteen lenders
take. The euro firms' median DCF is at 1.12 times the price, 10 % of them read
as buys; the median lender's excess return value is at 1.00 in dollars and
1.03 in euros. Five of the thirteen euro lenders remain buys, on momentum, the
balance sheet and a value lens that sits high for every lender, American ones
too — not on the premium any more.

The backtest measures the lenders' own adjustment every month now, on their
excess return model: +0.11 points in the median of 165 months against the
firms' −0.63, and in 2021 +2.73 against −0.98. Over the S&P 1500 the score did
not move — 0.014 (t 2.3) at one month, within the sector t 2.4 before and 2.5
after — and the lenders' intrinsic value ranks as it did (0.038, t 2.3, against
0.035, t 2.2); the live comparison stays at ρ 0.75 with 80 % the same verdict.
The euro groups it cannot test.

This makes a fair value relative to the stock's own market. Whether European
stocks are cheap or that market asks for more premium, the backtest, which
knows only American ones, cannot say; before, one American number decided it
unseen.

## Score and verdict

Score and recommendation used to come out of one LLM call: the models, the
technicals, the revisions and two dossiers went in as ~8k tokens of prompt, and
the weighting was a paragraph of prose asking for "descending order of
authority". Two runs over the same payload landed several tenths apart, the
recorded score series charted as much model noise as company, and the guard
against bad data — "a flagged payload does not support a STRONG BUY" — was a
sentence the model was free to skim.

It is arithmetic now, and the model writes the words around it.

### The factor score (`src/analysis/score.ts`)

Six pillars, each a weighted mean of named criteria, each criterion a number
this repo already computed mapped onto 0–1 by an explicit linear ramp. Ramps
rather than thresholds: a cliff at "P/E below 15" puts a step in the middle of
the range most companies sit in, and a stock oscillating around it would flap
between BUY and HOLD on a rounding error.

| Pillar | Weight | Reads |
|--------|--------|-------|
| **Bewertung** | 30 % | The share of the DCF's 512 scenarios above the price (else our other models in logs), own multiples against the peer medians, the margin the price requires against the best one shown, and the conservative tier as a value lens |
| **Qualität** | 20 % | Piotroski (abstains below 5 computable signals), ROIC minus the DCF's own WACC, gross profit over assets, margin vs peers (operating against operating, net against net), four-quarter revenue growth vs peers, accruals, net share issuance, Rule of 40 |
| **Bilanz & Risiko** | 15 % | Altman Z as a position between its own model's thresholds, interest coverage, net debt / EBITDA, current ratio (without prepaid revenue where it is material), Beneish |
| **Analystenkonsens** | 15 % | Weighted rating (Strong Buy +2 … Strong Sell −2), mean-target upside |
| **Markt & Momentum** | 10 % | Return over twelve months skipping the last, closeness to the 52-week high, relative strength vs the sector ETF |
| **Erwartungen** | 10 % | 30-day EPS estimate drift, revision breadth (net revisions over the analysts publishing), surprise history, month-over-month rating change over the analysts covering |

Three properties the code is built to keep:

- **It decomposes exactly.** Every criterion carries its signed `impact` in score
  points, and they sum to `raw − 5`. "Why 7.2" is answered by listing rows.
- **Missing inputs cost coverage, not points.** A criterion with no data is
  dropped and its pillar renormalises; a pillar with nothing at all is dropped
  and the remaining weights renormalise. Nothing scores 5/10 for being unknown,
  because that quietly votes "average".
- **Uncertainty shrinks the score toward neutral, corroboration carries it
  away.** `score = 5 + (raw − 5) × trust × conviction`. Trust is `0.4 + 0.6 ×
  confidence`, where confidence combines coverage, the composite's own
  confidence, the data-quality audit and whether the fundamentals are stale.
  Conviction is agreement — see below.
- **The ends of the scale are approached, not hit.** The stretch is linear with
  no ceiling, and a unanimous, well-covered case overshot: Alphabet came to
  10.24 and was clipped to a perfect 10.0 it would have shared with anything
  else past the edge. `saturate` leaves the deviation untouched inside ±3 (the
  STRONG bands, read from `SCORE_BANDS`) and bends it beyond with a tanh that
  meets the line at the same slope: order is kept, 10 and 0 are reached only in
  the limit, and no label changes, because everything past the knee was already
  STRONG. Alphabet now reads 9.6, Nu 9.1.

### Every criterion is read against where the typical stock sits

A criterion maps a figure onto 0–1 points, and the score treats 0.5 as "says
nothing either way". With hand-set ramps that was an assumption, and on the
watchlist it was wrong for most criteria:

- The analyst rating averaged +0.43 on a −1…+1 scale, so the median stock scored
  7.1 on it. Sell-side ratings lean buy.
- Three quarters of all quarters beat the consensus, so beating it was worth 7.5
  for the typical company.
- The balance-sheet pillar had a median of 8.6, with seven stocks at a perfect
  10. The valuation pillar's neutral point was a 15 % margin of safety.

Two pillars that always vote bullish are not evidence; they are an offset. They
added half a point to every raw score. Worse, because agreement counts
directions, bullish cases looked corroborated (conviction 1.33 on average) and
bearish ones contested (1.20).

So every criterion is read as a **percentile** (`src/analysis/calibration.ts`):
the figure's rank among the same criterion measured across the stored stocks —
the watchlist and the [reference universe](#the-reference-universe), so
"typical" means the market rather than the watchlist. Ties sit at the middle of
their run. `pnpm run calibrate` scores the history once a week per symbol,
collects each figure as the scorer reads it, and writes the 101 percentiles to
`calibration-table.ts`. That file is committed, so a recalibration is a code
change that re-scores the history like any other.

A deployment has the universe in its database but no sources to write into,
so the admin page calibrates there: *Neu berechnen* runs the same script with
`--store` in a child process (`calibration-service.ts`), which leaves the table
in `app_state` as a proposal. The page shows what it would move — for the
criteria whose typical stock moved most, where the new median sits on the old
scale, 50 meaning unchanged — and offers `calibration-table.ts` to download.
It replaces `src/analysis/calibration-table.ts` in a commit, and the deploy
that carries it re-scores the history.

The DCF's probability and the margin the price requires are calibrated, although
they look natural. The model fades growth faster than the market's own implied
premium assumes, so it finds most large caps dear, and that says something
about the model, not about any one stock.

At first, criteria with a natural zero kept their explicit ramps: growth and
margin against the peer median, relative strength against the sector, estimate
drift, revision breadth and rating drift. Measured over the universe, half of
them were off-centre too:

- The typical S&P 500 member beats its peer group's margin by 4.7 points,
  because Finnhub's groups reach down to firms a fiftieth of its size.
- It trails its cap-weighted sector ETF by 3.6 % over three months, because the
  largest members led.
- A sixth of its analysts revised up in the last month.

Zero is the natural point for one stock, not for the population. So those
criteria are calibrated as well. The ramps remain as the fallback for a key
without a distribution, and they are what the tests pin.

**The balance sheet and quality are read within the sector.** Against the whole
market, utilities scored a median 2.0 on the balance sheet and real estate 1.7,
with both near 3.5 on quality. A utility carries four times EBITDA in net debt
because regulated returns let it, so it was being punished for being a utility.
Those criteria now take their percentile within the stock's own sector, where
the sector holds at least twelve stocks (`MIN_SECTOR_CALIBRATION_SYMBOLS`), and
against the market where it does not. The median balance-sheet pillar of
utilities went from 1.9 to 4.8, of real estate from 1.7 to 4.7, and of
technology from 6.1 to 4.9. The table keeps each sector's
distribution beside the market's (`health.leverage@Utilities`). Two stay against
the market on purpose. Beneish reads manipulation, which is no sector's habit.
Piotroski reads a company's change on its own last year, so it is already
relative. Valuation stays against the market as well: which sector is cheap is
a bet the score is allowed to make.

**Three factors the research keeps finding** are now part of quality:

- **Gross profit over assets** (Novy-Marx, 2013) ranks future returns about as
  well as book-to-market does, in largely different stocks. It is measured
  before the lines a business can shape: marketing, research, one-offs.
- **Accruals** (Sloan, 1996): earnings well ahead of the cash behind them tend
  not to last, and the market is slow to notice. Less is better.
- **Net share issuance** (Pontiff and Woodgate, 2008): issuers go on to trail,
  buyers-back to lead. It reads the same split-adjusted share count as
  Piotroski's F7.

None of the three means anything for a lender, whose gross profit is its
interest margin and whose operating cash flow is its loan book moving, so they
abstain there. The pillar's weights are Piotroski 20 %, ROIC spread 20 %, gross
profitability 15 %, margin 15 %, growth 10 %, accruals 10 %, issuance 5 % and
Rule of 40 5 %.

The effect, measured over the same 242 stocks (the watchlist and 205 members of
the S&P 500) under three ways of reading the criteria:

| | Hand-set ramps | Table from the watchlist | Table from the universe |
|---|---|---|---|
| Median pillar: valuation | 2.7 | 4.9 | 4.7 |
| … quality | 5.1 | 5.1 | 5.0 |
| … health | 8.1 | 3.8 | 5.0 |
| … consensus | 6.9 | 3.5 | 4.9 |
| … momentum | 5.4 | 5.4 | 5.3 |
| … revisions | 6.5 | 6.2 | 5.1 |
| Stocks leaning bullish / bearish | 137 / 105 | 115 / 127 | 121 / 121 |
| Conviction, bullish vs bearish | 1.31 vs 1.22 | 1.23 vs 1.30 | 1.25 vs 1.30 |
| STRONG BUY / BUY / HOLD / SELL / STRONG SELL | 15 / 40 / 163 / 22 / 2 | 1 / 25 / 177 / 35 / 4 | 0 / 31 / 173 / 34 / 4 |

The middle column is why the table has to come from the market rather than the
watchlist. Watchlist stocks are healthier and better liked by analysts than the
typical S&P 500 member. Read against them, the market looked indebted and
unloved, and the error simply flipped direction. Against the universe the
watchlist is what stands out instead: its median health pillar is 5.9, its
consensus 6.4 and its valuation 3.5. That is information about the watchlist,
which is what a score is for.

The committed table was generated on 27 September from all 595 stored stocks,
the watchlist and the full universe, with mostly one observation per reference
stock. Regenerate it (`pnpm run calibrate`, or *Neu berechnen* on the admin
page) once the nightly rotation has given the universe a few weeks of history;
the admin page says when it is due. On
those 595 stocks the six pillar medians sit between 4.8 and 5.2, 293 lean
bullish and 302 bearish, and conviction is 1.25 either way.

**The bands are symmetric.** HOLD used to run from 4.5 to 6.5 — set where the
old LLM verdicts sat — so a BUY needed 1.5 points above neutral and a SELL half
of one. With every criterion centred, 5 is neutral, and the bands now sit 1.5
and 3 points either side of it.

**Momentum is what the research measures.** The pillar leaned 40 % on the
TradingView-style vote, where twelve moving averages say "trend" and seven
oscillators say "oversold is a buy" — two opposite bets in one number. It now
reads the return over twelve months skipping the most recent one (Jegadeesh and
Titman; the skipped month is where short-term reversal lives), closeness to the
52-week high (George and Hwang, 2004), and the three-month strength against the
sector. The gauge stays on the page and no longer votes.

**Revisions count analysts, not events.** Net revisions were summed over four
overlapping periods, so one analyst cutting a quarter and the year counted up
to four times, and they were read on a fixed ±4 scale whether one analyst
covered the stock or sixty. Breadth is now net revisions over the analysts
publishing an estimate, for the current and the next fiscal year.

### What the price requires

Four of the five valuation criteria ask *what is it worth* from our own
assumptions. The fifth (`market-implied`, 20 % of the pillar) inverts the
question the way a growth investor would: hold the DCF's revenue path,
reinvestment and discount rate, solve for the operating margin the business has
to settle at for today's price to be fair, and hold that against the best
margin it has **already shown** — today's, the average of its recent fiscal
years, or the peer median when there are at least five peers.

The reading is log-symmetric around 1: priced for exactly the achievable margin
reads 5, twice it reads 0, half of it reads 10. On the watchlist's stored
payloads: Alphabet requires 38 % against 31 % shown, NVIDIA 42 % against 59 %,
Tesla 64 % against 7 %.

Two choices worth knowing:

- **Margin, not the implied growth.** The growth the price requires is solved
  and shown beside the consensus, but it is not scored: growth is worth nothing
  without the margin it is earned at, and at a low one more of it lowers the
  value. The margin compares like with like.
- **Operating margin, after stock compensation.** The requirement is the
  forward model's own margin, which is after stock compensation, so the
  yardstick is too. The first version compared a free-cash-flow requirement
  with a free-cash-flow margin, and free cash flow adds stock compensation back:
  UiPath "earned" 31 % against 3 % GAAP. Peer medians still count only from
  five peers up — thin groups produced medians from −53 % to 1.5 % for
  companies nobody would call loss-making.

### A liability that is not a debt

A subscription business collects a year in advance and books it as a current
liability it settles by delivering the service, not by paying cash. At
ServiceNow that deferred revenue is 80 % of current liabilities, so the reported
current ratio of 0.70 scored one of the most liquid balance sheets on the list
0/10. Where deferred revenue is at least a quarter of current liabilities
(`deferredRevenueShare`, from the annual balance sheet), the liquidity criterion
reads the ratio without it — `currentRatio / (1 − share)` — and says so in the
note: ServiceNow 0.70 → 3.4, Microsoft 1.23 → 2.2, Rubrik 1.64 → 8.8. Below a
quarter the adjustment is noise and the ratio is read as reported.

### Agreement, and why the middle is not always bland

A weighted mean of six differentiated signals is necessarily less differentiated
than its inputs, and on a real watchlist the effect is severe: the pillars of one
company routinely span 6.6 points while the scores they produce span barely 4, so
three quarters of a list lands in one band. Nothing is wrong with the arithmetic
— the mean of a strong buy case and a strong sell case *is* the middle.

But two very different situations were arriving at the same number. Apple's
pillars read 0.2 on valuation against 8.2 on quality and 8.6 on the balance
sheet, averaging to 4.9: a genuine standoff between lenses that disagree
violently. Nu Holdings scores 7.7 with every lens pointing the same way.
Corroboration is evidence, the mean throws it away, and the reader could not tell
the two apart.

So the deviation from neutral is multiplied by how much the pillars agree:

```
agreement  = |Σ w·dev| / Σ w·|dev|      # 1 = unanimous, 0 = they cancel
strength   = min(1, Σ w·|dev| / 1.5)    # mean distance from neutral vs the BUY band's
conviction = 1 + 0.6 × agreement × strength   # 1 when fewer than three pillars scored
```

**Strength** exists because agreement is a ratio and blind to scale: six lenses
a hair above neutral agree as perfectly as six at 9. MercadoLibre's pillars ran
from 5.0 to 7.1 — a mean distance of 1.18 points against a watchlist median near
2.5 — and took the full 1.6×, six mild leans multiplied like six convictions. A
lean smaller than the distance to a BUY verdict (1.5, read from `SCORE_BANDS`)
is a weak vote either way, so below it the stretch scales down in proportion.
Today that touches one stock (MercadoLibre 6.6 → 6.5). A stricter threshold of
2.0 would also move MercadoLibre and Honeywell from BUY to HOLD; which one is
right is a question for `pnpm run evaluate` — compare `factor.raw` with
`factor.score` once there are enough windows — not for taste.

Direction-blind: six unanimously bearish pillars earn the same conviction as six
bullish ones. It needs at least three scored pillars, because with one the
agreement is trivially perfect and there is nothing to corroborate.

This **reorders the list, deliberately**: a corroborated 6.2 is a better case
than a contested 6.5, and saying so is the point. On a 37-stock watchlist it took
σ from 0.88 to 1.30 and the range from 3.7–7.5 to 3.3–9.0 — STRONG BUY had never
once been reachable before. Labels went from `{BUY 6, HOLD 28, SELL 3}` to
`{STRONG BUY 3, BUY 6, HOLD 24, SELL 4}`.

The score is published to one decimal and **everything bands on that published
value** — the table, the card and the badge all print `toFixed(1)`, and banding
on a more precise number behind it put a SELL next to a 4.5 while its neighbour
at the same 4.5 said HOLD.

### The bands

`SCORE_BANDS` in `src/verdict.ts` is the only place a score becomes a label, and
the only place the boundaries exist:

| Score | Verdict | Colour |
|-------|---------|--------|
| ≥ 8.0 | STRONG BUY | green |
| ≥ 6.5 | BUY | green |
| ≥ 3.5 | HOLD | amber |
| ≥ 2.0 | SELL | red |
| < 2.0 | STRONG SELL | red |

A cap shows in the list as ⛔ beside the badge, with its reason in the tooltip —
but **only when it actually held the label back**. `no-strong` on a stock scoring
6.6 forbids a label that was never on the table, and a marker that fired on the
mere existence of a cap printed "capped" beside a BUY that was never capped. The
flag is derived from the two values on screen: `verdictForScore(score) !==
verdict`.

The colour is *derived* from the band rather than set alongside it. It used to
have its own thresholds — green from 7, amber from 5 — which disagreed with the
bands in two of the four zones: a 4.6 printed a red number beside an amber HOLD
chip, a 6.6 an amber number beside a green BUY one. Ten of thirty-seven rows in
a real watchlist were coloured against their own label. `scoreColor` now asks
`recommendationTone(verdictForScore(score))`, so the digit and the chip cannot
drift apart again.

STRONG gets no colour of its own, the rule the badge already followed: the word
is in the label, so strength is emphasis (filled vs. outlined chip) rather than
a fourth hue.

Separately, **caps** limit the label without touching the number: a data-quality
error, no analyst coverage, or confidence below 45 % forbids the STRONG variants;
a supported Beneish flag or an Altman distress zone forbids BUY and STRONG BUY.
The two differ on the bearish side on purpose: uncertainty tempers both
extremes, so `no-strong` also turns STRONG SELL into SELL, but a warning only
caps enthusiasm — a distressed balance sheet is no reason to soften a STRONG
SELL, and it once did (Vistra, held at SELL by the distress reading that made it
bearish).

### Verdict changes

Every time a watchlist stock's published verdict moves to another band, the
change is recorded (`verdict_changes`, `src/alerts.ts`). The last week's moves
sit in a strip above the overview, so nobody has to compare two days of the
list by eye.

Announcing them is a separate step, because a score on a band's edge — 6.5 is
BUY, 6.4 is HOLD — flips with every refresh. A change is announced only once the
new verdict has held through a refresh at least 18 hours later, and only if it
differs from the verdict announced last (`verdict_announced`). A stock that goes
HOLD → BUY → HOLD overnight announces nothing. The data step and the analysis
write minutes apart, and a second write in the same night does not count as
holding. A stock's first reading is where it stands, not news.

Announcements go to a webhook configured under **⚙ Administration**, in one
of two formats. *JSON* suits any endpoint that takes a JSON POST: the body
carries `text` for Slack and `content` for Discord, plus the symbol, both
verdicts and the score. *ntfy* posts to an ntfy topic URL — ntfy.sh or a
server of your own — the way ntfy reads it: the change as the title
(`MSFT: HOLD → BUY`), the score as the text, and 📈 or 📉 as a tag. Title and
tag travel as query parameters, which ntfy accepts in place of its headers and
which carry the arrow a header could not. A protected receiver takes its
credentials in the URL — `https://user:password@host/topic`, or an ntfy access
token as `https://:tk_…@host/topic` — and they are sent as an `Authorization`
header, since Node's fetch refuses a URL that carries them. Empty is off, and
**Test senden** sends a sample announcement to the stored URL; when the
receiver refuses it, the page shows its answer (`HTTP 403: forbidden`) or why
it could not be reached (`fetch failed: ENOTFOUND`). The comparison is always against
the stored series, which a re-score after a model change rewrites too: a new
scoring model moves verdicts in bulk, and that is a deploy, not news about the
companies.

**The daily digest** (`src/digest.ts`) goes to the same webhook once the
night's watchlist pass is through, before the reference universe: what
happened across the watchlist since the last message — the quarter's numbers,
insider trades, rating changes and target moves, price jumps, dated research
findings — one line each, at most twenty with the rest counted, and the
reports due in the next three days below them. Headlines are left out, and
verdict changes, which are announced on their own. What was sent is
remembered per event (`app_state`, `digest.sent`), not by date: a rating
change dated yesterday afternoon is archived tonight, after yesterday's message
went out. A night with nothing new sends nothing. It is on by default and can
be switched off in the admin page; **Überblick testen** sends the last day as
it would arrive, marked as a test, without touching what the night will send.

### Two things the pillars deliberately do not read

**The analyst target is not a valuation model here.** It rides in the composite's
primary tier, which is right for a published fair value — it is a real third
opinion. It is wrong for a pillar sitting next to a consensus pillar reading the
same source: measured, the target was in the tier for 37 of 37 stocks and made up
46 % of it, so a consensus configured at 15 % actually carried 21 %. The
valuation pillar takes it back out; the published composite is untouched.

One model of our own is enough for that pillar, where one was not enough with the
target included — the distinction is what the lone survivor would be. A single
DCF or peer-multiple is a method applied to this company's figures; the target is
a price forecast, and on a pre-profit name it sat far above the price and scored
a perfect ten on exactly the stocks we know least about. The separation also
unhid a real divergence: our models run a median 14 % *below* price where the
sell-side runs 23 % *above* it, and the two pillars' correlation went from +0.01
(they shared an input) to −0.37 (they genuinely disagree).

**A Beneish flag is read, not obeyed.** The M-Score's SGI coefficient is +0.892
and the function is linear, so revenue growth pushes the score up on its own:
Ondas grew revenue more than twelvefold and printed 16.97 against a −1.78
threshold. The variable that separates growth from manipulation is TATA, total
accruals over assets — the one term about earnings being cash-backed. So
`readBeneish` returns one of `flagged`, `growth-explained`, `extrapolated`,
`grey`, `clean` or `unavailable`, and both the balance-sheet criterion and the
cap read that single verdict:

| Reading | Condition | Criterion | Cap |
|---|---|---|---|
| `extrapolated` | SGI > 3 — outside the model's estimation range | abstains | no-strong |
| `growth-explained` | SGI > 1.3 and TATA ≤ 0 — cash covers earnings | abstains | no-strong |
| `flagged` | anything else the M-Score calls a manipulator | 0/10 | hold-ceiling |

An explained flag is explained, not dismissed, which is why it still blocks a
STRONG. On the watchlist this relaxes Ondas (SGI 24.2, TATA −0.08) and CoreWeave
(3.96, −0.09) and keeps Nvidia (1.94, **+0.08** — net income above operating cash
flow is exactly what the score is for).

**Altman does not read a balance sheet with no debt on it.** Z was fitted on
manufacturers and Z′ on other public firms; neither sample held a cash-rich,
debt-free software company carrying a decade of venture-funded losses, and two
of the five terms punish exactly that shape. Rubrik prints X2 = −1.15 — an
accumulated deficit larger than its whole balance sheet — and lands at Z = −2.52
while holding $603M in **net cash**. It was being held at HOLD from a BUY band
for it, and so was Zeta. Distress means being unable to service debt, so
`readAltman` checks that: net cash says there is nothing to default on, interest
covered at the "excellent" mark says what debt exists is comfortably served, and
in both cases the criterion abstains and the cap does not fire. Neither makes
the company healthy — it is still loss-making, and the pillar's own interest
coverage scores it 0/10 on figures rather than through a borrowed model.

**Nor a utility.** No Z-Score variant was estimated on utilities — Altman left
them out of every sample, as he did financials — and their shape defeats the
terms on sight: asset turnover (X5) is structurally low for a fleet of plants,
working capital runs negative by design, and retained earnings reflect
accounting history. Vistra, under fresh-start accounting since leaving
bankruptcy in 2016, prints X2 ≈ 0 and X5 = 0.46 and landed at Z = 1.33
"distress" — costing it 30 % of the health pillar and a HOLD ceiling — in the
same week it placed $1.5 B of notes. `ALTMAN_EXCLUDED_SECTORS` makes the
criterion abstain there; interest coverage and leverage carry the pillar.

**An uncorroborated model that lands far from the price is not a valuation.**
The valuation ramp tops out at +60 % margin of safety, so a model claiming a
stock is worth five times its price scored exactly what a solidly cheap one
does. Rubrik's lone DCF put fair value at $522.81 against $102.23 and took the
top of the ranking with it; Fresenius Medical's lone Peter Lynch said $101.04
against $23.84. A single model is weighed between 0.4× and 2.5× of the price
(`FAIR_VALUE_BOUNDS`) and abstains outside that, which costs coverage and
therefore confidence. With two or more models, each is held to the same bounds
before the weighted mean of their logs is taken. The old code's claim that a
wild model is "medianed down by its neighbours" was false for two: their median
is their mean, and Berkshire's pair of a mis-grouped peer multiple and an
uncapped Lynch value came to +442 %.

The M-Score also stands down entirely for a lender, where receivables are the
product rather than a by-product of selling something: DSRI asks whether
receivables outgrew sales, which at a credit company is the loan book doing its
job. The industry list that already excuses banks from FCFF could not see this
one — SoFi and Mastercard are both filed as "Credit Services", and their debt
over revenue is 0.80 against 0.70. Interest separates them by a factor of
thirteen (27 % of revenue against 2 %), which is what `borrowsToLend` reads.

### The analyst target is a drawdown in disguise

The gap between price and mean target correlates **−0.66** with the drawdown
from the one-year high. Analysts cut targets far more slowly than prices fall, so
"upside" largely records how far a stock has dropped: the five largest upsides on
the watchlist belonged to stocks 24–75 % off their highs, the five smallest to
stocks within three percent of theirs.

Inside the pillar that exists to be the one opinion *independent* of our
arithmetic, that is a momentum term with the wrong sign — and it was carrying
45 % of it, which is what drove consensus to a −0.43 correlation against the
momentum pillar. The retained weight is derived rather than picked: r² = 0.44 of
the criterion's variance is drawdown, so it keeps the 0.56 that is not, and
0.45 × 0.56 ≈ **0.25**. The analyst *rating* — a judgement rather than a price
subtraction — takes the rest. Consensus against momentum fell to −0.28, which is
the genuine view that remains: analysts really are more positive on beaten-down
names. Where the drawdown is large the criterion now says so in its own note.

### The three model calls

The score card's **findings** — drivers and drags ranked by impact, plus the
divergences, caps and data-quality gaps — are the filter. What a summary is
allowed to talk about is decided by the same arithmetic that decided the score.

1. **Daten-Zusammenfassung** (cheap model, `scoring.summaryModel`) turns the
   scored card into prose. It arrives after the judgement; the task says
   *erkläre*, never *bewerte*.
2. **Narrativ** (cheap model, in parallel) reads Distill, Perplexity and search
   results and nothing else. It is shown **no price, no multiple and no fair
   value**: a summariser that knows the stock looks cheap finds the news
   encouraging, which is exactly the contamination the single call suffered from.
   It does not return a score. It rates five dimensions — demand, competitive
   position, execution, regulation, product — each from −2 to +2 (or `null` when
   the sources say nothing), with the evidence in a clause, and the code computes
   `5 + 2.5 × mean` (`narrativeScoreFrom`, at least two rated dimensions or it
   abstains). It is run **three times** in parallel over the identical prompt
   and the **median** is kept, together with the summary of the read that
   produced it, so text and number agree (`combineNarrativeReads`). The same
   read also collects the **theses** the sources argue, up to four per side —
   material for the bull and bear case, never for the score.
3. **Synthese** (the configured analysis model) gets the two short summaries, the
   narrative's theses, the pillar table and a compact digest of the Perplexity
   findings, and writes the thesis and a bull and a bear case in three sections
   each: 2–4 **theses** (the argument as the market has it — driver, what it does
   to the business, why it matters for the stock), 1–3 points **from the
   figures**, and 1–2 **triggers** that would move the verdict that way. Risks
   belong to the bear theses. It does not set the score. It may move the blended one by up to ±1 point, with a reason on the
   record, and only for something the pillars provably cannot see — an announced
   takeover, a regulatory decision, a recall.

Each stage degrades on its own: a failed data summary means the synthesis reads
the pillar table directly, a failed narrative means the headline is the factor
score alone, and a failed synthesis produces a verdict assembled from the
findings and marked as written without a model. That last path is not
theoretical — it fired on the first live run, and the verdict it produced was
the right score with honest prose and a label saying no model wrote it.

**Why dimensions instead of a number.** Apple came back with a narrative score of
0.0 for a business guiding 9–11 % growth, which pulled a factor score of 5.0 to a
SELL at 3.1. The single-number rubric read "0 — several independent sources
describe a deterioration", and the forensic brief is built to find exactly that:
EU, Germany, the US, the UK and India each supplied one. On the same material
Haiku answered 3–4 and cited the P/E from the Distill briefing — valuation leaking
into a read built to be blind to it — while gpt-5.4-mini answered 5. Rated one
dimension at a time, Apple's decided regulatory losses cost what one dimension is
worth (regulation −2, the rest between −1 and +1: 4.0–5.5 across three models),
and 0 or 10 need all five to agree. The prompt also says outright that valuation
in the sources is not part of any dimension, that the brief's bear evidence is
expected and weighed for what it found, and that an opened probe is at most −1.
The five ratings are shown as chips in the breakdown, each with its evidence.

**Bull and bear first.** On the detail page the case for and against sits
directly under the verdict and its score strip, in two columns —
Key Risks mostly repeated the bear case in a narrower third column and are folded
into it (older analyses included).

**Why each side is in sections.** One list per side filled up with what the
synthesis had most of — the pillar table. Apple's bull case read ROIC, operating
margin, Piotroski, momentum and the analyst count: five numbers and not one
sentence about why anyone owns the stock. The portals that do this well (Alpha
Spread's *Bull/Bear Thesen*) write the debate instead. So a side is now
**Thesen**, **In den Zahlen** and **Hebt / Senkt das Urteil, wenn …**, and the
separate slot is the fix rather than a layout choice: the theses cannot be spent
on multiples when the multiples have a section of their own. The triggers used
to run full width underneath, each announcing its own ↑ or ↓; in its column the
heading says it, and both columns end on them at the same height. The sections
are declared once in `src/cases.ts`, which also reads the older shapes — a flat
list renders without a section heading, and an old ↑/↓ trigger moves to its
side. On ServiceNow the first run produced Meta's enterprise launch repricing the
incumbents, customers still asking about AI security and cost, and the debt left
by Armis on the bear side; switching costs and AI ACV on the bull side; and the
DCF distribution and the conservative tier under the figures, where they belong.

**Why three narrative reads.** Five identical runs over ServiceNow's material
came back 5, 5, 5, 6, 7; GOOGL 6, 6, 6, 6, 7; Airbus 8 five times. Mostly one
answer, with the occasional outlier — and at up to 45 % of the headline a
two-point outlier moves the headline by most of a point, enough to cross a band.
A median of three discards a single outlier outright; the reads run in parallel,
so it costs about a cent per stock on the summary model and no wall-clock time.
Abstention is a vote: if most reads decline to score, the result abstains. The
spread between reads is kept (`score.narrative.spread`) and scales the
narrative's confidence by `1 − spread / 6` down to half at a spread of three —
three reads of the same text disagreeing by three points is the text not
determining the answer.

`fairValueEstimate` is **computed, not asked for**, and it leads with the median:
`$123.64 (3 Modelle: $39.22–$222.76)`. A bare min–max hands both ends to
whichever model strays furthest — ServiceNow's printed "$39.22–$222.76", which
says only that they disagree by a factor of 5.7. The median is what the
valuation pillar scores and is not hostage to the outlier; the span stays beside
it because the disagreement is worth knowing.

It was the last number the model still invented, and the first live run showed
why: given a card carrying both an intrinsic value and a conservative floor, it
paired the lowest figure with the highest and printed "€74–€173" beside a €208
price and a HOLD.

**A margin the audit has contradicted is not read.** The data-quality audit flags
a trailing margin that disagrees with the fiscal year and says to prefer the
statements — but every consumer went on reading the flagged figure, and the
warning only lowered a confidence somewhere downstream. ServiceNow reported a
trailing operating margin of 4.1 % beside a trailing *net* margin of 11.3 %,
interest covered 99× and a 35 % free-cash-flow margin; the fiscal year says
13.7 %. The 4.1 % was the largest single drag on its score and failed Rule of 40
on it (28.1). `reliableMargin` answers from the newest fiscal year once the audit
has named the field, and both Rule of 40 (now 37.7) and the quality pillar read
it. The margin criterion still scores ServiceNow low — against a peer median of
32.3 % its GAAP margin, carrying heavy stock-based compensation, genuinely is.

**Token budgets cover reasoning.** On the gpt-5 family `max_completion_tokens`
counts thinking as well as output, so a long prompt can exhaust the budget
before a single brace is emitted — which surfaces as `JSON.parse` failing with
"Unexpected end of JSON input" and reads as the model misbehaving. The providers
now check `finish_reason` / `stop_reason` and raise `LLMTruncatedError`, which
names the limit and says to raise it.

**A declined request is re-run, not lost.** Claude Opus 5.5, Sonnet 5.5 and
Fable 5.1 run safety classifiers that can decline a request. On those models the
call carries `fallbacks: "default"`, so Anthropic re-runs a declined request on
a model that answers, inside the same call and billed only when it happens
(`refusalFallback` in `src/models.ts`). Should the whole chain decline, the error
says so by name instead of surfacing as a response that was not JSON.

**Which model writes the synthesis.** Measured on the same synthesis prompt for
VST and NVDA (September 2026), in dollars per call:

| Model | VST | NVDA |
|---|---|---|
| gpt-5.6-terra | 0.022 | 0.026 |
| gpt-6.1-sol | 0.018 | 0.017 |
| claude-sonnet-5-5 | 0.042 | 0.037 |
| claude-opus-5-5 | 0.063 | 0.085 |
| gpt-6-astra | 0.081 | — |
| claude-fable-5-1 | 0.160 | — |

Every model returned valid JSON well inside the 6,000-token budget. GPT-6.1 Sol
is the pipeline default: cheaper than Terra, with the most careful separation of
what management claims from what independent sources show. The Claude models
count the same German prompt as about 1.75 times as many tokens, so the same
list price costs twice as much per call. Opus 5.5 is the one worth paying for,
if any: it did the most arithmetic of its own (a free-cash-flow yield from the
guidance, how much of the target's upside is only the fall in price) and tied
the Beneish warning to the prose's accusations of circular financing. The two
summarisers together add 1.7–2.3 cents, so a whole analysis on the default is
about 4 cents.

### What Perplexity is asked for

The narrative stage exists to read what the pillars cannot see, so Perplexity is
asked for exactly that and nothing else. The previous brief asked for recent
developments, earnings highlights, the competitive position, analyst targets and
a bull and bear case — and got them. For ServiceNow that was a third of its
sources from the company's own newsroom (a partnership, a Brazil office), analyst
targets already read from Yahoo, and a bull and bear case written a second time
by a model nobody audits; its bear case read "competitive pressure could
intensify". The one fact that mattered most in our own data — 71 net estimate
cuts — went unexplained.

The brief now names what we already hold (price, multiples, statements, ratings,
targets, revisions, insider transactions) and forbids repeating it, and returns
structured JSON:

| Part | Asked for |
|---|---|
| `debate` | the one to three open questions the price hinges on — why each matters for earnings or the multiple, what settles it and when |
| `events` | dated developments that move the outlook; always the latest earnings report — guidance against the prior quarter and consensus, what management avoided — each with its `impact` on revenue, margins or risk |
| `kpis` | up to four company-specific operating figures the statements do not carry (cRPO, net retention, same-store sales, backlog…), over two to four periods |
| `bear_evidence` | the strongest *specific* evidence against the bull case — short reports, accounting concerns, guidance cuts, churn, share loss, documented structural threats. Evidence only, never "risks could include" |
| `bull_claims` | the theses bulls hold, each argued — `mechanism`, `stake`, named `proponents`, the strongest `counter`, what `settles` it — and graded `independent`, `management-only` or `contradicted` |
| `bear_claims` | the same for the bears, graded `independent`, `opinion` or `contradicted` |
| `catalysts` | dated events in the next six months and what to watch in each |

Every item carries a date, a source and an independent-or-company label. On the
same stock it produced: a guide raised by $15M on a 150bp beat, federal revenue
pulled forward from Q3, a margin beat from deferred marketing spend, AI usage
acknowledged as a gross-margin headwind — and two popular bull claims marked
contradicted. Four of five claims in circulation rested on management's word
alone, which is itself the finding. The narrative score fell to 5.0: once the
prose was asked for contrary evidence, it stopped propping the price up.

Mechanics that keep it honest:

- **High search context.** At `low` the same brief found four insider filings and
  nothing else. About ten cents a call on Sonar Pro with the argued claims.
- **Bear claims are the argument, `bear_evidence` the facts.** "Federal revenue
  pulled forward" is evidence; "the multiple assumes years of net retention
  nobody sustains" is the thesis a reader needs, and nothing asked for it until
  the bull and bear case were split into sections. They feed the theses only:
  the narrative's weight still counts the bull claims and the evidence, so
  asking one more question does not buy the prose a larger share of the
  headline.
- **Arguments, not slogans.** The second brief capped every item at two
  sentences, and the claims read like it: "ServiceNow is gaining share across
  workflows — management-only". Three of five bear claims rested on one
  anonymous "published bearish analysis", and a CFO's remark came back labelled
  independent. The third (3 October 2026) asks for the argument behind each
  claim, defines "independent" (the company's releases, calls and executives
  never are, even when a newspaper repeats them) and asks for the proponents by
  name. Items are still capped — 3 / 6 / 4 / 6 / 5 / 5 / 4 — the strongest, not
  all of them.
- **A truncated answer is salvaged**, not discarded: `salvageTruncatedJson` cuts
  back to the last finished item and closes what is open. Nothing is invented to
  replace the item that was being written.
- **Weighted by independent evidence.** Narrative confidence counts independent
  items — six or more earns Perplexity its full share, none earns nothing. The
  old synthesis always counted in full, so press-release paraphrase bought the
  same weight as dated contrary evidence.
- **The prompt hash is compared.** It existed from the start and was never read,
  so a rewritten brief would have gone on serving answers to the old one for up
  to two weeks. A stored answer from another prompt is now a cache miss.
- **Sonar Pro by default; the model is a setting.** Sonar answers in the same
  shape at a fifth of the price, but called 7 of 17 items taken from the
  company's own investor pages independent, against Sonar Pro's 1 of 12 —
  and independent items are what earn the narrative its weight.

#### Which model (3 October 2026, ServiceNow and Fresenius Medical Care)

| Model | Cost | Time | What it brought |
|---|---|---|---|
| Sonar Pro | 8–10 ¢ | 40–50 s | Every section filled, sound debate questions; KPIs mostly a single quarter, proponents vague ("bearish investors") |
| Sonar Reasoning Pro | 9–10 ¢ | ~3 min | Found what Pro missed (the $7.75bn Armis price, WARN layoffs, a cluster of critical CVEs; for FMS the TDAPA swing and −0.9 % US same-market treatments), but verbose, with URLs written into the prose and placeholder catalysts |
| Sonar Deep Research | 67–96 ¢ | 4–5 min | The only one with real KPI series (cRPO, RPO, $5M+ customers and renewal rate over three quarters), earnings quality (GAAP miss, FCF margin 44 % → mid-teens, gross margin 81 → 78 %), a federal investigation, the FDA warning letter at FMS. 50–70 searches |

The runs vary: the same model found the FDA letter on one run and not on the
next, and a Berenberg downgrade turned up once in six. No model is complete.
Deep research is clearly the most thorough, at eight to ten times the price, so
it is **bought by hand** (Research & News → Deep Research) and **kept beside**
the regular brief, not in its place: every analysis inside
`perplexity.deepMaxAgeDays` (60 days by default) reads both. Where they
disagree the prompt says the newer wins; for the narrative's weight they count
once, as the better of the two.

Two mechanics the reasoning models need:

- **No token ceiling.** Their thinking counts against `max_tokens` without
  showing in the usage. With 16k, both stopped with `length` after 2,000–6,000
  visible tokens — deep research after 1,265, mid-claim. Their cost is the
  thinking (deep research: ~100k reasoning tokens and 50 searches per report),
  so a ceiling saves nothing worth having.
- **Streamed.** Node's `fetch` gives up when headers have not arrived after
  five minutes, and deep research without a ceiling thinks longer than that.
  Both reports of the second run failed with "fetch failed" — after being
  billed. A stream sends its headers at once.

The raw answer, the API's usage block and the cost are stored with every brief,
so a parser fix can re-read old answers and the price of each is on record.

### The blend

```
factorWeight    = 0.5 + 0.5 × factor agreement
narrativeWeight = narrative confidence × 0.45
blend           = weighted mean of the two scores
score           = 5 + saturate(unsaturate(blend − 5) + adjustment)
```

The synthesis model's correction is added where the scale is still linear and
bent back afterwards. Inside the STRONG bands that is exactly `blend +
adjustment`; towards the ends it is less. Added on the published scale, as it
used to be, a +1 on a 9.4 blend came to 10.4, was clipped to a perfect 10.0 and
was still recorded as "+1.0" although 0.6 had been applied — and a point up
there skipped the whole compressed zone that `saturate` builds, weighing more
than a point in the middle. `final.adjustment` is now what was applied
(`score − blend`), `final.adjustmentRequested` what the model asked for; a card
carried forward by the nightly refresh decays the request, not the bent result,
so it is not shrunk twice.

Neither side argues its own case. A flagged payload arrives already pulled
towards neutral by its own confidence (`shrink`), so its deviation carries less
into the blend. A thin or stale dossier hands its weight back. Narrative
confidence is computed from the material — which sources arrived and how old the
newest is — never self-reported by the model. The factor half used to be
weighted by its confidence *as well*, so a doubtful payload's influence fell
with the square of its doubt. Its confidence now counts once.

The factor side is weighted by agreement, because trust and having something to
say come apart. Apple's data is impeccable (confidence 0.86) and its pillars
cancel (agreement 0.04), so its 4.9 is a standoff rather than a verdict. A factor
half whose lenses cancel keeps `FACTOR_WEIGHT_FLOOR` (half) of its weight, and
the qualitative read gets the room. That is precisely where a qualitative read
is worth most: the numbers have already declared a draw.

The pillar weights themselves are deliberately **not** configurable from the
settings page. They are the scoring model, and a model that can be retuned at
runtime produces a history that cannot be compared with itself. What is
configurable is `scoring.summaryModel`, `scoring.narrativeMaxWeight` and
`scoring.adjustmentLimit`.

### As a series

`ScoreCardSchema` is a catalogue domain, so every leaf is historised without a
second list to maintain — `score.final.score`, `score.factor.confidence`,
`score.factor.pillars.valuation.score` and the rest are all chartable. The
overview's sparkline and ranking read `score.final.score`.

The deterministic half is recomputed on **every data refresh**, not only when the
analysis step runs, with the last stored narrative carried forward and decayed by
its own age (so does the synthesis model's correction — it was an exception
argued from an event, not a standing adjustment). That is what makes the series
daily: it moves with the price instead of stepping whenever the five-day analysis
cadence comes round.

**The list and the detail page are one number by construction.** The overview
reads the newest point of the series; the detail page recomputes the card so its
arithmetic is current. They used to disagree — GOOGL STRONG BUY 8.3 on the page,
BUY 7.7 in the row — for four separate reasons, all fixed:

- The re-score ran on fallback rates (a 5.5 % premium against a measured 4.1 %)
  while the page used live ones. Both now use the rates **recorded** in the macro
  series for the instant in question (`ratesAt`).
- The re-score passed no analysis card, so it rewrote recent points as the
  factor score alone. It now carries the card in force at each instant, decayed
  exactly as the nightly refresh decays it.
- The page fetched peer medians and rates live. It now reads the stored
  snapshots through the same function the series uses (`storedInputs`,
  `currentScoreCard`), evaluated at the instant of the list's newest point.
- The re-score only rewrote the instants where financials changed, missing the
  refresh's own points a few milliseconds away — the newest ones. It now
  rewrites every recorded score instant.

**After a deploy the server re-scores by itself.** A fingerprint of the scoring
modules is stored (`app_state`, `scoring.fingerprint`); when the deployed code
hashes differently the server re-scores the history in the background on start.
Nothing to run by hand, and no version number to forget to bump. A full manual
`rescore` stores the fingerprint too.

**The inputs of one instant describe one moment.** The market signals and the
technical aggregate count only if they were taken within three days of the
financials they are scored with (`MAX_SIGNAL_LAG_MS`). A refresh writes them
seconds apart. But on 22 September six symbols had financials written while the
signals in force were five weeks old, and their momentum pillars scored a
month-old return beside that day's price. Now those pillars abstain, and the
missing coverage lowers the confidence. The other ages have guards of their
own. The evaluation stops counting a series ten days after its last point. The
detail page scores as of the list's newest point, never the wall clock, and
shows its stale-data banner. A listing whose newest quarter is more than nine
months old is flagged by the data-quality audit.

**Empty peer groups are not peer data.** A rate-limited Finnhub fetch — every
peer request refused — used to be stored as a group of zero peers with every
median null (10 of 31 fetches on 16 August), which dropped the peer-multiples
model and the peer margin from that day's valuation. `getSectorMedians` now
returns null for it, the last good medians stand in, and every reader skips the
empty payloads already in the history (`hasPeers`).

History from before the change can be recomputed, because the factor score is a
pure function of snapshots the database already keeps:

```bash
pnpm run rescore                              # every symbol, all stored history
pnpm run rescore -- --symbol AIR.PA --dry-run # one symbol, no writes
```

In the deployed container there is no `pnpm` and no `tsx` — the runtime stage
carries `dist/`, the production `node_modules` and nothing else (see the
Dockerfile). Run the compiled entry point directly, and note that the `--`
separator is a pnpm convention with no place here:

```bash
node dist/db/rescore.js --symbol AIR.PA --dry-run
```

For those dates `final.score` equals `factor.score`: nobody stored what a dossier
said on a Tuesday in June, and folding the old single-call LLM scores in as a
stand-in would import exactly the noise this replaced. `verdict.*` is left
untouched — it is what the old pipeline actually concluded on those days, and it
is the only baseline the new score can be compared against.

Re-running it is safe, and safe in the strong sense: observations upsert on
(symbol, metric, instant), and each symbol's `score.*` rows at the instants
being rewritten are cleared first. Without that step a re-score under changed
rules could only add and overwrite, never remove — a criterion that now abstains
would leave its last value behind at the very timestamp being rewritten, which
is how a pillar once reported 10/10 next to a coverage of 0 %. Rows written by
the live refresh sit at instants of their own and are never touched.

### Does it predict anything?

Everything above is about *internal* quality: the findings add up, missing data
costs coverage, two runs over one payload agree. None of that says whether a 7
was followed by better returns than a 4. `pnpm run evaluate` is the one place
that asks:

```bash
pnpm run evaluate                               # 5, 20 and 60 sessions ahead
pnpm run evaluate -- --horizons 20 --json
node dist/db/evaluate.js --horizons 5,20        # in the deployed container
```

The same numbers are in the web app under **Auswertung** (the chart icon beside
the gear on the overview, `#/evaluation`), backed by `GET /api/evaluation`. The
server keeps a result for six hours — a run fetches a year of prices per symbol
and its inputs move once a day — and **Neu berechnen** forces a fresh one. Each
row carries a plain verdict on how much the sample supports it: *zu wenig Daten*
below three independent windows, then *nicht von Zufall zu unterscheiden*,
*Tendenz* from |t| ≥ 1, *belastbar* from |t| ≥ 2.

On every trading day it ranks the stocks by the score they carried *into* that
day and by the return over the S&P 500 they made over the next *h* sessions, and
reports the Spearman correlation of the two rankings (the **rank IC**) — for the
headline, the factor half, the raw factor score before shrink and conviction,
every pillar, and the old single-call LLM score as the baseline the whole
pipeline has to beat. A cross-section cancels the market: a day on which
everything fell still says whether the high scores fell less. Alongside it: the
share of days with a positive IC, the top-third-minus-bottom-third return
spread, and the mean excess return per verdict label.

It does that on two cross-sections:

| | Stocks | Signals |
|---|---|---|
| **Watchlist** | the stocks added by hand | every signal, the prose and the old LLM score included |
| **Universum** | the watchlist plus the reference universe (below) | the ones computed from numbers alone: factor score, raw factor score, the six pillars |

The watchlist is the only place the narrative can be judged. It is also a
sample of one person's taste and a few dozen names wide. The universe is several
hundred stocks chosen by an index committee, which is where a factor can
actually be measured. One day's IC has a standard error of about 1/√(n−1):
±0.17 over 37 stocks, ±0.045 over 500.

**Returns are in dollars.** The benchmark is the S&P 500 in dollars, so every
other listing's closes are restated in dollars at each session's exchange rate
(`EURUSD=X` and so on) before a return is taken. Measured in euros, Airbus was
credited with whatever the euro did against the dollar. A listing without an
exchange-rate history is left out rather than mixed in.

**Within sectors as well.** The second IC column (*Im Sektor*) ranks each stock
only against its own sector: its score as a percentile among the sector's
scores, its return less the sector's mean return. A score that likes banks is
right in the year banks rally and says nothing about which bank to own. Pooled,
that industry bet passes for stock picking; within sectors it cancels, and what
is left is the selection.

**Beside the backtest, with the expectations fixed first.** In the
*Universum* view, *Live gegen Backtest* reads the universe the way the backtest
reads its months (`monthlyView` in `db/evaluate.ts`): each stock's newest
factor score before every month-end, its return one, three, six and twelve
months on against the month's average stock, windows that do not overlap, the
factor verdicts' bands — each beside the backtest's own figure.

Above them stand four expectations, written down on 3 October 2026 before a
month that will test them had closed (`backtest/expectations.ts`): the factor
score's rank IC over a month above zero; inside the top tenth, the half with
the stronger momentum pillar ahead over six months; a score of 8 or more
behind the average stock over six months; and, from the timing study of the
same day, the half of all stocks nearer their six-month low behind the other
half over six months (read from the stored timing series, `db/timing-series.ts`). The rule is fixed with them: under
six independent windows *zu früh*, two standard errors the expected way
*bestätigt*, two the other way *widerlegt*, *offen* between; a month counts
only when at least 200 stocks were scored on it, not the watchlist alone.
Each row also says how long an effect the backtest's size, at its spread,
would need to reach two standard errors: about ten years for the IC, fourteen
for the split, thirty for the band, seven for the six-month low. The live months will not confirm effects
this small in any time that matters. They can contradict one sooner, and they
say whether the score the app actually shows behaves like the one the backtest
rebuilt. An expectation added later is dated later and tests only the months
after it.

**What the evidence says about the weights.** The evaluation ends with a
suggestion for `PILLAR_WEIGHTS` at the 20-session horizon, read from the
universe. Each pillar's IC is shrunk towards zero by its own uncertainty —
`ic × τ² / (τ² + se²)` with τ = 0.05, the posterior mean under a prior that a
good factor's IC is a few hundredths — and the pillar's weight is tilted by
`1 + shrunk / τ`, then all weights are renormalised to the same total. A pillar
measured at one prior width of skill doubles, one at minus that width drops out,
and one measured over a handful of windows barely moves: evidence moves weights
away from judgment in proportion to how much of it there is. It is printed and
shown under **Auswertung**, never applied. The weights are the scoring model, a
change to them is a commit, and a model refitted to its own recent returns is no
longer tested by them. Refitting them is the backtest's job, which has thirteen
years to fit on and checks the fit on the half it did not see (see *Fitting the
weights, and checking the fit* below).

How to read it, and how not to:

- **Point in time.** A signal counts from observations dated strictly before the
  formation day, and the return runs from that day's close, so nothing the score
  saw can be in the return it is credited with. A series that *ends* — the old
  LLM score, a symbol dropped from the watchlist — stops counting ten days after
  its last point instead of being carried forward for ever.
- **Overlap.** Consecutive 20-session windows share 19 days, so twenty daily ICs
  are roughly one observation, not twenty. The mean uses every day; the
  t-statistic uses only non-overlapping windows, and `indep.` says how many
  there were. No t-statistic is printed below three.
- **Power.** With ~37 stocks one day's IC has a standard error near ±0.17, over
  the universe near ±0.045. A useful factor sits around 0.03–0.08. Telling that
  apart from zero takes many independent windows — months at a 20-session
  horizon, not weeks. Until then the output is a description of what happened,
  not evidence about the model.
- **Hindsight in the model, not the data.** `rescore` rewrites history with
  today's rules, so the backfilled series is what the current model *would* have
  said. The inputs are point in time; the rules were not tuned on returns, but
  the moment they are, this stops being an out-of-sample test.

Nothing is stored: the score series accumulates with every nightly refresh and
prices are fetched fresh from Yahoo, so each run is a recomputation that knows a
little more than the last. The weights are set by judgment (`JUDGMENT_WEIGHTS`
in `score.ts`); the suggestion above and the backtest's fit are how the evidence
gets to argue with them.

### The reference universe

Two questions need a population rather than a watchlist. The calibration asks
where the typical stock sits on each criterion, and the evaluation asks whether
the score ranked the stocks that did better. Asked of 37 stocks picked by one
person, both answer questions about that person's taste.

So the nightly run also scores three indices (`src/universe.ts`), 576 stocks
in all:

| Index | Where the list comes from |
|---|---|
| S&P 500 | the community-maintained [`datasets/s-and-p-500-companies`](https://github.com/datasets/s-and-p-500-companies) file on GitHub, with share classes in Yahoo's spelling (`BRK.B` → `BRK-B`) |
| EURO STOXX 50 | the constituents table of the English Wikipedia article, whose tickers carry the main listing's suffix (`AIR.PA`, `ASML.AS`) |
| DAX | the constituents table of the German article, Xetra symbols with `.DE` added |

Europe is in it because the watchlist is: a euro listing read only against
American ones is read against a market it does not trade in. A company two
indices list on different exchanges counts once: the DAX lists Airbus on
Xetra, the EURO STOXX 50 in Paris. Only suffixed tickers are compared, and only
across indices. EL is Estée Lauder in New York, EL.PA is EssilorLuxottica, and
SAN.MC and SAN.PA are a bank and a drugmaker. Finnhub's free tier does not
cover European listings, so those stocks have no peer group, and the criteria
that need one abstain or fall back to their own figures.

Each index's last good list is kept in `app_state`, so a night without GitHub or
Wikipedia uses yesterday's. A list that parses to fewer members than the index
has (400, 40, 30) counts as a failed download, not a smaller index.

**Leaving is part of the record.** A stock usually falls before it drops out of
an index. An evaluation that stops scoring it the day it leaves only ever sees
the survivors. So a member that leaves every index is scored for another 90
days (`DEPARTED_GRACE_DAYS`), a quarter and the evaluation's longest horizon,
before the rotation lets it go. A failed download never counts as leaving: the
index keeps its last list.

A reference symbol is a row in `symbols` with `reference = true`, and it is
stored exactly like any other: snapshots, observations, the score series. What
differs is where it shows up:

| | Watchlist stock | Reference symbol |
|---|---|---|
| List, overview, admin watchlist, Distill | yes | never |
| LLM analysis, news, options chain | yes | never |
| Peer medians | daily | monthly (`REFERENCE_PEER_TTL_MS`) |
| Factor score, score series | yes | yes |
| Calibration, evaluation (*Universum*), re-score | yes | yes |

**A night does a hundred of them.** Several hundred refreshes a night do not fit
a 60-per-minute Finnhub budget, and a reference stock does not need to be
current to the day. After the watchlist is done, a full run refreshes the
`universe.batchSize` members (default 100, **⚙ Administration**) that were
refreshed longest ago, so the universe comes round every six nights. The rotation
keeps no state of its own: whatever a night did not reach is oldest the next
night. A symbol that has never refreshed counts from its first attempt, so a
delisted ticker queues behind the rest instead of taking the first slot every
night. A run over a hand-picked subset, such as `▶` next to one stock, never
includes the universe.

A reference refresh is the data step on a diet: no news, no options chain and
no Distill, because the score reads none of them. It records its own step,
**Referenz**, in the run log. A failed reference refresh does not make the run
`partial`: it keeps its place among the oldest and the rotation comes back to
it, so it is nobody's morning problem.

**Watchlist stocks in the index stay watchlist stocks.** They are refreshed in
full every night already, so the rotation skips them. A reference symbol that
someone adds or analyses joins the watchlist with the history it already has
(`promoteSymbol`).

**Three things keep the API budgets whole:**

- Every Finnhub request waits for a slot in a rolling minute of 55
  (`RateWindow`), instead of being refused with a 429 that used to be stored as
  a peer group of nobody.
- A company's `/stock/metric` answer is shared for an hour. In a night of
  reference refreshes, most members are someone else's peer.
- The market reading — VIX, the index, the dollar, the sector ETF — is shared
  for half an hour instead of being fetched once per stock.

Under Hatchet the universe runs as its own task, `reference`, after the
watchlist's chains have settled, on the same rate-limit keys as the data step
and four at a time (`REFERENCE_CONCURRENCY`). A hundred queued at once would
burst Yahoo and fill the general worker's slots. And since a stop from the
admin page can only cancel what is queued, the parent checks the run before
starting each one.

### The backtest

The live evaluation needs months of stored scores before it can say anything;
the weight suggestion above needs a dozen independent monthly windows. So
`pnpm run backtest` rebuilds them (`src/backtest/`). At every month-end since
2013 it reconstructs each member of the S&P 1500 — the 500, the MidCap 400 and
the SmallCap 600 — as the scorer would have seen it that day, then scores the
whole cross-section with the live code. The scores are evaluated against the
following months with the same `evaluate` the page uses, across all of them
and within each index: a factor the large caps price away may still work
further down, and the watchlist holds small caps the 500 never tested.

**Who was in, and when.** The 500's members and the day each joined come from
the community CSV; the 400's and the 600's from their Wikipedia tables, whose
tickers sit in `{{NyseSymbol|…}}` templates, and the day each joined from the
tables of changes — the 500's in *Historical components of the S&P 500*
(`data/universe.ts`). A company that left another of the three on the day it
joined moved rather than joined, and counts from its first entry
(`compositeJoinDates`). One the table never lists as added has been a member at
least since the table begins and counts from then: the 600's starts in
December 2019, and counting today's small caps from 2013 would count years
before some of them were small caps — the survivors' years. Filers the 400's
table gives by ticker are looked up in the SEC's own list.

**And who left.** The same tables name everyone removed since 2013 who is not a
member again — 738 companies. Those that still trade and still file under
their ticker are rebuilt up to the day they left (`backtest/departed.ts`), the
SEC's name for the ticker checked against the table's, since tickers are
reused (APC was Anadarko and is ARKO); GICS is not in the tables, so the sector
and industry are Yahoo's. Bought and bankrupt companies are gone from Yahoo and
stay missing; the result says how many came back.

**The filings as they stood that day.** The SEC's XBRL company facts carry, for
every figure a US filer has tagged since 2009, the period it covers and the day
it was filed (`data/edgar-facts.ts`). A figure exists from the day after its
filing, and a restatement from the day of the restatement, not from the end of
the quarter. Twelve months are built the way the filings add up: year to date,
plus the last fiscal year, minus the same year to date a year earlier.
Companies rename their tags — Apple reported `SalesRevenueNet` until 2018 — so
each line is a list of tags merged per period. Only a period's first filing and
its restatements are kept, and the reduced facts are cached under the data
directory.

**Prices and splits.** Yahoo's split-adjusted closes give the market
capitalisation, and the dividend-adjusted ones the return. A share count from a
2014 filing is on 2014's basis, so the splits since then bring it onto today's.

**The analysts as they stood that day.** Yahoo's rating history lists every
action with the firm, the grade it moved to and the target it set, back to
2012 for the large caps (`backtest/analysts.ts`, cached on disk and stored in
`analyst_actions`). Each firm's newest target and grade from the year before a
month-end, the day itself excluded, are that day's consensus
(`analysis/analyst-history.ts`): the mean target, the count of buys, holds and
sells — broker vocabularies mapped onto the five steps — and their change
against a month before. Below three firms there is none. Targets from before a
split are put on today's basis. The result says, year by year, for what share
of the stocks there was a consensus.

**Everything calibrated is recalibrated per month**, from that month's
cross-section only: the premium adjustment of each group — the firms', and the
lenders' where a month has twenty — and every criterion's reference
distribution. Peer medians come from the index's own GICS sub-industries that
month, with the same filters Finnhub's go through. Rates are FRED's month-end
series and Damodaran's premium for the month. Nothing from after a month-end
reaches its scores.

What it cannot do, and the page says so beside the numbers:

- **No estimates.** Earnings estimates, their revisions and surprises have no
  history. The revisions pillar is read on the rating drift alone, and the DCF
  starts from trailing growth. The rating history thins out going back:
  Apple's has a handful of actions before 2018.
- **Survivors, mostly.** Companies that left are in only where they still
  trade; the bought and the bankrupt are missing.
- **US only.** The SEC does not hold European filings.

Every run is kept (`backtest_runs`) and the newest shown under **Auswertung**
as a third view, *Backtest*: the table of signals at one, three, six and twelve
months, the factor score's IC by year, the same signals by index, the score cut
into tenths, verdicts and steps, the weights fitted to it with their check on
unseen years, and the earlier runs. A first run downloads about 1,700 filings,
price and rating histories and takes half an hour, the insiders another half;
later ones read the cache and take six or seven minutes. A trial with
`--limit` is printed and never stored.

**It runs itself once a month** (`src/backtest-service.ts`): on the 2nd at two
in the afternoon by default — after the month-end close is in, away from the
night's refresh, whose Yahoo, SEC and Finnhub budgets it would share. Nightly
would add nothing: it scores month-ends, and a new one comes once a month; its
caches refresh themselves on the way (prices weekly, filings and insiders
monthly), so nothing has to be fetched in between. The schedule and a
**Jetzt rechnen** button are under **⚙ Administration → Backtest**, with the
run's progress as it goes. The server starts it as a child process —
`backtest/run.ts` as the terminal runs it, writing its own log
(`backtest/run.log` under the data directory) — because a run holds the S&P
1500 in memory and the server that answers the page must not share a heap with
that. It needs more than 2 GB (under that cap it runs out) and, left alone,
grows to anywhere from 2.6 to 3.3 GB depending on when it collects; the child
is held to a 3 GB heap (`BACKTEST_HEAP_MB`), so the host knows what to keep
free. Postgres's advisory lock (`backtest/lock.ts`)
keeps it to one run at a time across processes: the schedule, the button and
a terminal cannot start a second. A run that dies with its process — a deploy —
is marked as interrupted when the lock is found free. It never writes weights:
a fit that held is shown, and committing it stays a decision. An environment
that leaves the nightly cron to production (`HATCHET_SCHEDULE_ENABLED=false`)
leaves this one to it too.

**Candidates.** Beside the score the backtest measures signals no pillar reads
yet, so that a weight for one is proposed only after it has been tested. The
first are the insiders (`analysis/insider-signals.ts`): from every Form 4 as
Finnhub keeps it, back to 2010, dated by its filing — the number of different
insiders who bought on the open market in the half year before, buyers against
sellers, and what the buying cost against the company's size. Purchases rather
than sales, because selling has many reasons and buying one (Lakonishok and
Lee 2001; Cohen, Malloy and Pomorski 2012); grants, exercises, gifts and
derivative trades are left out. Then the payout (`analysis/payout.ts`): the
dividend yield with non-payers at zero, the yield among payers alone, and the
shareholder yield — dividend plus the year's fall in the share count
(Boudoukh, Michaely, Richardson and Roberts 2007). The score reads the
dividend only inside the dividend model's fair value.

A candidate carries when its rank IC over one month, within the sector, clears
|t| ≥ 2 over all the months and points the same way in 2013–2019 and in
2020–2026 — the halves the weight check splits at. Each candidate's halves are
in the result (`candidateHalves`) and under its table on the page.

```bash
pnpm run backtest                     # S&P 1500, month-ends since 2013
pnpm run backtest -- --universe sp500 # the large caps alone, as before
pnpm run backtest -- --from 2016-01   # a later start
pnpm run backtest -- --limit 60       # the first 60 companies, to try it out
pnpm run backtest -- --no-analysts    # without the rebuilt consensus, for comparison
pnpm run backtest -- --no-departed    # today's members only
pnpm run backtest -- --no-insiders    # without the insider candidates
pnpm run backtest -- --studies        # and the studies: the score under other rules, the top tenth
pnpm run backtest -- --write-weights  # and commit the weight fit, if it held up
```

**Longer horizons.** Value is said to work over quarters and years rather than
weeks, so the score is measured at six and twelve months too. With 166
month-ends that is 27 and 13 independent windows: the t-statistics there are
wide. The weight fit is still fitted at one month and checked at one and
three — the check was fixed with the rule, and a check that grows with
whatever else is measured is one that moves after the result is seen.

**The score cut up** (`bucketReturns`). The rank IC says whether the score
orders the stocks on the whole; the tenths, the published verdicts and the
whole points of the score say whether each part earns more than the one below
it. Each is measured every month against the average stock of that month,
not the index — the market and the small caps' lag since 2020 are not in
it — with each month's returns held to their own 2.5th and 97.5th
percentiles: one stock that went up eightfold decides which tenth "won" in
the mean, and is never seen by the rank.

The SEC answers a burst with a ten-minute block even under its stated ten
requests a second; the download keeps to five and waits out a refusal rather
than losing the company, so two runs see the same universe.

Every criterion's own figure is evaluated too, turned so that more is better.
A pillar that ranks nothing may still hold a criterion that does, and a
criterion with a negative IC is read in the wrong direction.

**What it found (27 September 2026, 165 month-ends, 490 companies).** The
number-only factor score does not rank the S&P 500's next month: IC 0.007
(t 0.9), and 0.002 over three months. By year the IC swings between −0.05 and
+0.05 with no sign it would settle. The criteria underneath say why:

| Criterion | IC, 1 month | t | Reading |
|---|---|---|---|
| Net share issuance | 0.020 | 2.5 | The one robust signal, as Pontiff and Woodgate found; 62 % of months right |
| ROIC spread, gross profitability, accruals | 0.006–0.013 | 1.0–1.4 | Weakly positive |
| DCF probability, the margin the price requires | 0.009 | 0.8–0.9 | Weakly positive |
| Twelve-minus-one momentum | −0.002 | −0.2 | Nothing, in US large caps over these years |
| Closeness to the 52-week high | −0.018 | −1.1 | Slightly the wrong way |
| Margin against peers, Rule of 40 | −0.009 to −0.011 | −0.9 to −1.7 | Slightly the wrong way |

This is how an efficient large-cap market over a decade that was poor for
value and quality usually looks, and the evaluation is not blind: it finds
the issuance effect where the literature does. It is also a result about the
number half alone. The consensus and revisions pillars, which carry a quarter
of the weight, could not be tested then — they can now, see *With the
consensus rebuilt* below. Whether the weights should move is the next
question, and it is asked on years the answer has not seen.

**Fitting the weights, and checking the fit.** Reading weights off thirteen
years of ICs is how a model gets fitted to its own past: some criterion always
did well, and a weight raised on it describes those years, not the next. So
the backtest fits them with a fixed rule and checks the rule the way a forecast
is checked (`src/backtest/weights.ts`):

1. **Criteria.** Each criterion's one-month IC — of its points, as the score
   reads it — tilts its judgment weight by `tiltFor`: shrunk towards zero by
   its standard error under a prior as wide as the criteria's true ICs are
   apart, and the weight multiplied by `1 + shrunk / width`. The width is read
   from the data (`priorSdFrom`, DerSimonian–Laird centred on no skill): the
   squared t-statistics of the criteria sum to their count plus the true
   variance times their total precision, so what the sum leaves above the count
   is the variance. Criteria that differ by no more than their noise give a
   width of zero, and nothing moves. Inside each pillar the weights keep their
   total.
2. **Pillars.** The same one level up, for the pillars the backtest can
   score, each read with its tilted criteria — with the rebuilt consensus, all
   six, the revisions pillar on its rating drift. A pillar it cannot score
   keeps its weight.
3. **The check.** Fitted on 2013–2019 and scored on 2020–2026 against the
   judgment weights on the same stocks and months, then the other way round;
   December 2019, whose month ahead is January 2020, belongs to neither half.
   The fit has held up when the published score's IC improves at one month in
   both directions and does not fall at three months in the forward one.
   Only then does `--write-weights` commit the rule applied to every month into
   `src/analysis/weight-table.ts`, generated like the calibration table, which
   `score.ts` lays over the judgment. The fit always starts from the judgment,
   so running it again on the same months gives the same weights instead of
   tilting them further.

The rule was fixed before either half was looked at. One thing changed after
the first run: the width was read unweighted then, which let the momentum
criteria decide, whose IC swings twice as wide as the others'. It is now
precision-weighted, as the estimator is meant to be. Neither version moves a
weight on all months. The twenty criteria's squared t-statistics sum to 17.9
over all months, 20.4 over 2013–2019 and 11.8 over 2020–2026, and without a
trace of skill anywhere they would average twenty. Together the criteria rank
the next month no better than chance does, and the differences between them
are the size noise makes:

| Criterion | IC 2013–2019 | IC 2020–2026 | Weight |
|---|---|---|---|
| Intrinsic value (DCF scenarios) | +0.018 | +0.015 | 35 % of valuation |
| Net share issuance | +0.010 | +0.015 | 5 % of quality |
| Margin against peers | −0.017 | −0.005 | 15 % of quality |
| Balance sheet & risk, the pillar | −0.014 | +0.002 | 15 % |
| Closeness to the 52-week high | −0.030 | −0.008 | 30 % of momentum |

Some signs repeat in both halves: every valuation criterion is positive, and
margin, the Rule of 40 and the 52-week high are negative. But of the forty
readings only one reaches two standard errors: margin in the first half, at
t −2.0 and −0.6 in the second. Forty readings of nothing produce one that
large five times in six.

On the first half alone the rule did tilt, slightly: valuation 30 → 36 %,
quality 20 → 25 %, margin inside quality 15 → 10 %, and the balance sheet
15 → 5 %. The balance sheet then turned positive in the second half, and on
2020–2026 the whole tilt added 0.0006 to the IC (t 0.2). On the second half
and on all months the rule moved nothing. The judgment weights stay, and
`weight-table.ts` holds no fit.

Raising net share issuance, the one criterion that stood out in the raw
figures, would have been exactly the fit the check exists to catch. Read as
the score reads it, within the sector, its t is 1.1 and 1.9 in the two halves.
It is the right sign twice, and not yet evidence.

**With the consensus rebuilt (2 October 2026, same 490 companies and 166
month-ends).** Two runs on the same downloads, one with `--no-analysts`. The
rating history gave a consensus for 77–89 % of the company-months before 2020
and 92–98 % after.

| Signal | Without the consensus | With it |
|---|---|---|
| Factor score, 1 month | IC 0.007 (t 0.9), right in 53 % of months | IC 0.012 (t 1.6), right in 59 % |
| … within the sector | 0.004 (t 0.5) | 0.009 (t 1.4) |
| Factor score, 3 months | 0.001 | 0.007 (t 0.4) |
| Consensus pillar, 1 month | — | 0.012 (t 1.4); rating 0.009, target upside 0.011 |
| Rating drift, 1 month | — | 0.007 (t 1.6; within the sector t 2.0) |

The consensus is the best-ranking pillar the backtest has measured, and the
score improves with it in ten of the fourteen years, and is level in one. It is still a
tendency, not evidence — no pillar reaches two standard errors, and a
factor worth its name ranks at 0.03 or more. The weight rule now tilts on all
months — consensus 15 → 18 %, revisions 10 → 15.5 %, balance sheet 15 → 8 % —
but the check does not hold: fitted on 2020–2026 it moves nothing, and fitted
on 2013–2019 it adds 0.0009 to the IC of the years after (t 0.3). The judgment
weights stay.

**On the S&P 1500 (3 October 2026, 166 month-ends).** Three runs on the same
downloads: today's 1,414 members alone, then with the companies that left —
171 of the 735 that left since 2013 could be rebuilt — and the insider
candidates.

| Signal, 1 month | S&P 500 alone | S&P 1500, members | … and the departed |
|---|---|---|---|
| Factor score | 0.012 (t 1.6) | 0.012 (t 1.8) | 0.014 (t 2.1), right in 62 % of months |
| … within the sector | 0.009 (t 1.4) | 0.011 (t 1.9) | 0.012 (t 2.2) |
| … in the 400 | — | 0.005 (t 0.5) | 0.005 (t 0.6) |
| … in the 600, since Dec 2019 | — | 0.015 (t 1.6) | 0.017 (t 2.0) |

For the first time the score clears two standard errors, pooled and within
the sector. It does so in the small caps and on the whole, not in the mid caps,
and the IC has been positive in every year since 2021 (0.011–0.058), after
four negative years out of five in 2016–2020. Two cautions. The departed are the ones that
still trade, mostly companies that shrank out of the 600; the bought ones are
missing, and whether they were rated high or low decides which way that
leans. And 0.014 is still under the 0.03 a factor worth its name reaches. The
weight rule moved nothing on either half; the judgment weights stay.

The insiders are a null result. Over the S&P 1500 the number of insiders who
bought ranks the next month at −0.007 (t −1.4) and the next quarter at −0.009
(t −2.3); within the sector, where the buying of a beaten-down industry nets
out, at −0.004 (t −1.1 and −1.3). In the small caps it is +0.001 to +0.021,
none of it beyond noise. The studies found the effect mostly in micro caps
below the 600 and in years before 2008; in these stocks and these years it
does not show, and no pillar will read it. The tercile spread is no help
for a signal that is zero for most stocks: with that many ties there is a
bottom third only in months when a third of the index had buyers.

**The payout (8 October 2026, same downloads).** The dividend yield ranks
nothing. Over one month it is −0.002 (t −0.2) across the S&P 1500 and 0.004
(t 0.6) within the sector; among payers alone 0.002 (t 0.2); in the large caps
the higher yields lagged a little (−0.016, t −1.3). The shareholder yield passes
the rule — 0.012 within the sector (t 2.1), positive in both halves (0.007 and
0.018) — but the share count's change on its own, which the quality pillar
reads already, does better at every horizon: 0.012 (t 2.7) within the sector
at one month, 0.028 (t 3.1) at six, against 0.012 (t 2.1) and 0.026 (t 2.0).
What carries in the shareholder yield is the buybacks; the dividend added to
them dilutes the signal. No criterion is added. The dividend model's new
perpetuity left the score where it was, 0.014 (t 2.3) at one month before and
after, and the value lens at 0.010 (t 1.0).

**At longer horizons, and cut up (3 October 2026).** The factor score's IC
stays about the same as the horizon grows — 0.014 at one month, 0.011 at
three and six, 0.010 at twelve — while its t falls with the fewer windows.
Quality is the pillar that grows: 0.007 → 0.010 → 0.014 → 0.023, as the
literature has it; valuation does not.

At one month the verdicts lie in the order of their names, against the
month's average stock: STRONG BUY +0.16 %, BUY +0.10 %, HOLD 0.00 %, SELL
−0.05 %, STRONG SELL −0.15 % a month — small, and none of them alone beyond
noise. Over three and six months the top falls back. A score of 8 or more —
under two per cent of the stocks, mostly STRONG BUY — trails the average by
1.1 % over three months (t −2.0) and 2.7 % over six (t −2.3), in the 500, the
400 and the 600 alike, while 6–7 is ahead. At twelve months it is ahead again
(+2.5 %, t 0.8), on thirteen windows. The ninth tenth does better than the
tenth at one, three and six months. What gets a stock to 8 is every lens
agreeing — cheap, sound, rising, liked — and that is a crowded place to buy:
the conviction stretch, which rewards agreement, may be carrying the top
past what it earns. The raw score before the stretch does slightly better in
its top tenth (−0.1 % against −0.2 % at three months), not enough to say. A
change to the bands or the stretch would be a change to the model, tested the
way the weights are and decided by its owner, not here.

**Without the conviction stretch (3 October 2026).** Tested as a variant
(`backtest/variants.ts`, run with `--studies` — the monthly run leaves the
studies out, and the page shows the newest that has them): the same rows assembled again — the same criterion
points, trust and caps — with the stretch at full, half and none. The stretch
is not what makes the top fall back:

| | IC 1 / 3 / 6 / 12 months | 9th / 10th tenth, 6 months | HOLD | STRONG BUY |
|---|---|---|---|---|
| As published | 0.014 / 0.011 / 0.011 / 0.010 | +0.45 % / +0.04 % | 75 % | 1.1 % |
| Half the stretch | 0.014 / 0.011 / 0.011 / 0.010 | +0.76 % / −0.20 % | 81 % | 0.3 % |
| No stretch | 0.014 / 0.011 / 0.011 / 0.010 | +0.83 % / −0.10 % | 90 % | 0.0 % |

The order of the stocks is the same in all three, at every horizon and in
each index: the stretch multiplies a distance by how much the pillars agree,
and that moves few stocks past each other. The top tenth trails the ninth over
six months in every variant — it is the very top of the ranking that falls
back, whatever it is called. What the stretch changes is the labels: without
it nine stocks in ten are HOLD, BUY and SELL hold five per cent each and
STRONG disappears, which is the state the stretch was made to end. With half
of it, the few left at 8 or more fell back harder (−9.7 % over six months on
59 cases). The stretch stays; what to make of the top is a separate question.

**What the top tenth is made of (3 October 2026).** A study
(`backtest/top-decile.ts`, run with `--studies`): every company-month's
features at the moment it was ranked, the top tenth's medians against the
ninth's and the rest's, and the top tenth split each month at its own median
of each feature, three and six months on, in both halves of the years.

The top tenth is cheap, growing, liked and already rising: a P/E of 13.8
against 23.7 for the middle, revenue up 10.7 % against 5.8 %, 14 % to the
analysts' target against 9 %, 19 % up over the year against 10.5 %, every
pillar above the rest and the pillars agreeing as much as at the very bottom.
It is not smaller, and not tilted to the small caps.

Inside it, the half the market had not confirmed falls back: split on the
momentum pillar, the upper half leads by 1.0 % over three months (t 1.7) and
2.2 % over six (t 1.8); on the three-month return, by 2.1 % over six (t 2.2) —
the same way in both halves of the years, and weaker or absent in the ninth
tenth. The cheapest half of the top trails by 1.05 % over three months
(t −2.4), in both halves; in the ninth tenth it leads. Cheap, sound and
unconfirmed: a value trap. A split on the balance sheet that looked like a
finding turned its sign when the top was split at its own median instead of
the month's — seventeen features at two horizons will offer one of those.

Turned into a rule fixed in advance — no STRONG BUY while the momentum pillar
is below neutral — it made the STRONG BUYs worse, not better: −4.0 % over six
months (t −2.5) against −2.5 % (t −1.9). The top tenth is ninety stocks a
month; STRONG BUY is six or seven, and among those it was the ones that had
already run that fell back. Two different things at two depths, the second on
too few stocks to read. The rule is not adopted, nothing in the score
changed, and the top's fall over half a year is left for the live evaluation
to confirm or dismiss.

**And the bottom tenth (3 October 2026).** STRONG SELL did no worse than the
average stock, so the same study asks which half of the bottom recovers. The
bottom tenth is expensive and stalled: a P/E of 40 against 24 for the middle,
revenue up 0.6 %, the year flat, 17 % under its high, every pillar low and the
pillars agreeing as much as at the top. It trails the average stock only a
little — 0.1 % over a month, 0.4 % over six, 0.7 % over twelve, none beyond
noise — and no more than the second tenth does. Split at its own medians, no
feature passes: the largest difference, the higher-beta half ahead by 3.5 %
over six months (t 2.0), shows nearly as strongly in the second tenth, which
makes it the market's rise over these years rather than anything about the
bottom; the faster-growing and the higher-quality halves trailed (t −1.9 and
−1.8). Fifty-one splits offer about that much by chance. No rule follows. A
low score marks a stock that is dear and stalled; it does not forecast a
fall.

**Narrower bands (3 October 2026).** Three stocks in four are HOLD, so two
narrower ones were tested as variants on the same rows, with the rule fixed
before the run: worth having only if BUY still beats the average stock and
SELL still trails it at one and six months, in both halves of the years, with
BUY − SELL no smaller than published. Scores between 4 and 6 earned within
0.02 % a month of the average stock; the only whole point with a t above 2 is
6–7 (+0.15 %, t 2.2). Moving the bands in therefore relabels stocks the score
cannot tell apart:

| Bands | HOLD | BUY − SELL, 1 / 6 months | BUY, 6 months (halves) | SELL, 6 months (halves) |
|---|---|---|---|---|
| Published (BUY 6.5, SELL < 3.5) | 75 % | 0.24 % / 1.21 % | +0.56 % (+0.21 / +0.94) | −0.65 % (+0.41 / −1.78) |
| BUY 6.0, SELL < 4.0 | 59 % | 0.22 % / 0.93 % | +0.44 % (−0.01 / +0.93) | −0.49 % (+0.23 / −1.25) |
| BUY 5.5, SELL < 4.5 | 37 % | 0.14 % / 0.37 % | +0.21 % (−0.31 / +0.77) | −0.16 % (+0.48 / −0.85) |

Both fail; the published bands stay. They do not pass the rule cleanly either
— SELL was ahead over six months in 2013–2019 — which is the honest size of
what any band can say. To tell one HOLD from another the list shows instead
where the factor score stands among every stored stock's (*über 84 %*, under
the verdict).

**Does it measure the app's score? (3 October 2026)** Every run now also
compares itself with the live scores (`backtest/fidelity.ts`, alone with
`--fidelity`): for every stock the app holds that is in the S&P 1500 too, its
newest live factor score beside the one the backtest rebuilds for the same
session, and between them the backtest's data scored the app's way — its
calibration, premium and rates — so that what the data do and what the method
does come apart. The page shows it as *Misst der Backtest den Score der App?*,
with the criteria, the input fields and the largest gaps.

The first comparison, on 470 stocks, gave a rank correlation of 0.70. The
method accounted for almost none of the gap (0.98 between the backtest's data
scored either way: the calibration population hardly matters), the data for
nearly all of it. Momentum agreed at 1.00 and the rebuilt consensus at 0.91;
the revisions pillar at 0.17, since the app's estimate revisions and surprises
have no history. Field by field, the comparison found three faults in the
rebuilt payload, all now fixed and tested (`test/fidelity.test.ts`):

- **Stale tags.** Only the revenue was checked for age. VICI last tagged its
  operating income for 2020, and every month-end since read 2020's figure
  beside the current revenue — a REIT covering its interest 0.4 times. A flow
  more than a year behind the revenue, or a balance-sheet item more than 200
  days behind, is now missing rather than old.
- **Untagged debt counted as none.** AES keeps its 33 billion of debt in its
  own taxonomy, which the SEC's company facts leave out; the backtest summed
  the missing lines to zero and gave a leveraged utility 7.8 for its balance
  sheet. No debt tagged with interest paid is now unknown debt.
- **Lines tagged in pieces or renamed.** Lilly and AES tag no operating
  income; the EBIT is now the pre-tax income with the interest added back, as
  Yahoo's is. Both tag their liabilities only as current and non-current,
  now added up. The 2024 taxonomy moved many interest expenses, the banks'
  among them, to `InterestExpenseOperating`, now read.

After the fixes: 0.75, the same verdict for 80 % of the stocks and at most one
step apart for all, 25 of the top tenth's 47 in both top tenths.

It found one fault on the live side too: the app read `netIncomeToCommon`
from Yahoo's `financialData`, where there is no such field, so every stock's
net income was its last fiscal year's — Amazon's 78 billion for 2025 beside a
trailing 135, half the S&P 500 off by more than a tenth. It is read from the
key statistics now; the stored snapshots catch up as the nights refresh them.

Months that are not over no longer count as windows: the last session there
was used to stand in for a month-end, and the window formed on 30 September
ended on 2 October (`closedMonthEnds`).

With the payload fixed, the run of 3 October moved: the factor score's IC at a
month is 0.0145 (t 2.3; in the sector 0.0137, t 2.5). The top's fall over half
a year weakened — a score of 8 or more trails by 2.0 % over six months (t −1.3)
instead of 2.7 % (t −2.3), and leads by 4.8 % over twelve (t 1.7) — so part of
it rested on companies the backtest had built wrong, AES-like utilities with
their debt missing among them. What held is the split inside the top tenth:
the half the price had not confirmed still trails, by 2.5 % over six months on
the momentum pillar (t 2.0, in both halves of the years).

What the comparison means for every number above: the backtest measures a
close relative of the app's score, not the score itself. It lacks the
estimate revisions entirely, and half of its top tenth is not the app's.

**Beside the verdict.** What the backtest says each verdict did is shown where
the verdict is (`VerdictEvidence.tsx`, from `/api/backtest/verdicts`): on the
stock page under the verdict, the stocks the newest run gave the same factor
verdict against the average stock of their month, one, three, six and twelve
months on, in bold only where a figure is two standard errors from nothing;
in the list, the same as a line on hovering over the chip. A STRONG BUY ahead
after a month and behind after six says something different from one ahead
after both, and the label alone says neither.

**The fair value under test (3 October 2026).** The score reads the
valuation through calibrated criteria; the page's headline is something else —
the composite fair value, the weighted median of the primary models with their
range around it — and it had never been tested. A study (`backtest/fair-value.ts`,
with `--studies`) keeps every company-month's price, fair value, range,
conservative lens and DCF scenarios and asks four questions of them. On the
S&P 1500 since 2013, as the backtest rebuilds the fair value (no consensus
estimates; the rating history's target):

- **It does not rank.** The gap ln(fair / price) has a rank IC between −0.008
  and +0.006 at one to twelve months, no |t| above 0.6 — for the headline, the
  conservative lens and the DCF alike.
- **The price does not close the gap.** Regressed month by month on the gap,
  the excess return recovers 0.2 % of it over a month and 0.9 % over a year
  (t 0.3). A fair value the price obeyed would show tens of per cent.
- **Its place in the range earns nothing.** A price below every primary model
  (28 % of the company-months) did no better than one inside; one above every
  model trailed slightly, by 0.2 % over a month and 0.9 % over a year, with
  no |t| above 1.2.
- **The range does not draw the price.** The price stood inside the primary
  models' range 60 % of the time when it was drawn and 50 % a year later; inside
  the middle half 32 % and 27 %. The DCF's scenarios from bear to bull — its
  10th to 90th percentile — held the price itself only half the time: the
  scenarios spread less than model and market disagree.

The fair value describes what the models make of the company; it does not
forecast the price, and its margin of safety is not an expected return. The
backtest's fair value is not quite the app's — the comparison puts the DCF
criterion at a rank correlation of 0.66 — so the live view measures the app's
own as well (*Lücke zum fairen Wert* under *Live gegen Backtest*). And every
verdict in *Unser Urteil* now carries the fair value the page showed beside it
that day, with the share of the gap the price has covered since.

The stock page says so where the margin is shown: under the composite fair
value, what its gap did in the newest study — the rank IC at one to twelve
months, the share of the gap closed in a year — and what stocks standing
where today's price stands in the models' range earned over the year after
(`FairValueEvidence`, from `/api/backtest/verdicts`). The margin describes the
models; it is not an expected return.

**Against the index, as a portfolio (3 October 2026).** Everything above
reads the score against the month's average stock, equal-weighted. An
investor's yardstick is a cap-weighted index, and from 2013 the largest
companies ran far ahead of the average one: the average S&P 1500 stock made
13.4 % a year, the S&P 500 14.6 %, the MSCI World 11.6 %. So every run now
also buys the top N stocks by a signal at each rebalancing month-end, in equal
parts, holds them, and marks them at every month-end on dividend-adjusted
closes, at 0.1 % a side for every name bought or sold, without taxes
(`backtest/portfolio.ts`). Two signals: the published score, and quality plus
momentum — the mean of the two pillars, as the research describes the most
robust premia, not as this data would weight them. The rule, fixed before the
first run: at 25 stocks rebalanced quarterly a signal beats the index only if
it is ahead of the MSCI World ETF (URTH) after costs in both halves of the
years.

| Portfolio | a year | vs MSCI World (2013–19 / 2020–26) | vs S&P 500 | deepest fall |
|---|---|---|---|---|
| Score, 25, quarterly (the rule) | 10.0 % | −1.6 % (−1.0 / −2.2) | −4.6 % | −39.6 % |
| Score, 25, monthly | 11.9 % | +0.3 % (−0.4 / +1.1) | −2.7 % | −35.2 % |
| Score, 25, yearly | 16.3 % | +4.7 % (+5.9 / +3.4) | +1.7 % | −34.0 % |
| Score, 50, yearly | 15.3 % | +3.7 % (+5.8 / +1.5) | +0.7 % | −31.0 % |
| Quality + momentum, 25, quarterly (the rule) | 14.3 % | +2.7 % (+8.0 / −2.7) | −0.3 % | −29.1 % |
| Quality + momentum, 50, yearly | 15.4 % | +3.8 % (+6.5 / +0.9) | +0.8 % | −26.4 % |
| MSCI World (URTH) | 11.6 % | | | −25.5 % |

All three verdicts of the rule fail: neither signal beats the MSCI World in
both halves at 25 stocks a quarter, and quality plus momentum does not beat
the score. Two things are worth saying about the rest, as observations rather
than findings — ten portfolios are ten chances. Held for a year, the score did
better than held for a quarter, in both halves: the same shape as its top,
behind over three and six months and ahead over twelve. And most of the lead
over the MSCI World is the American market's over the rest of the world: a
portfolio of American stocks is set against an index two fifths outside
America, and against the S&P 500 the best of them leads by 1.7 % a year, with
a deeper fall (−34 % against −24 %); it was ahead of the MSCI World in nine
calendar years of fourteen. The
missing bankruptcies flatter all of it.

**Trade setups against a random entry (3 October 2026).** The idea of a trade
rather than a holding — undervalued, low in its band, likely to come back, with
a stop and a target — needs a different test, because a stop and a target make
no edge of their own: a price that wanders at random reaches a target three
typical moves up before a stop two moves down about two times in five, and
the distances alone decide that. So every scored stock at every month-end is
a trade — entered at the close, stopped, taken or timed out on the daily
closes that follow, 0.1 % a side — and those are the random entries. A setup
is worth something only if the trades it picks earn more than the month's
random ones (`analysis/setups.ts`, `backtest/setups.ts`, every run).

Five setups were fixed before the first run, with the rule: |t| ≥ 2 on months
three apart, and both halves of the years the same way. Two are the idea
itself (at least 25 % under the fair value, and at the lower edge of the
quarter's channel or just off the six-month low); the others a dip in an
uptrend (above the 200-day line, RSI under 35), a new yearly high and the
bounce alone. Stops and targets are in the stock's typical daily move, from
closes (`atr14`). The rule's distances — two and three moves, three months —
ended trades in about a week, so a wider set (four and six moves, six months)
was added after a trial run on 150 companies in which nothing carried: added
for the holding time, shown and not judged.

| Setup | trades | target first (random 48 %) | per trade | against random, same month (2013–19 / 2020–26) |
|---|---|---|---|---|
| Undervalued, low in the channel | 11,327 | 53 % | +1.24 % | +0.27 % (t 1.3; +0.38 / +0.16) |
| Undervalued, off the low | 4,450 | 50 % | +2.62 % | −0.64 % (t −1.3; −1.09 / −0.29) |
| Dip in an uptrend | 2,139 | 55 % | +0.77 % | −0.20 % (t −0.6; +0.39 / −0.81) |
| At the yearly high | 15,386 | 43 % | −0.20 % | +0.05 % (t 0.2; +0.34 / −0.26) |
| Off the low | 9,013 | 50 % | +2.00 % | −0.21 % (t −0.6; +0.06 / −0.49) |

None carries, at either distance. The setups off the low look best per trade
— +2.6 % at the rule's distances, +5.5 % at the wider ones — and are behind
the random entries of the same months: they fire after a market has fallen,
when everything bounces, and they bounce less than the rest. A return per
trade without its month is the market's. The list shows a setup that fires
today beside the chart, with its stop, target, the position a 1 % loss at the
stop allows, a risk line (volatility, a capped verdict, thin data) and what
the backtest found for it; the evaluation page has the table.

**When to buy: the chart under test (3 October 2026).** The verdict says
whether a stock is worth owning; it does not say where the price stands on its
own recent path. Seven readings of that path are candidates now
(`analysis/timing.ts`), each turned the dip buyer's way — more is deeper down:
the last month's fall, a low RSI, the distance under the 50- and the 200-day
line, the place in the quarter's channel (the last close against a straight
line through 63 log closes, in the residuals' standard deviations), the
nearness of the six-month low, and a bounce off it (low made 3 to 15 sessions
ago, 5 % back since). The thresholds were fixed before the first run, and so
was the rule for what counts: |t| ≥ 2 and both halves of the years the same
way. One function computes them for the live technicals and for the
backtest's month-ends, on the same adjusted closes.

Each is measured across all stocks as a candidate IC, and inside each verdict
group (`backtest/timing.ts`, every run): each month the stocks of BUY and
STRONG BUY, of HOLD, of SELL and STRONG SELL are split at the group's median of
the reading, and the half deeper down set against the half higher up. On the
S&P 1500 since 2013:

- **Over a month, a dip earns a little and proves nothing.** For the last
  month's fall, the RSI, the 50-day line and the channel, the half deeper down
  is ahead by 0.1 to 0.35 % in every group — the short-term reversal the
  literature knows — but no figure reaches t 2, and since 2020 they are about
  zero.
- **Over half a year, the trend wins.** Near the six-month low trails the
  half further from it by 1.5 % (t −2.9) — in BUY by 2.1 %, in SELL by 1.8 %,
  in both halves of the years. A bounce off the low did worse, not better
  (−3.1 %, t −2.0; in HOLD −4.3 %, t −3.4). This is the 52-week-high effect
  the momentum pillar already reads, seen from its other end.
- **Four of the 84 tests pass the rule;** chance alone passes about one in
  thirty. The one pattern beyond that is the second: a stock that is down
  stays down for a while, whatever its verdict.

So no reading votes, and the verdict does not wait for the chart. The list
shows the readings beside the verdict (*Chart*: the channel's direction and
the edge the price is at, the month and the RSI), and on hovering each one
beside what the backtest found for the stock's own verdict group; the page
*Auswertung* has the whole table.

Every backtest run asks again, and every month the live evaluation adds from October 2026 on is one no
rule here has seen.

## Technical signals gauge

Indicators come from [`trading-signals`](https://github.com/bennycode/trading-signals);
`src/analysis/technical.ts` feeds it the daily bars and snapshots the latest value of each.
TradingView-style aggregation on top of that in `src/analysis/signals.ts`:

- **Moving averages** — SMA/EMA 10, 20, 50, 100, 200 vs price
- **Oscillators** — RSI14, Stochastic %K/%D, MACD histogram, CCI20, Williams %R, momentum
- **Overall** — weighted blend mapped to STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL

The gauge is shown on the page and does not vote in the score. Its moving
averages bet on trend and its oscillators on reversal, so the two halves partly
cancel, and the momentum pillar reads the return series directly instead.

## Data sources

| Source | Data |
|--------|------|
| Yahoo Finance (`yahoo-finance2`) | Price, fundamentals, annual + quarterly income statements, balance sheets and cash flows, daily/monthly price history, analyst targets & ratings, earnings history + estimates, options chain, insider transactions, institutional ownership |
| Yahoo Finance search API | Symbol auto-resolution (`FACC` → `0QW9.IL`) |
| Finnhub `/stock/metric` | ROIC, 3-year EPS CAGR, 5-year dividend growth rate |
| Finnhub `/stock/peers` + `/stock/metric` | Peer-group median multiples & profitability — without the company's own other share classes and without negative multiples |
| Finnhub `/company-news` | Recent news (last 7 days) |
| FRED | 10Y Treasury, Moody's AAA, ten-year government yields for 19 currencies, VIX, DXY, yield curve, HY spreads, sector ETF prices |
| SEC EDGAR | Latest 10-K / 10-Q filings; operating lease liabilities from XBRL (US filers only) |
| [`datasets/s-and-p-500-companies`](https://github.com/datasets/s-and-p-500-companies) | S&P 500 members — the reference universe |
| Wikipedia (`EURO_STOXX_50`, de: `DAX`) | EURO STOXX 50 and DAX members — the reference universe |
| Wikidata `P946` | ISIN lookup (Yahoo dropped the field; Wikidata is curated and global). German WKN derived from `DE0…` ISINs. |
| Perplexity Sonar | Optional forensic brief — dated events, contrary evidence, bull and bear claims graded against the evidence; goes to the narrative stage, which never sees the valuation |

### What the trailing figures are, and where they come from

Yahoo hands out ready-made trailing figures in its market-side block
(`financialData`), and three of them do not mean what their names say:

| Field | What Yahoo's field is | What the models assumed | Example |
|---|---|---|---|
| `freeCashflow` | S&P's *levered* free cash flow | operating cash flow − capex | Microsoft 16.5 bn vs 67.0 bn, Netflix 25.4 bn vs 9.5 bn, Intel +4.9 bn vs −4.9 bn |
| `revenueGrowth`, `earningsGrowth` | latest quarter vs the same quarter a year ago | trailing twelve months | Apple 16.4 % in a year that grew 6.4 %; Alphabet's earnings "grew" 294 % on a revaluation gain |
| `sharesOutstanding` | one share class | every share of the company | Alphabet 5.87 bn of 12.23 bn, so every per-share value came out 2.08× too high |

So since `FINANCIALS_VERSION` 21 the trailing figures are rebuilt from the
quarterly statements (`src/analysis/trailing.ts`): free cash flow, operating
income, interest, capex, stock compensation and D&A summed over the last four
consecutive quarters, growth as those four against the four before, and the
newest fiscal year wherever the quarters have a gap. Shares are market cap over
price — every class, and ADR units for an ADR — and book value per share is the
newest common equity over that count (Berkshire's B line had carried the A
share's 522,226). `ebit` is operating income, not Yahoo's EBIT line, which adds
investment gains back in (Alphabet FY2025: 159.6 bn against 129.0 bn).

Three more corrections at the same layer:

- **London, Johannesburg and Tel Aviv quote in pence, cents and agorot** while
  market cap, EPS and book value arrive in pounds, rand and shekels. Everything
  is now in the unit the price is in (`src/currencies.ts`); Barclays had shown a
  P/B of 95×.
- **A missing exchange rate is no longer a rate of 1.** The inverse pair is
  tried, and if neither answers every statement figure is withheld with an
  `fx-unavailable` error instead of being read as the wrong currency.
- **The payload carries the rest of the equity bridge:** minority interest and
  preferred equity (claims ahead of the common shareholders), non-current
  investments the operating income does not earn on (Apple's 84 bn of long-term
  securities, Alphabet's 131 bn of stakes), and for US-GAAP filers the operating
  lease liability from the SEC filing — the part of total debt whose rent is
  already deducted from operating cash flow.

The payload marks which basis it carries (`trailingSource`); the models rebuild
what they can for payloads stored before it.
| Distill | Optional curated multi-source briefings per ticker (RSS, YouTube, web). Weighted **above** Perplexity / raw search because the editorial filter happens upstream |
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
│   ├── backfill.ts        One-shot import of the old file cache
│   ├── rescore.ts         Re-scores stored history on today's code; the current card from stored inputs
│   ├── calibrate.ts       Reference distributions and the premium adjustment by group (`pnpm run calibrate`, `--store`)
│   ├── timing-series.ts   The stored timing readings, put back together per refresh
│   ├── golden.ts          Captures stored inputs as golden fixtures (`pnpm run golden:capture`)
│   └── evaluate.ts        CLI for the outcome evaluation (`pnpm run evaluate`)
├── files.ts               The two things that stay files (filings, reports)
├── sector-medians.ts      Peer-group medians (the app's most expensive read)
├── app-config.ts          Operational settings edited from the admin page
├── scheduler.ts           Nightly pipeline — one cron, one queue, one symbol at a time
├── pipeline/steps.ts      The steps a run applies to a symbol, shared by both schedulers
├── universe.ts            The reference universe: members per index, departures, tonight's rotation
├── alerts.ts              Verdict changes: recorded when they happen, announced once they hold
├── digest.ts              The morning's message: what happened across the watchlist since the last
├── backtest-service.ts    The monthly backtest: schedule, child process, status
├── calibration-service.ts The admin page's calibration: child process, proposal, the file to commit
├── backtest/              The factor score rebuilt at past month-ends (`pnpm run backtest`)
│   ├── lock.ts            One run at a time across processes (an advisory lock)
│   ├── variants.ts        The same rows under another rule: the conviction stretch, a momentum floor for STRONG BUY
│   ├── top-decile.ts      What the top and bottom tenths are made of, and which half of each falls back or recovers
│   ├── timing.ts          Whether it pays to wait for the chart, within each verdict
│   ├── portfolio.ts       Top-N portfolios by a signal against the S&P 500 and the MSCI World, after costs
│   ├── setups.ts          Trade setups against a random entry with the same stop and target
│   ├── payload.ts         A company as the scorer would have seen it on a past day
│   ├── analysts.ts        Every company's rating history, cached on disk and archived
│   ├── insiders.ts        Every company's Form 4 trades from Finnhub, for the candidates
│   ├── departed.ts        The companies that left the S&P 1500, as far as they still trade
│   ├── prices.ts          Daily histories with their splits, cached on disk
│   ├── peers.ts           Peer medians from the month's own cross-section
│   ├── rates.ts           FRED and Damodaran by month
│   ├── result.ts          The stored result the page reads
│   ├── weights.ts         The weight fit, checked on the half of the months it did not see
│   └── run.ts             Month by month: rebuild, calibrate, score, evaluate
├── currencies.ts          Yahoo's quote currencies and the unit behind each (GBp → GBP)
├── distill-service.ts     Distill orchestration: symbol → entity UUID → briefings
├── distill-dossiers.ts    Mirrors the watchlist onto Distill's dossier switches
├── distill-sectors.ts     Yahoo sector/industry → Distill sector handles (1:n)
├── distill-content.ts     Assembles the company + sector dossier prose for a stock
├── score-service.ts       The three model calls and the blend that makes the headline
├── models.ts              Model registry — single source for CLI, server and web UI
├── providers/             LLM abstraction layer (anthropic, openai, factory)
├── search/                Brave + Tavily clients (LLM-native search is in providers/)
├── data/
│   ├── yfinance.ts        Yahoo: financials, quarterly revenues, ISIN via Wikidata
│   ├── finnhub.ts         News, basic metrics, peer-group medians
│   ├── fred.ts            FRED rates (live 10Y, AAA, …) and the local ten-year yields
│   ├── country-risk.ts    Damodaran's country risk premiums, default spreads and tax rates
│   ├── edgar-facts.ts     SEC XBRL company facts, point in time: every figure from the day it was filed
│   ├── universe.ts        Index members: the S&P 500 file, EURO STOXX 50 and DAX from Wikipedia
│   ├── macro.ts           SPY + sector-ETF bundles, yield curve, VIX
│   ├── perplexity.ts      Sonar-Pro forensic brief → structured findings
│   ├── distill.ts         Distill briefing service — briefings for a resolved entity
│   ├── distill-entities.ts Distill entity registry — identifier → entity UUID
│   ├── distill-dossier.ts Distill dossier switch — GET/PUT /entities/{id}/dossier
│   ├── distill-errors.ts  Typed Distill failures (shared by all three clients)
│   └── edgar.ts           SEC EDGAR filings
├── analysis/
│   ├── metrics.ts         19 valuation models
│   ├── dcf.ts             The revenue-driven DCF, its 512 draws and the reverse solves
│   ├── basis.ts           Shares, debt and the equity bridge every model values against
│   ├── cost-of-capital.ts Beta shrunk towards the peers', country premium, synthetic rating, WACC, stable growth
│   ├── trailing.ts        Trailing twelve months rebuilt from the quarters
│   ├── sampling.ts        Halton points and the normal quantile for the simulation
│   ├── computeMetrics.ts  Orchestrates the bundle of models for the web GET
│   ├── score.ts           The deterministic score: six pillars, their weights, caps, the blend
│   ├── weight-table.ts    Generated weight fit, empty until one holds up (`pnpm run backtest -- --write-weights`)
│   ├── calibration.ts     Percentile reading of a criterion against its reference distribution
│   ├── calibration-table.ts  Generated reference distributions (`pnpm run calibrate`)
│   ├── timing.ts          Where the price sits on its own path: the timing readings and their candidates
│   ├── setups.ts          Trade setups: entry rules, stop and target in typical moves, a trade walked on closes
│   ├── evaluate.ts        Rank IC, sector-neutral IC, the weight tilt and the joint test
│   ├── analyst-history.ts The analyst consensus of a past day, rebuilt from the rating actions
│   ├── verdict-record.ts  Our verdicts as calls, against the index after 1, 3, 6 and 12 months
│   ├── insider-signals.ts The insiders' open-market buying and selling before a day
│   ├── payout.ts          Dividend and buyback yields: the share count's change, and the yields as candidates
│   ├── data-quality.ts    Cross-field contradiction audit — feeds the caps
│   ├── run-rate.ts        TTM ↔ run-rate factor shared by SVR, peer medians and the UI
│   ├── signals.ts         TradingView-style buy/sell signal aggregation
│   └── technical.ts       SMA/EMA/RSI/MACD/Bollinger/Stoch/CCI via `trading-signals`
├── output/
│   ├── prompt.ts          The three stage prompts: data, narrative, synthesis
│   ├── score-card.ts      Renders a factor score for a prompt or the UI
│   ├── markdown.ts        Terminal + report markdown
│   └── report.ts          PDF/HTML report (Puppeteer)
└── utils/
    ├── logger.ts          Chalk-based structured logging
    ├── pool.ts            At most n tasks in flight, stoppable between items
    └── rate-window.ts     At most n calls per rolling window, waiting rather than failing

web/
├── index.html
├── vite.config.ts
├── tailwind.config.js     Maps Tailwind colour tokens → CSS vars in styles.css
├── src/
│   ├── App.tsx            Routing (hash), state, SSE wiring
│   ├── pages/             Administration, Auswertung, Was ist passiert (FeedPage)
│   ├── api.ts             Thin fetch wrappers
│   ├── types.ts           Mirror of server schemas (StockBundle, AnalysisFlagsKey, …)
│   ├── format.ts          fmt*, mosColor, recommendationColor helpers
│   ├── styles.css         ALL theme tokens as :root HEX vars
│   └── components/
│       ├── stockList.ts           The list as a model: filter, sort, score colours
│       ├── StockRowCells.tsx      The row markup both densities share
│       ├── useListScroll.ts       Carries the scroll position between them
│       ├── StockTable.tsx         The list at full width (Übersicht)
│       ├── StockRail.tsx          The same list at rail width, beside an analysis
│       ├── StockListControls.tsx  Search · sort · watchlist, shared by both
│       ├── VerdictChanges.tsx     The week's verdict changes above the overview, linking to the feed
│       ├── VerdictRecordPanel.tsx Our verdicts as calls, under Auswertung
│       ├── BacktestPanel.tsx      The backtest's view under Auswertung
│       ├── AnalysisModal.tsx      Stored analyses + model/search/pplx, as a dialog
│       ├── AnalysisView.tsx       Centre detail; renders all sections
│       ├── VerdictHero.tsx        Verdict + composite + analyst hero cards
│       ├── ScoreSplit.tsx         The two halves behind one headline, per list row
│       ├── BullBearRisks.tsx      bull and bear case, each in theses / figures / triggers
│       ├── ConsensusBar.tsx       3px buy/hold/sell stripe per rail item
│       ├── StockHeader.tsx        Logo, price, P/E, dividend against the bond, refresh — and the ✕ / ⚙ chrome
│       ├── StockLogo.tsx          Multi-source logo cascade (TradingView → Logo.dev → …)
│       ├── ProgressBanner.tsx     SSE progress events while a run is in flight
│       ├── AnalyzeForm.tsx        Bottom "analyze a new symbol" input
│       ├── icons.tsx              Gear, close and sliders as SVG
│       ├── Section.tsx            Collapsible section with localStorage state
│       ├── charts/                ECharts wrappers (Composite, FundamentalsHistory, …)
│       └── sections/              ValuationDetail, QualityScores, FundamentalsGrid,
│                                  PeerCompare, TechnicalSignalsPanel, PriceAction,
│                                  MarketContext, OwnershipFlow, EarningsBlock,
│                                  NewsAndResearch, CompanyInfo, ScoreBreakdown,
│                                  ValuationHistory, MarginTrends
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
| `snapshots` | Raw payloads (financials, market signals, models, peers, news, the published score card, Yahoo's statements, estimates and holders as received), deduplicated by content hash |
| `observations` | `(symbol, metric, timestamp, value)` — the chart surface, ~325 values per symbol per run |
| `documents` | Distill briefings, Perplexity syntheses, verdicts, search traces — one row per version that actually changed |
| `fundamental_periods` | Reported figures keyed by fiscal period *and* observation date, so restatements are visible |
| `macro_observations` | VIX, yield curve, HY spread, DXY, FRED rates as a refresh read them — global, one row per day |
| `runs` / `run_steps` | Pipeline provenance; every row above can point at the run that produced it. Never pruned |
| `price_bars` / `price_events` | Daily prices per ticker — stocks, the index, VIX, the dollar, the sector ETFs — with splits and dividends; ten years on a ticker's first refresh |
| `analyst_actions` | Every rating action and price-target change Yahoo lists, by firm, back to 2012 for the large caps |
| `insider_transactions` | Individual insider trades, appended as Yahoo's two-year window moves on |
| `macro_series` | Every FRED series the models read, plus the short rates, the policy rate, inflation, its expectation and unemployment — by the date each value is for, back to 1990; and Damodaran's monthly implied premium |
| `distill_entities`, `filings`, `settings` | Mappings and operational state |
| `distill_dossiers` | Which dossier switches we have set upstream, and why any are out of sync — for companies *and* the sectors they sit in. Keyed by subject text, not by `symbols(id)`: deleting a stock is exactly when the switch has to be turned off, and a cascading row would erase that intent first |

**Keep what was fetched.** What is not stored cannot be evaluated later, and
neither Yahoo nor Finnhub hands the history out again — a delisted stock's
prices vanish, an analyst's old target is replaced by the new one. A refresh
used to download a year of daily prices, a decade of analyst actions and two
years of insider trades, and keep technical indicators, one month's rating
counts and six insider totals. Every path that fetches financials now archives
the rest (`history-service.ts`): the bars and corporate actions, the statements
in their reporting currency with their real period ends, the estimate and
rating modules, the holders, every analyst action and insider trade, and
Finnhub's two decades of annual and quarterly ratios (kept apart from its
daily ones, so the quarter-megabyte series adds a row a quarter). The first
refresh of a ticker fetches its last ten years once, and the benchmarks are
kept current daily. Archiving is best effort — a failure is logged, never
fatal to the refresh — and nothing is ever pruned: runs used to be cut to the
last twenty, which left every stored number pointing at a run that no longer
existed after three weeks.

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

The web UI never silently invalidates an analysis — outdated entries stay selectable but show a ⚠ marker, and the refresh button carries a **!** that points at the menu entry which brings it up to date.

## Nightly pipeline

One cron, one queue, one symbol at a time — configured in **⚙ Administration**,
stored in `app-config.json`, executed in-process by `src/scheduler.ts`.

Per symbol, in order:

| # | Step | What it does | Default |
| --- | --- | --- | --- |
| 1 | **Marktdaten** | Yahoo + Finnhub + FRED + macro + technicals, and one recorded history point | on |
| 2 | **Distill** | The rolling dossiers for the company and each sector it sits in, plus the raw insights those dossiers do not reproduce (`GET …/dossier/content?include=insights`). Free, with nothing to configure | on |
| 3 | **Analyse** | Only when the newest verdict is older than *max. Alter*; forced past the LLM cache so it produces a genuinely new one | on, 5 days, `gpt-6.1-sol` |
| 4 | **Referenz** | After the whole watchlist, on full runs only: the next members of the [reference universe](#the-reference-universe) (S&P 500, EURO STOXX 50, DAX), numbers and factor score only | on, 100 per night |

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
pnpm run calibrate    # recompute the reference distributions → src/analysis/calibration-table.ts
pnpm run evaluate     # rank IC of the stored scores, watchlist and universe
pnpm run backtest     # the factor score rebuilt monthly since 2013 from SEC filings, and the weight fit checked
```

**Golden tests.** `test/golden/` holds the stored inputs of six real stocks: a
megacap, an insurer priced by its excess returns, a euro listing, an ADR
reporting in kroner, a firm losing money, and one with almost no revenue.
`test/golden.test.ts` recomputes every model and the factor score from them.
Any change that moves a real stock's numbers fails a test instead of passing
unnoticed:

```bash
pnpm run golden:capture -- MSFT,BRK-B   # new fixtures from the database
UPDATE_GOLDEN=1 pnpm test               # accept an intended change
```

The diff of the `*.expected.json` files is the change's effect on real stocks,
reviewable line by line. They are scored on the explicit ramps, so a
recalibration does not rewrite them.

## License

MIT
