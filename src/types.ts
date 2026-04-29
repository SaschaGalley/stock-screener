export interface StockFinancials {
  symbol: string;
  price: number;
  marketCap: number;
  peRatio: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  eps: number | null;
  bookValue: number | null;
  roe: number | null;
  roa: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  revenueGrowth: number | null;
  revenueGrowthYoY: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  freeCashFlow: number | null;
  revenue: number | null;
  netIncome: number | null;
  ebitda: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  beta: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  sector: string | null;
  industry: string | null;
  companyName: string;
}

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
  dcf: DCFResult;
  grahamNumber: GrahamResult;
  ratios: RatioResult;
  llmAnalysis: LLMAnalysis;
  news: NewsItem[];
}

export interface AnalysisOptions {
  model: 'anthropic' | 'openai' | 'gemini';
  search: 'claude-native' | 'tavily' | 'openai-tavily' | 'none';
  cache: boolean;
  output?: string;
  verbose: boolean;
}
