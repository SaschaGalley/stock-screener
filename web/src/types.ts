/**
 * The frontend's type surface — a facade, not a copy.
 *
 * These used to be ~30 hand-written mirrors of server types. Mirrors don't fail
 * loudly: they drift, and the drift surfaces as a field that is quietly always
 * `undefined` in the browser. So everything the server owns is re-exported from
 * where the server defines it, exactly as `src/models.ts` is already imported
 * across the package boundary.
 *
 * All of it is `export type`, which TypeScript erases at build time — zod and
 * the Node-side modules behind these types never reach the bundle (verified:
 * zero zod references in the built output). Keep it that way: a *value* import
 * from `../../src/…` here would pull the server's dependencies into the app.
 *
 * Only genuinely frontend-owned concepts are defined below.
 */

// ── Wire shapes (src/api-types.ts) ───────────────────────────────────────────
export type {
  ConsensusBand,
  StockSummary,
  CacheFreshness,
  CacheStatus,
  StockBundle,
  OverviewRow,
  AnalysisListEntry,
  ConfigResponse,
  ConfigSaveResponse,
  AddStockResponse,
  DistillRefreshResponse,
  DistillEntityCandidate,
  DistillEntityUnresolvedResponse,
} from '../../src/api-types';

// ── Domain types, from the modules that model them ───────────────────────────
export type {
  AnalysisResult,
  TechnicalSignals,
  SignalDirection,
  SignalItem,
  SignalGroup,
  DCFResult,
  CompositeTier,
  CompositeFairValueResult as CompositeFairValue,
  PeerMultiplesEntry,
  SearchTrace,
  SearchProviderTrace,
  SearchResult as SearchResultRecord,
  LLMAnalysis,
  StockFinancials,
  MarketSignals,
  NewsItem,
} from '../../src/types';

export type { ComputedMetrics } from '../../src/analysis/computeMetrics';

export type {
  AnalysisFlagsKey,
  AnalysisManifestEntry,
  CachedAnalysisEntry,
} from '../../src/cache';

export type { HistoryPoint, HistorySource } from '../../src/history';

export type {
  DistillBriefing,
  DistillBundle,
  DistillCacheState,
} from '../../src/data/distill';

export type { DistillEntityRef, DistillMatchTier } from '../../src/data/distill-entities';

export type { AppConfig, DistillMode } from '../../src/app-config';

export type {
  JobStep,
  StepStatus,
  JobStepResult,
  JobSymbolResult,
  JobRun,
  JobRunStatus,
  SchedulerStatus,
} from '../../src/scheduler';

export type { ProgressEvent, AnalysisRunMeta } from '../../src/cli';

// ── Frontend-only ────────────────────────────────────────────────────────────

/** Search providers offered by the settings sidebar. */
export type SearchChoice = 'brave' | 'tavily' | 'claude' | 'openai';
export type PplxChoice = null | 'sonar' | 'sonar-pro';

/** The right sidebar's current selection — a UI concept, not a server one. */
export interface Settings {
  /** A model ID from `src/models.ts`, or a custom one typed by the user. */
  model: string;
  /** Multi-select. Empty array = no search. */
  searches: SearchChoice[];
  pplx: PplxChoice;
}

/** Stable joined form for cache lookup ('brave,tavily' or 'none'). */
export function searchesKey(searches: SearchChoice[]): string {
  return searches.length === 0 ? 'none' : [...searches].sort().join(',');
}
