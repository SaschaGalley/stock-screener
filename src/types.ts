export interface StockFinancials {
  symbol: string;
  companyName: string;
  price: number;
  marketCap: number;

  // Valuation
  peRatio: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  eps: number | null;
  bookValue: number | null;

  // Profitability
  roe: number | null;
  roa: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  revenueGrowth: number | null;
  revenueGrowthYoY: number | null;
  earningsGrowth: number | null;

  // Cash & Liquidity
  freeCashFlow: number | null;
  operatingCashFlow: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  longTermDebt: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  quickRatio: number | null;

  // Income Statement (annual, latest)
  revenue: number | null;
  grossProfit: number | null;
  ebit: number | null;
  netIncome: number | null;
  ebitda: number | null;
  interestExpense: number | null;
  incomeTaxExpense: number | null;
  incomeBeforeTax: number | null;
  taxRate: number | null;

  // Balance Sheet (annual, latest)
  totalAssets: number | null;
  totalCurrentAssets: number | null;
  totalCurrentLiabilities: number | null;
  totalLiabilities: number | null;
  retainedEarnings: number | null;
  workingCapital: number | null;

  // Cash Flow (annual, latest)
  operatingCashFlowAnnual: number | null;
  capex: number | null;
  depreciation: number | null;

  // EV & Multiples
  enterpriseValue: number | null;
  sharesOutstanding: number | null;
  targetMeanPrice: number | null;

  // Market Data
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  beta: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;

  // Classification
  sector: string | null;
  industry: string | null;

  // Finnhub-enriched metrics
  roic: number | null;               // Return on invested capital (TTM)
  epsGrowth3Y: number | null;        // 3-year EPS CAGR
  dividendGrowthRate5Y: number | null; // 5-year dividend growth rate

  // Extra balance-sheet fields (for Beneish M-Score)
  receivables: number | null;
  ppe: number | null;
  sga: number | null;

  // Monthly returns for Sortino Ratio (12 data points, most recent year)
  monthlyReturns: number[];

  // Prior-year snapshots for Piotroski / Beneish
  prevYear: PrevYearSnapshot | null;
}

export interface PrevYearSnapshot {
  netIncome: number | null;
  totalAssets: number | null;
  longTermDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  grossProfit: number | null;
  revenue: number | null;
  operatingCashFlow: number | null;
  // Beneish extras
  receivables: number | null;
  ppe: number | null;
  sga: number | null;
  depreciation: number | null;
}

// ─── Result Types ────────────────────────────────────────────────────────────

export interface DCFResult {
  fairValue: number;
  fairValueLow: number;
  fairValueHigh: number;
  wacc: number;
  terminalGrowthRate: number;
  projectionYears: number;
  projectedFCFs: number[];
  assumptions: string;
}

export interface GrahamResult {
  grahamNumber: number | null;
  marginOfSafety: number | null;
  isUndervalued: boolean;
}

export interface RatioResult {
  pe: number | null;
  forwardPE: number | null;
  peg: number | null;
  pb: number | null;
  roe: number | null;
  roa: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  revenueGrowth: number | null;
  dividendYield: number | null;
}

export interface ReverseDCFResult {
  impliedGrowthRate: number | null;
  wacc: number;
  terminalGrowthRate: number;
  years: number;
  interpretation: string;
  isPossible: boolean;
}

export interface PeterLynchResult {
  fairValue: number | null;
  fairValueWithDividend: number | null;
  growthRate: number | null;
  isUndervalued: boolean | null;
  marginOfSafety: number | null;
}

export interface EVMultiplesResult {
  enterpriseValue: number | null;
  evToEbitda: number | null;
  evToRevenue: number | null;
  evToFCF: number | null;
  priceToFCF: number | null;
  priceToSales: number | null;
}

export interface RuleOf40Result {
  score: number | null;
  revenueGrowthPct: number | null;
  profitMarginPct: number | null;
  passes: boolean | null;
}

export interface GrahamRevisedResult {
  fairValue: number | null;
  bondYield: number;
  growthRate: number | null;
  marginOfSafety: number | null;
  isUndervalued: boolean | null;
}

export interface PiotroskiSignals {
  f1_positiveROA: boolean | null;
  f2_positiveCFO: boolean | null;
  f3_improvingROA: boolean | null;
  f4_accruals: boolean | null;
  f5_reducingLeverage: boolean | null;
  f6_improvingLiquidity: boolean | null;
  f7_noNewShares: boolean | null;
  f8_improvingGrossMargin: boolean | null;
  f9_improvingAssetTurnover: boolean | null;
}

export interface PiotroskiResult {
  score: number;
  maxScore: number;
  signals: PiotroskiSignals;
  interpretation: 'strong' | 'neutral' | 'weak';
}

export interface AltmanZResult {
  score: number | null;
  zone: 'safe' | 'grey' | 'distress' | 'unknown';
  x1: number | null;
  x2: number | null;
  x3: number | null;
  x4: number | null;
  x5: number | null;
  model: 'original' | 'modified';
  thresholds: { safe: number; distress: number };
}

export interface DDMResult {
  fairValue: number | null;
  dividendPerShare: number | null;
  dividendGrowthRate: number | null;
  requiredReturn: number | null;
  isApplicable: boolean;
}

export interface SortinoResult {
  ratio: number | null;
  annualReturn: number | null;
  downsideDeviation: number | null;
  riskFreeRate: number;
  interpretation: 'excellent' | 'good' | 'acceptable' | 'poor' | 'very poor' | 'unknown';
}

export interface BeneishResult {
  score: number | null;
  probability: 'likely manipulator' | 'grey zone' | 'unlikely manipulator' | 'unknown';
  dsri: number | null;
  gmi: number | null;
  aqi: number | null;
  sgi: number | null;
  depi: number | null;
  sgai: number | null;
  tata: number | null;
  lvgi: number | null;
  variablesComputed: number;
}

export interface EPVResult {
  fairValue: number | null;
  normalizedEbit: number | null;
  taxRate: number;
  wacc: number;
  marginOfSafety: number | null;
}

export interface InterestCoverageResult {
  ratio: number | null;
  interpretation: 'excellent' | 'good' | 'fair' | 'poor' | 'critical' | 'unknown';
}

export interface SectorMedians {
  // Valuation multiples
  pe: number | null;
  evToEbitda: number | null;
  evToRevenue: number | null;
  priceToFCF: number | null;
  pb: number | null;
  // Profitability
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roic: number | null;
  // Growth
  revenueGrowthYoY: number | null;
  peerCount: number;
  peers: string[];
}

// ─── Main Result ─────────────────────────────────────────────────────────────

export interface NewsItem {
  headline: string;
  source: string;
  url: string;
  datetime: number;
  summary: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface LLMAnalysis {
  bullCase: string;
  bearCase: string;
  keyRisks: string[];
  thesis: string;
  score: number;
  recommendation: 'STRONG BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG SELL';
  fairValueEstimate: string;
}

export interface AnalysisResult {
  symbol: string;
  timestamp: string;
  provider: string;
  searchProvider: string;
  financials: StockFinancials;
  // Basic calculators
  dcf: DCFResult;
  grahamNumber: GrahamResult;
  ratios: RatioResult;
  // Advanced calculators
  reverseDCF: ReverseDCFResult;
  peterLynch: PeterLynchResult;
  evMultiples: EVMultiplesResult;
  ruleOf40: RuleOf40Result;
  grahamRevised: GrahamRevisedResult;
  piotroski: PiotroskiResult;
  altmanZ: AltmanZResult;
  ddm: DDMResult;
  epv: EPVResult;
  interestCoverage: InterestCoverageResult;
  sortino: SortinoResult;
  beneish: BeneishResult;
  sectorMedians: SectorMedians | null;
  // LLM + news
  llmAnalysis: LLMAnalysis;
  news: NewsItem[];
}

export interface AnalysisOptions {
  model: 'anthropic' | 'openai' | 'gemini';
  search: 'claude-native' | 'tavily' | 'openai-tavily' | 'brave' | 'none';
  cache: boolean;
  output?: string;
  verbose: boolean;
}
