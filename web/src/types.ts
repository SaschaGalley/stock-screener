export interface ConsensusBand {
  buy:  number;
  hold: number;
  sell: number;
  sources: number;
}

// Mirrors the server-side StockSummary returned by /api/stocks
export interface StockSummary {
  symbol: string;
  companyName: string;
  sector: string | null;
  industry: string | null;
  price: number | null;
  marketCap: number | null;
  website: string | null;
  logoDomain: string | null;
  cachedAt: string;
  analysisCount: number;
  consensus: ConsensusBand | null;
}

export type CacheFreshness = 'fresh' | 'stale' | 'missing' | 'older-than-data';

export interface CacheStatus {
  financials:    CacheFreshness;
  marketSignals: CacheFreshness;
  analysis:      CacheFreshness;
}

export interface AnalysisFlagsKey {
  model: string;
  search: string;
  pplx: 'sonar' | 'sonar-pro' | null;
}

export interface AnalysisManifestEntry {
  hash: string;
  flags: AnalysisFlagsKey;
  generatedAt: string;
  ageMinutes: number;
  /** True when this analysis was generated before the most recent data refresh —
   *  user can still select it but the detail view's StaleBanner will warn. */
  olderThanData?: boolean;
}

export interface SearchResultRecord {
  title:   string;
  url:     string;
  content: string;
  score?:  number;
}

export interface SearchProviderTrace {
  provider:  'tavily' | 'brave' | 'claude-web-search' | 'openai-web-search';
  queries:   string[];
  results:   SearchResultRecord[];   // empty for native providers (LLM-side fetch)
  fetchedAt: string;
}

export interface SearchTrace {
  providers: SearchProviderTrace[];
}

export interface CachedAnalysisEntry {
  flags: AnalysisFlagsKey;
  hash: string;
  generatedAt: string;
  llmAnalysis: {
    bullCase: string[];
    bearCase: string[];
    keyRisks: string[];
    thesis: string;
    score: number;
    recommendation: 'STRONG BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG SELL';
    fairValueEstimate: string;
  };
  searches?: SearchTrace;
}

export interface CompositeTier {
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  marginOfSafety: number | null;
  models: { name: string; fairValue: number }[];
}

export interface CompositeFairValue {
  // New tiered shape
  primary: CompositeTier;
  conservative: CompositeTier;
  excludedModels: { name: string; reason: string }[];
  confidence: number;
  pctPrimaryUndervalued: number | null;

  // Backwards-compat aliases — same as primary.*
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  marginOfSafety: number | null;
  pctModelsUndervalued: number | null;
  contributingModels: { name: string; fairValue: number }[];
}

export interface DCFResult {
  fairValue: number | null;
  fairValueBear: number | null;
  fairValueBull: number | null;
  discountRate: number;
  beta: number | null;
  riskFreeRate: number;
  stage1Growth: number;
  terminalGrowthRate: number;
  stage1Years: number;
  fadeYears: number;
  projectedFCFs: number[];
  terminalValue: number | null;
  enterpriseValue: number | null;
  netDebt: number | null;
  assumptions: string;
}

export interface PeerMultiplesEntry {
  metric: 'pe' | 'evEbitda' | 'evRevenue' | 'priceFCF' | 'priceSales' | 'pb';
  ownMetric: number | null;
  sectorMedian: number | null;
  fairPrice: number | null;
}

// Loose typing for the full AnalysisResult — we don't redeclare every nested
// field in the frontend; just enough for the components to type-check.
export interface AnalysisResult {
  symbol: string;
  timestamp: string;
  provider: string;
  searchProvider: string;
  financials: any;
  dcf: DCFResult;
  composite: CompositeFairValue;
  peerMultiples: { byMultiple: PeerMultiplesEntry[]; medianFairPrice: number | null; meanFairPrice: number | null; count: number; marginOfSafety: number | null };
  llmAnalysis: CachedAnalysisEntry['llmAnalysis'];
  [key: string]: any;
}

export interface ComputedMetrics {
  dcf: DCFResult;
  composite: CompositeFairValue;
  peerMultiples: {
    byMultiple: PeerMultiplesEntry[];
    medianFairPrice: number | null;
    meanFairPrice: number | null;
    count: number;
    marginOfSafety: number | null;
  };
  ratios: any;
  reverseDCF: any;
  peterLynch: any;
  evMultiples: any;
  ruleOf40: any;
  grahamRevised: any;
  grahamNumber: any;
  piotroski: any;
  altmanZ: any;
  ddm: any;
  epv: any;
  rim: any;
  ncav: any;
  interestCoverage: any;
  sortino: any;
  beneish: any;
}

export type SignalDirection = 'buy' | 'sell' | 'neutral';

export interface SignalItem {
  name: string;
  value: number | null;
  signal: SignalDirection;
  hint: string;
}

export interface SignalGroup {
  items: SignalItem[];
  buy: number;
  sell: number;
  neutral: number;
  /** −1 (Strong Sell) to +1 (Strong Buy) */
  score: number;
  verdict: 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL';
}

export interface TechnicalSignals {
  movingAverages: SignalGroup;
  oscillators:    SignalGroup;
  overall:        SignalGroup;
}

export interface DistillBriefing {
  id:               string;
  briefingTypeId:   string;
  briefingTypeName: string;
  title:            string;
  body:             string;
  format:           'plain' | 'markdown';
  language:         string;
  entityRefs:       string[];
  insightCount:     number;
  model:            string;
  costUsd:          number | null;
  createdAt:        string;
}

export type DistillCacheState = 'still-current' | 'generated' | 'empty-pool' | 'unknown';

export interface DistillBundle {
  ticker:    string;
  baseUrl:   string;
  briefing:  DistillBriefing | null;
  fetchedAt: string;
  lastRefresh?: {
    cacheState:     DistillCacheState;
    distillCostUsd: number;
    refreshedAt:    string;
  };
}

export interface DistillRefreshResponse {
  ok:              boolean;
  symbol:          string;
  cacheState:      DistillCacheState;
  distillCostUsd:  number;
  bundle:          DistillBundle;
}

export interface StockBundle {
  summary: StockSummary;
  financials: any;
  marketSignals: any;
  news: any[];
  perplexity: any;
  distill: DistillBundle | null;
  metrics: ComputedMetrics;
  sectorMedians: any;
  marketRates: any;
  technicalSignals: TechnicalSignals | null;
  cacheStatus: CacheStatus;
}

export interface ProgressEvent {
  stage: string;
  message: string;
  cached?: boolean;
  data?: Record<string, unknown>;
}

export interface AnalysisRunMeta {
  symbol: string;
  modelId: string;
  searchUsed: string;
  pplxUsed: 'sonar' | 'sonar-pro' | null;
  fromCache: boolean;
  flagsHash: string;
}

// Selectable settings on the right sidebar
export type ModelChoice = 'claude' | 'haiku' | 'opus' | 'openai' | 'gemini';
export type SearchChoice = 'brave' | 'tavily' | 'claude' | 'openai';
export type PplxChoice = null | 'sonar' | 'sonar-pro';

export interface Settings {
  model: ModelChoice | string;
  /** Multi-select. Empty array = no search. */
  searches: SearchChoice[];
  pplx: PplxChoice;
}

/** Stable joined form for cache lookup ('brave,tavily' or 'none'). */
export function searchesKey(searches: SearchChoice[]): string {
  return searches.length === 0 ? 'none' : [...searches].sort().join(',');
}
