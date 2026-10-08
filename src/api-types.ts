/**
 * The HTTP wire shapes — one definition per response, shared by the Express
 * routes that produce them and the web app that consumes them.
 *
 * Why this file exists: the frontend used to hand-mirror roughly thirty server
 * types in `web/src/types.ts`. Mirrors do not fail loudly; they drift, and the
 * drift shows up as a field that is quietly always `undefined` in the browser.
 * `src/models.ts` already proved the alternative — the web app imports directly
 * across the package boundary — and TypeScript's `import type` is erased at
 * build time, so nothing in here (or anything it references, zod included) ever
 * reaches the bundle.
 *
 * Rules for this module:
 *   - Response shapes only. Domain types stay where they are modelled
 *     (`types.ts`, `cache.ts`, `scheduler.ts`, …) and are re-exported from
 *     `web/src/types.ts` directly.
 *   - Type-only imports, so it stays free of runtime dependencies.
 */

import type { StockFinancials, MarketSignals, NewsItem, SectorMedians, TechnicalSignals, TimingReadings } from './types.js';
import type { AnalysisManifestEntry } from './db/store.js';
import type { ComputedMetrics } from './analysis/computeMetrics.js';
import type { PerplexityContext } from './data/perplexity.js';
import type { ResearchPasteSummary } from './research/kinds.js';
import type { DistillBundle } from './data/distill.js';
import type { DistillEntityHit } from './data/distill-entities.js';
import type { MarketRates } from './data/fred.js';
import type { AppConfig } from './app-config.js';
import type { SchedulerStatus } from './scheduler.js';
import type { DistillUnresolvedReason } from './data/distill-errors.js';

/**
 * Combined buy/hold/sell consensus shown as a thin band on the stock list.
 * Aggregates cached LLM verdicts (weight 0.6) with Yahoo's analyst counts
 * (0.4); a single available source carries full weight.
 */
export interface ConsensusBand {
  buy:  number;   // 0–1
  hold: number;   // 0–1
  sell: number;   // 0–1
  /** Number of vote sources that contributed (≥1 for the band to render). */
  sources: number;
}

/** One entry of `GET /api/stocks` — the sidebar's view of a stock. */
export interface StockSummary {
  symbol:        string;
  companyName:   string;
  sector:        string | null;
  industry:      string | null;
  price:         number | null;
  marketCap:     number | null;
  /** Trading currency of `price`/`marketCap` (ISO 4217), null when unknown. */
  currency:      string | null;
  website:       string | null;
  logoDomain:    string | null;       // domain for clearbit-style lookup
  cachedAt:      string;              // ISO timestamp of financials.json mtime
  analysisCount: number;              // how many cached LLM analyses exist
  consensus:     ConsensusBand | null;
}

export type CacheFreshness = 'fresh' | 'stale' | 'missing' | 'older-than-data';

export interface CacheStatus {
  financials:    CacheFreshness;
  marketSignals: CacheFreshness;
  /** `older-than-data` means the financials were refreshed after the analysis ran. */
  analysis:      CacheFreshness;
}

/** One entry of `GET /api/metrics` — the chart picker's data source. */
export interface MetricCatalogEntry {
  key:         string;
  domain:      string;
  label:       string;
  unit:        string | null;
  valueKind:   string;
  description: string | null;
}

/** One point of a recorded series. */
export interface SeriesPoint { at: string; value: number | null; text: string | null }

/** `GET /api/stocks/:symbol/series` — one entry per requested metric key. */
export interface MetricSeries {
  key:    string;
  label:  string;
  unit:   string | null;
  points: SeriesPoint[];
}

/** `GET /api/stocks/:symbol/documents/:kind` — a text output's change history. */
export interface DocumentVersion<D = unknown> {
  id:         number;
  kind:       string;
  variant:    string;
  producedAt: string;
  lastSeenAt: string;
  model:      string | null;
  content:    string;
  data:       D | null;
  costUsd:    number | null;
}

/** `GET /api/stocks/:symbol` — everything the detail view renders. */
export interface StockBundle {
  summary:          StockSummary | null;
  financials:       StockFinancials;
  marketSignals:    MarketSignals | null;
  news:             NewsItem[];
  perplexity:       PerplexityContext | null;
  /** The newest deep research report, bought by hand — whatever its age; the UI says it. */
  deepResearch:     PerplexityContext | null;
  distill:          DistillBundle | null;
  metrics:          ComputedMetrics;
  sectorMedians:    SectorMedians | null;
  marketRates:      MarketRates | null;
  technicalSignals: TechnicalSignals | null;
  cacheStatus:      CacheStatus;
}

/** One row of `GET /api/overview` — already ranked by verdict score. */
export interface OverviewRow {
  symbol:       string;
  companyName:  string;
  sector:       string | null;
  logoDomain:   string | null;
  price:        number | null;
  marketCap:    number | null;
  currency:     string | null;
  /** Trailing twelve months' dividends over the price (decimal); null for a stock that paid none. */
  dividendYield: number | null;
  /**
   * Headline score: the deterministic factor score blended with the prose-only
   * narrative score by their two confidences, plus the synthesis model's
   * bounded correction. Recomputed on every data refresh, so it moves with the
   * price rather than with whenever the analysis step last ran.
   */
  score:          number | null;
  /** The deterministic half alone — arithmetic over stored data, no model. */
  factorScore:    number | null;
  /** The prose-only half; null when no qualitative source was available. */
  narrativeScore: number | null;
  /** 0–1 behind the factor half: what drives both the blend and the caps. */
  scoreConfidence: number | null;
  /**
   * 0–1: how much the six pillars point the same way. Unanimity carries the
   * score away from neutral; a standoff keeps it there, and the difference
   * between a corroborated 6.2 and a contested one is the whole ranking.
   */
  scoreAgreement:  number | null;
  /**
   * True when a cap actually held the label below its own band — not merely
   * that some cap exists. A `no-strong` cap on a stock scoring 6.6 changes
   * nothing, and a marker that fired anyway said "capped" beside a BUY that was
   * never capped.
   */
  verdictCapped:  boolean;
  /** Why, in the words the cap itself gave. Empty when nothing was held back. */
  capReasons:     string[];
  recommendation: string | null;
  verdictAt:      string | null;
  verdictModel:   string | null;
  fairValueEstimate: string | null;
  /** Analyst consensus target and its distance from today's price. */
  targetMean:      number | null;
  targetUpsidePct: number | null;
  /** Composite (primary tier) fair value and its distance from today's price. */
  compositeFairValue: number | null;
  compositeUpsidePct: number | null;
  /** Headline-score series for the sparkline, oldest first. */
  scoreHistory:  { at: string; score: number }[];
  /** Score change from the first recorded point to the newest. */
  scoreDelta:    number | null;
  analysisCount: number;
  dataAgeHours:  number | null;
  watched:       boolean;
  /** Combined AI + analyst buy/hold/sell band, for the list's consensus stripe. */
  consensus:     ConsensusBand | null;
  /**
   * Where the price sits on its own recent path, from the newest refresh
   * (`analysis/timing.ts`). Null for a stock not refreshed since the readings
   * existed. Beside the verdict, never in it.
   */
  timing:        TimingReadings | null;
  /**
   * The factor score's place among every stored stock's newest one, the
   * reference universe included: the share scoring lower, ties counted half.
   * What tells a 6.3 HOLD from a 3.8 HOLD. Null without a factor score.
   */
  universeRank:  { percentile: number; of: number } | null;
}

/**
 * `GET /api/stocks/:symbol/analyses` — the manifest plus a staleness flag the
 * route computes by comparing each entry against the financials mtime.
 *
 * This flag is why the mirrors were dangerous: the route has always sent it and
 * the settings sidebar has always rendered it, but no server type named it, so
 * only the frontend's private copy knew it existed.
 */
export interface AnalysisListEntry extends AnalysisManifestEntry {
  /** Generated before the last data refresh → the UI offers a re-run. */
  olderThanData: boolean;
}

/** `GET /api/config` — settings plus the read-only facts needed to edit them. */
export interface ConfigResponse {
  config:  AppConfig;
  symbols: { symbol: string; watched: boolean; companyName: string }[];
  /** Presence only — key values never leave the server. */
  keys:    Record<string, boolean>;
  /** Where the file-shaped leftovers live (EDGAR filings, generated reports). */
  dataDir:       string;
  distillApiUrl: string;
  /** Reference symbols stored so far — the universe the score is calibrated and evaluated on. */
  referenceSymbols: number;
  /** Members of the indices as last fetched, former members in their grace period included; 0 before the first full run. */
  universeSize:     number;
  /** Of those, how many were refreshed within the last seven days. */
  universeFresh:    number;
  /** The committed calibration table, and whether it should be regenerated. */
  calibration: {
    generatedAt:       string | null;
    symbols:           number;
    observations:      number;
    /** By premium group, `currency|firm` or `currency|lender`, `*` for all (`premiumGroups`). */
    premiumAdjustments: Record<string, number>;
    /** Why a recalibration is due, or null. */
    due:               string | null;
  };
}

/** `GET /api/backtest` — the stored result of `pnpm run backtest`, null before the first run. */
export interface BacktestResponse {
  backtest: import('./backtest/result.js').BacktestResult | null;
  /** Titles of the evaluated signals, keyed as the result keys them. */
  signals:  { key: string; title: string; pillar: boolean }[];
  /** The weights scoring now, and the committed fit they came from — null while the judgment's are in force. */
  inForce:  {
    weights: import('./analysis/score.js').ScoreWeights;
    fit:     import('./analysis/score.js').WeightFitMeta | null;
  };
}

/** `GET /api/verdict-changes` */
export interface VerdictChangesResponse {
  changes: import('./db/store.js').VerdictChange[];
}

/** `PUT /api/config` */
export interface ConfigSaveResponse {
  ok:        boolean;
  config:    AppConfig;
  scheduler: SchedulerStatus;
}

/** `POST /api/stocks` — add without analysing. */
export interface AddStockResponse {
  ok:      boolean;
  symbol:  string;
  summary: StockSummary | null;
}

/** One company in `GET /api/stocks/:symbol/peers`. */
export interface PeerRow {
  symbol:      string;
  companyName: string | null;
  logoDomain:  string | null;
  price:       number | null;
  marketCap:   number | null;
  /** Trading currency of `price`/`marketCap`, per row — peers list anywhere. */
  currency:    string | null;
  /** The headline score and band the last refresh recorded; null when never scored. */
  score:       number | null;
  verdict:     string | null;
  /**
   * Where it stands here: on the list, scored in the reference universe only,
   * or never fetched. The last two can be added.
   */
  status:      'list' | 'reference' | 'unknown';
}

/** `GET /api/stocks/:symbol/peers` — read from the database, no LLM call. */
export interface PeersResponse {
  symbol:   string;
  /** Yahoo's industry for the stock, which `industryPeers` share. */
  industry: string | null;
  /** The stock itself, for comparison. */
  self:     PeerRow;
  /** Finnhub's peer group — the companies the peer medians are computed from. */
  peers:    PeerRow[];
  /** Other companies in the same industry, from the list and the reference universe. */
  industryPeers: PeerRow[];
}

/** `POST /api/stocks/:symbol/distill-refresh` — free; re-reads, buys nothing. */
export interface DistillRefreshResponse {
  ok:     boolean;
  symbol: string;
  /** One line: how many dossiers and insights came back. */
  detail: string;
  bundle: DistillBundle;
}

/** `GET /api/research/prompt` — the prompt to run in a chat app's research mode. */
export interface ResearchPromptResponse {
  prompt: string;
}

/** `POST /api/research/paste` — what a pasted answer was read as, and whether it was kept. */
export interface ResearchPasteResponse {
  saved:   boolean;
  summary: ResearchPasteSummary;
}

/** `POST /api/stocks/:symbol/perplexity-refresh` — one billed call, past the cache window. */
export interface PerplexityRefreshResponse {
  ok:         boolean;
  symbol:     string;
  perplexity: PerplexityContext;
}

/** Candidate carried by a 409 `distill_entity_unresolved`. */
export type DistillEntityCandidate = Pick<
  DistillEntityHit,
  'id' | 'ref' | 'displayName' | 'matchedOn' | 'matchedValue' | 'primarySymbol' | 'country' | 'isin'
>;

export interface DistillEntityUnresolvedResponse {
  error:        'distill_entity_unresolved';
  reason:       DistillUnresolvedReason;
  message:      string;
  entityStatus: string | null;
  candidates:   DistillEntityCandidate[];
}

/** GET /api/evaluation — how the stored scores ranked the returns that followed. */
export interface EvaluationResponse {
  computedAt: string;
  signals:    { key: string; title: string; pillar: boolean; factor: boolean }[];
  /** The watchlist, every signal. */
  evaluation: import('./analysis/evaluate.js').Evaluation;
  /** Watchlist and reference universe, the factor signals; null before there is a universe. */
  universe:   import('./analysis/evaluate.js').Evaluation | null;
  /** Pillar weights the evidence argues for — a suggestion, never applied. */
  weights:    (import('./analysis/evaluate.js').WeightSuggestion & { title: string })[];
  weightHorizon: number;
  /** The universe at month-ends, as the backtest reads it, with the expectations fixed before; null before there is a universe. */
  monthly:    import('./db/evaluate.js').MonthlyView | null;
}
