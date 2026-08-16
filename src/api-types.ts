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

import type { StockFinancials, MarketSignals, NewsItem, SectorMedians, TechnicalSignals } from './types.js';
import type { AnalysisManifestEntry } from './db/store.js';
import type { ComputedMetrics } from './analysis/computeMetrics.js';
import type { PerplexityContext } from './data/perplexity.js';
import type { DistillBundle, DistillCacheState } from './data/distill.js';
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
  /** Newest LLM verdict across all flag combinations. */
  aiScore:        number | null;
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
  /** Verdict-score series for the sparkline, oldest first. */
  scoreHistory:  { at: string; score: number }[];
  /** Score change from the first recorded verdict to the newest. */
  scoreDelta:    number | null;
  analysisCount: number;
  dataAgeHours:  number | null;
  watched:       boolean;
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

/** `POST /api/stocks/:symbol/distill-refresh` */
export interface DistillRefreshResponse {
  ok:             boolean;
  symbol:         string;
  cacheState:     DistillCacheState;
  distillCostUsd: number;
  bundle:         DistillBundle;
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
