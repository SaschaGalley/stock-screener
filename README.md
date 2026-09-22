# stock-cli

Fundamental stock analysis from the terminal *and* a local web UI. Fetches live financial data, runs 19 valuation models, then asks an LLM for a structured bull/bear/risks analysis with a composite fair-value range.

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

With `FRED_API_KEY`, Graham Revised, DDM, EPV, the 2-Stage DCF, RIM and Sortino models pull live rates instead of hardcoded fallbacks: the 10-year Treasury, the Aaa yield, ICE BofA credit spreads per rating bucket (the cost of debt), and ten-year government yields for listings that trade outside the dollar (`LOCAL_TEN_YEAR` in `src/data/fred.ts`). The equity risk premium needs no key — it is Damodaran's monthly implied ERP. A rate that fails to load falls back to the last reading, then to a constant, and is retried within minutes; only rates actually read are recorded. The key also unlocks the macro context block (VIX regime, yield curve, HY spreads, DXY).

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

**Übersicht** — the list at full width, and the resting state: the headline score with its change since the first recorded point and, underneath, the two halves it was blended from (see [Score and verdict](#score-and-verdict)), a sparkline of the score over time, the verdict label and model, price, analyst mean target, composite fair value, both upside percentages, market cap and how old the data and the verdict are. Sorted by score descending by default; search, a watchlist-only filter, five other orderings and the ⚙ share one header row — the table's own, so the window spends no line on chrome that only navigates.

**Analyse** — the same list collapsed to a rail, with one stock open beside it. A row click opens it; clicking that same row again closes it, as does the **✕** at the top right of the analysis, or `Esc`.

The list does not move when any of that happens. The two densities share the row markup for every column both of them show (`StockRowCells.tsx`) and declare one row height between them, so a row is the same two lines at the same size on either side of the click. The scroll position travels as *which stock was at the top of the box, and how far down it sat* — the one thing a table and a rail can both honour, since pixels do not survive a trip between two different elements. The rail carries the same sticky column-label row as the table for the same reason: without it the two scroll boxes start their content at different places, and the list at the very top cannot be reproduced at all.

Measured across the list, the stock you clicked lands on the pixel it was on, going in and coming back. Where the browser supports view transitions the columns fade rather than vanish between frames.

- **Left rail**: the ranked list minus the columns 320px has no room for — name, ticker, score and a 3-segment buy/hold/sell consensus stripe (AI verdicts + analyst counts, AI weighted 0.6). It carries the search box and nothing else, with the count tucked inside the field: sorting and the watchlist filter belong to the table, and every row of header here is both a stock the rail cannot show and a row of drift in the transition. Both densities drive the same filter state, so neither can disagree with the other about what it is looking at.
- **Center pane**: full analysis — AI verdict card, composite fair value (primary + conservative tiers), bull/bear/risks, valuation models, peer comparison, fundamentals history, technical signals gauge (TradingView-style), price action, ownership flow, news & research.
- **Analyse dialog** (the combination named on the verdict card, or „Andere Einstellungen…" in the refresh menu): every flag combo is its own cached entry, so the dialog lists what is stored — one click shows that one, and costs nothing — and underneath it holds the model, web-search and Perplexity pickers with the button that spends money. Outdated entries stay selectable and carry a ⚠.

  It used to be a permanent third column, which gave a panel you touch a few times a day the same standing as the analysis itself and a fifth of the window to say it. Both of its jobs are moments rather than states, and a run that costs an API call is better confirmed in a dialog than fired by a stray click on a sidebar button.
- **↻ Refresh** (header) is a menu, because pressing it can mean three things that cost different amounts. **Nur Daten** re-fetches the data layer (Yahoo + Finnhub + FRED + technicals + Distill) without a single LLM call. **Alles** does that, waits for it, and then re-runs the analysis with the combination on show — in that order because a run only fetches financials when they have *expired*, so re-running on its own can score a company on numbers that are hours old. **Andere Einstellungen…** opens the dialog.

  When something is out of date the button carries a yellow **!**; its tooltip says what, and the menu marks the entry that fixes it. That replaced a yellow banner across the page, which only appeared after a first refresh and put its own two buttons next to this one — so a full run used to take three places and the right order.

Adding a stock (`+ Hinzufügen` at the bottom of the window, under either density) resolves the ticker or company name and fetches the data layer — **no LLM call**. The verdict is a separate, explicit run from the Analyse dialog, so looking a company up never costs an API bill.

**⚙ Administration** — schedule, pipeline steps, watchlist and run log; closed by the same ✕, in the same corner. See [Nightly pipeline](#nightly-pipeline) below.

**URLs**: `#/stock/AAPL`, `#/overview`, `#/admin` — reload and browser back/forward work everywhere. No hash is the list. Old `#AAPL` links still resolve to a stock.

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
| 1 | **2-Stage DCF (FCFF)** | FCFF (FCF + after-tax interest where interest sits in operating cash flow) → stage-1 growth (analyst-forward, capped) → linear fade → terminal growth capped at the risk-free rate, paying for itself: TV = NOPAT × (1 − g ÷ ROIC) / (WACC − g), terminal ROIC = own ROIC capped at the peer median, never below WACC. WACC from live β, Damodaran's implied ERP, the local-currency risk-free rate and a cost of debt from the synthetic rating (interest coverage → live ICE BofA spread). Equity bridge (− debt + cash). Not applied to banks, insurers and brokers. |
| 2 | **Reverse DCF + Reverse SVR** | Binary search for FCF growth implied by the current price, on the forward DCF's own WACC, FCFF and terminal value. Reverse SVR inverts the same path on revenue instead: the steady margin at which today's EV is fair (free cash flow through the forecast, and in steady state also funding the reinvestment growth needs), on run-rate revenue growing at consensus (else latest-quarter YoY, else TTM) growth, and judged as a multiple of today's after-tax operating margin rather than against fixed bands. Works for pre-profit firms, where the FCF solve has no answer. |
| 3 | **Graham Number** | `√(22.5 × EPS × Book Value)` |
| 4 | **Graham Revised (V\*)** | `EPS × (8.5 + 2g) × 4.4 / AAA_yield` — live FRED rate |
| 5 | **Peter Lynch** | `EPS × growth_rate_pct`, prefers analyst-forward growth |
| 6 | **EPV (Greenwald)** | Normalised EBIT × (1 − tax) / WACC + cash − debt; not applied to banks, insurers and brokers |
| 7 | **DDM** | Gordon Growth with CAPM required return; perpetual dividend growth capped at the risk-free rate |
| 8 | **RIM (Residual Income / EBO)** | Book value + Σ excess returns over cost of equity |
| 9 | **NCAV (Graham Net-Net)** | Current assets − total liabilities, ⅔ × NCAV buy threshold |
| 10 | **Peer Multiples** | P/E, EV/EBITDA, EV/Revenue, P/FCF, P/B, P/S vs Finnhub sector medians — implied fair price per multiple; the median gives each fundamental one vote, so EV/Revenue and P/S share revenue's |
| 11 | **Composite Fair Value** | Median + IQR over all *applicable* models, split into Primary (market-aligned) and Conservative (value-investor) tiers. Sanity-bounded 0.02× – 30× of price. |
| 12 | **EV Multiples** | EV/EBITDA, EV/Revenue, EV/FCF, P/FCF, P/S TTM, forward P/S |
| 13 | **Simple Valuation Ratio (P/S Run-Rate)** | `marketCap / (latest_quarter_revenue × 4)` — reacts to growth inflections faster than TTM P/S. A seasonally adjusted twin (last four quarters grown at the latest quarter's YoY rate) flags quarters that are seasonal highs or lows. Benchmarked against a peer run-rate P/S: each peer's P/S TTM converted with its latest-quarter growth |
| 14 | **Rule of 40** | Revenue growth % + operating margin % |
| 15 | **Piotroski F-Score** | 9-signal fundamental quality screen (F1–F9); F7 compares weighted-average share counts year over year |
| 16 | **Altman Z-Score** | Original (manufacturing) or Modified Z′ (services/tech) |
| 17 | **Interest Coverage** | EBIT / interest expense |
| 18 | **Sortino Ratio** | Risk-adjusted return using downside deviation, live risk-free rate |
| 19 | **Beneish M-Score** | 8-variable earnings-manipulation detector, gated on min variable coverage |

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
| **Bewertung** | 30 % | Margin of safety against our own models only (see below), share of them showing undervaluation, the conservative tier as a value lens, own multiples against the peer medians, and what the price requires (below) |
| **Qualität** | 20 % | Piotroski (abstains below 5 computable signals), ROIC minus the DCF's own WACC, operating margin vs peers, revenue growth vs peers, Rule of 40 |
| **Bilanz & Risiko** | 15 % | Altman Z against its own model's thresholds, interest coverage, net debt / EBITDA, current ratio (without prepaid revenue where it is material), Beneish |
| **Analystenkonsens** | 15 % | Weighted rating (Strong Buy +2 … Strong Sell −2), mean-target upside |
| **Markt & Momentum** | 10 % | The TradingView-style signals verdict, relative strength vs SPY and sector, 52-week position |
| **Erwartungen** | 10 % | 30-day EPS estimate drift, net revisions, surprise history, month-over-month rating change |

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

### What the price requires

Four of the five valuation criteria ask *what is it worth* from our own
assumptions. The fifth (`market-implied`, 20 % of the pillar) inverts the
question the way a growth investor would: take the consensus revenue path as
given and solve for the steady margin at which today's enterprise value is fair
— the reverse SVR — then hold that against the best margin the business has
**already shown**: after-tax operating margin or free-cash-flow margin, whichever
is higher, or the peer median after tax when there are at least five peers.

The reading is log-symmetric around 1: priced for exactly the achievable margin
reads 5, twice it reads 0, half of it reads 10. Measured over the watchlist:
GOOGL requires 12 % against 30 % shown (10/10), NVIDIA 31 % against 48 %, Tesla
82 % against 5 % (0/10). Rank correlation with the other four criteria 0.54 —
related, as it should be, but mostly information they did not carry.

Two choices worth knowing:

- **Margin, not the reverse DCF's implied growth.** The reverse DCF solves for
  *free-cash-flow* growth, and the only forward number to hold that against is
  *revenue* growth; the two agree only while margins are stable. Intel
  "required 64 % growth against 13 % consensus" because its free cash flow was
  depressed, not because its price was absurd. Solving for the margin on the
  consensus revenue path compares like with like.
- **The best shown margin, not the operating one.** Operating margin alone
  punished the very firms the lens is for: UiPath earns 3 % GAAP and 31 % free
  cash flow, and the requirement is itself a free-cash-flow margin. Peer medians
  only from five peers up — thin groups produced medians from −53 % to 1.5 % for
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
conviction = 1 + 0.6 × agreement        # 1 when fewer than three pillars scored
```

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
| ≥ 4.5 | HOLD | amber |
| ≥ 3.0 | SELL | red |
| < 3.0 | STRONG SELL | red |

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
a supported Beneish flag or an Altman distress zone also forbids BUY. A cap never
upgrades a bearish verdict — a distressed balance sheet is no reason to lift a
SELL.

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

**An uncorroborated model that lands far from the price is not a valuation.**
With two or three models a wild one is medianed down by its neighbours; with one
there is nothing to correct it, and the valuation ramp tops out at +60 % margin
of safety — so a model claiming a stock is worth five times its price scored
exactly what a solidly cheap one does. Rubrik's lone DCF put fair value at
$522.81 against $102.23 and took the top of the ranking with it; Fresenius
Medical's lone Peter Lynch said $101.04 against $23.84. A single model is
weighed between 0.4× and 2.5× of the price and abstains outside that, which
costs coverage and therefore confidence — Rubrik went from a 10/10 valuation to
no valuation at all, which is the honest reading.

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
   It returns a 0–10 read of the business trajectory, or `null` as an honest
   abstention. It is run **three times** in parallel over the identical prompt
   and the **median** is kept, together with the summary of the read that
   produced it, so text and number agree (`combineNarrativeReads`).
3. **Synthese** (the configured analysis model) gets the two short summaries and
   the pillar table, and writes thesis, bull, bear and risks. It does not set the
   score. It may move the blended one by up to ±1 point, with a reason on the
   record, and only for something the pillars provably cannot see — an announced
   takeover, a regulatory decision, a recall.

Each stage degrades on its own: a failed data summary means the synthesis reads
the pillar table directly, a failed narrative means the headline is the factor
score alone, and a failed synthesis produces a verdict assembled from the
findings and marked as written without a model. That last path is not
theoretical — it fired on the first live run, and the verdict it produced was
the right score with honest prose and a label saying no model wrote it.

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
| `events` | dated developments that move the outlook; always the latest earnings call — did guidance go up, down or hold, and what did management avoid? Product launches, partnership releases and routine insider sales excluded |
| `bear_evidence` | the strongest *specific* evidence against the bull case — short reports, accounting concerns, guidance cuts, churn, share loss, documented structural threats. Evidence only, never "risks could include" |
| `bull_claims` | what bulls say drives the stock, each graded `independent`, `management-only` or `contradicted` |

Every item carries a date, a source and an independent-or-company label. On the
same stock it produced: a guide raised by $15M on a 150bp beat, federal revenue
pulled forward from Q3, a margin beat from deferred marketing spend, AI usage
acknowledged as a gross-margin headwind — and two popular bull claims marked
contradicted. Four of five claims in circulation rested on management's word
alone, which is itself the finding. The narrative score fell to 5.0: once the
prose was asked for contrary evidence, it stopped propping the price up.

Mechanics that keep it honest:

- **High search context.** At `low` the same brief found four insider filings and
  nothing else. About five cents a call.
- **Capped at 6 / 6 / 5 items, two sentences each.** Uncapped, the first live run
  ran to 14k characters and was cut off at `max_tokens` mid-sentence.
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

### The blend

```
factorWeight    = factor confidence
narrativeWeight = narrative confidence × 0.45
blend           = weighted mean of the two scores
score           = clamp(blend + adjustment)
```

Both weights are confidences, so neither side argues its own case: a flagged
payload hands weight to the prose automatically, a thin or stale dossier hands it
back. Narrative confidence is computed from the material — which sources arrived
and how old the newest is — never self-reported by the model. At equal confidence
the split lands near 69/31 in favour of the arithmetic.

The factor side is weighted by agreement as well as confidence, because those
come apart. Apple's data is impeccable (confidence 0.86) and its pillars cancel
(agreement 0.04), so its 4.9 is a standoff rather than a verdict — and weighted
by confidence alone that non-statement outvoted the prose three to one. A factor
half whose lenses cancel keeps `FACTOR_WEIGHT_FLOOR` (half) of its weight, and
the qualitative read gets the room, which is precisely where a qualitative read
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

On every trading day it ranks the stocks by the score they carried *into* that
day and by the return over the S&P 500 they made over the next *h* sessions, and
reports the Spearman correlation of the two rankings (the **rank IC**) — for the
headline, the factor half, the raw factor score before shrink and conviction,
every pillar, and the old single-call LLM score as the baseline the whole
pipeline has to beat. A cross-section cancels the market: a day on which
everything fell still says whether the high scores fell less. Alongside it: the
share of days with a positive IC, the top-third-minus-bottom-third return
spread, and the mean excess return per verdict label.

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
- **Power.** With ~37 stocks one day's IC has a standard error near ±0.17. A
  useful factor sits around 0.03–0.08. Telling that apart from zero takes many
  independent windows — months at a 20-session horizon, not weeks. Until then
  the output is a description of what happened, not evidence about the model.
- **Hindsight in the model, not the data.** `rescore` rewrites history with
  today's rules, so the backfilled series is what the current model *would* have
  said. The inputs are point in time; the rules were not tuned on returns, but
  the moment they are, this stops being an out-of-sample test.

Nothing is stored: the score series accumulates with every nightly refresh and
prices are fetched fresh from Yahoo, so each run is a recomputation that knows a
little more than the last. The pillar weights (`PILLAR_WEIGHTS`) are set by
judgment today; this is what will eventually be allowed to argue with them.

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
| Perplexity Sonar | Optional forensic brief — dated events, contrary evidence, bull claims graded against the evidence; goes to the narrative stage, which never sees the valuation |
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
│   ├── rescore.ts         Re-scores stored history with today's scoring model
│   └── evaluate.ts        CLI for the outcome evaluation (`pnpm run evaluate`)
├── files.ts               The two things that stay files (filings, reports)
├── sector-medians.ts      Peer-group medians (the app's most expensive read)
├── app-config.ts          Operational settings edited from the admin page
├── scheduler.ts           Nightly pipeline — one cron, one queue, one symbol at a time
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
│   ├── fred.ts            FRED rates (live 10Y, AAA, …)
│   ├── macro.ts           SPY + sector-ETF bundles, yield curve, VIX
│   ├── perplexity.ts      Sonar-Pro forensic brief → structured findings
│   ├── distill.ts         Distill briefing service — briefings for a resolved entity
│   ├── distill-entities.ts Distill entity registry — identifier → entity UUID
│   ├── distill-dossier.ts Distill dossier switch — GET/PUT /entities/{id}/dossier
│   ├── distill-errors.ts  Typed Distill failures (shared by all three clients)
│   └── edgar.ts           SEC EDGAR filings
├── analysis/
│   ├── metrics.ts         19 valuation models
│   ├── computeMetrics.ts  Orchestrates the bundle of models for the web GET
│   ├── score.ts           The deterministic score: six pillars, caps, the blend
│   ├── evaluate.ts        Rank IC of every score signal against the returns that followed
│   ├── data-quality.ts    Cross-field contradiction audit — feeds the caps
│   ├── run-rate.ts        TTM ↔ run-rate factor shared by SVR, peer medians and the UI
│   ├── signals.ts         TradingView-style buy/sell signal aggregation
│   └── technical.ts       SMA/EMA/RSI/MACD/Bollinger/Stoch/CCI via `trading-signals`
├── output/
│   ├── prompt.ts          The three stage prompts: data, narrative, synthesis
│   ├── score-card.ts      Renders a factor score for a prompt or the UI
│   ├── markdown.ts        Terminal + report markdown
│   └── report.ts          PDF/HTML report (Puppeteer)
└── utils/logger.ts        Chalk-based structured logging

web/
├── index.html
├── vite.config.ts
├── tailwind.config.js     Maps Tailwind colour tokens → CSS vars in styles.css
├── src/
│   ├── App.tsx            Routing (hash), state, SSE wiring
│   ├── pages/             Administration
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
│       ├── AnalysisModal.tsx      Stored analyses + model/search/pplx, as a dialog
│       ├── AnalysisView.tsx       Centre detail; renders all sections
│       ├── VerdictHero.tsx        Verdict + composite + analyst hero cards
│       ├── ScoreSplit.tsx         The two halves behind one headline, per list row
│       ├── BullBearRisks.tsx      3-column bull/bear/risks block
│       ├── ConsensusBar.tsx       3px buy/hold/sell stripe per rail item
│       ├── StockHeader.tsx        Logo, price, refresh — and the ✕ / ⚙ chrome
│       ├── StockLogo.tsx          Multi-source logo cascade (Logo.dev → Brandfetch → …)
│       ├── ProgressBanner.tsx     SSE progress events while a run is in flight
│       ├── AnalyzeForm.tsx        Bottom "analyze a new symbol" input
│       ├── icons.tsx              Gear, close and sliders as SVG
│       ├── Section.tsx            Collapsible section with localStorage state
│       ├── charts/                ECharts wrappers (Composite, FundamentalsHistory, …)
│       └── sections/              ValuationDetail, QualityScores, FundamentalsGrid,
│                                  PeerCompare, TechnicalSignalsPanel, PriceAction,
│                                  MarketContext, OwnershipFlow, EarningsBlock,
│                                  NewsAndResearch, CompanyInfo, ScoreBreakdown
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

The web UI never silently invalidates an analysis — outdated entries stay selectable but show a ⚠ marker, and the refresh button carries a **!** that points at the menu entry which brings it up to date.

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
