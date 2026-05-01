import { z } from 'zod';

// ─── Core Financial Data ──────────────────────────────────────────────────────

export const PrevYearSnapshotSchema = z.object({
  netIncome:          z.number().nullable().describe('Net income from the prior fiscal year (used to calculate ROA improvement for Piotroski F3)'),
  totalAssets:        z.number().nullable().describe('Total assets from the prior fiscal year (Piotroski F3 denominator, Beneish AQI)'),
  longTermDebt:       z.number().nullable().describe('Long-term debt from the prior fiscal year (Piotroski F5 leverage comparison)'),
  currentAssets:      z.number().nullable().describe('Current assets from the prior fiscal year (Piotroski F6 liquidity comparison)'),
  currentLiabilities: z.number().nullable().describe('Current liabilities from the prior fiscal year (Piotroski F6 liquidity comparison)'),
  grossProfit:        z.number().nullable().describe('Gross profit from the prior fiscal year (Piotroski F8 gross margin comparison, Beneish GMI)'),
  revenue:            z.number().nullable().describe('Revenue from the prior fiscal year (Piotroski F8/F9, Beneish SGI/SGAI)'),
  operatingCashFlow:  z.number().nullable().describe('Operating cash flow from the prior fiscal year (Piotroski F2/F4)'),
  receivables:        z.number().nullable().describe('Accounts receivable from the prior fiscal year (Beneish DSRI numerator)'),
  ppe:                z.number().nullable().describe('Net property, plant & equipment from the prior fiscal year (Beneish AQI/DEPI)'),
  sga:                z.number().nullable().describe('Selling, general & administrative expenses from the prior fiscal year (Beneish SGAI)'),
  depreciation:       z.number().nullable().describe('Depreciation & amortization from the prior fiscal year (Beneish DEPI)'),
});
export type PrevYearSnapshot = z.infer<typeof PrevYearSnapshotSchema>;

export const EarningsSurpriseSchema = z.object({
  quarter:     z.string().describe('Period label from Yahoo Finance (e.g. "3Q2024")'),
  epsEstimate: z.number().nullable().describe('Consensus analyst EPS estimate before the announcement'),
  epsActual:   z.number().nullable().describe('Actual reported EPS'),
  surprisePct: z.number().nullable().describe('Beat/miss as decimal (positive = beat, e.g. 0.079 = +7.9%)'),
});
export type EarningsSurprise = z.infer<typeof EarningsSurpriseSchema>;

export const StockFinancialsSchema = z.object({
  // ── Identity ────────────────────────────────────────────────────────────────
  symbol:      z.string().describe('Exchange ticker symbol as used by Yahoo Finance (e.g. AAPL, 0QW9.IL)'),
  companyName: z.string().describe('Full legal company name from Yahoo Finance price data'),
  price:       z.number().describe('Most recent regular market close price in USD (or local currency)'),
  marketCap:   z.number().describe('Total market capitalisation: shares outstanding × price'),

  // ── Valuation ───────────────────────────────────────────────────────────────
  peRatio:   z.number().nullable().describe('Trailing 12-month P/E ratio (price / EPS TTM)'),
  forwardPE: z.number().nullable().describe('Forward P/E ratio based on next-12-month consensus EPS estimate'),
  pegRatio:  z.number().nullable().describe('Price/Earnings-to-Growth ratio: P/E divided by expected earnings growth rate'),
  eps:       z.number().nullable().describe('Trailing 12-month earnings per share (diluted)'),
  bookValue: z.number().nullable().describe('Book value per share: (total equity) / shares outstanding'),

  // ── Profitability ───────────────────────────────────────────────────────────
  roe:              z.number().nullable().describe('Return on equity (decimal): net income / average shareholders equity TTM'),
  roa:              z.number().nullable().describe('Return on assets (decimal): net income / average total assets TTM'),
  operatingMargin:  z.number().nullable().describe('Operating income as a fraction of revenue TTM (decimal, e.g. 0.30 = 30%)'),
  netMargin:        z.number().nullable().describe('Net income as a fraction of revenue TTM (decimal)'),
  revenueGrowth:    z.number().nullable().describe('Year-over-year revenue growth rate TTM (decimal, from Yahoo financialData)'),
  revenueGrowthYoY: z.number().nullable().describe('Alias of revenueGrowth; provided for consistency with SectorMedians field naming'),
  earningsGrowth:   z.number().nullable().describe('Year-over-year earnings/net-income growth rate TTM (decimal); can be noisy for single-quarter spikes'),

  // ── Cash & Liquidity ────────────────────────────────────────────────────────
  freeCashFlow:      z.number().nullable().describe('Free cash flow TTM (operating CF − capex) in reporting currency'),
  operatingCashFlow: z.number().nullable().describe('Operating cash flow TTM from Yahoo financialData'),
  totalCash:         z.number().nullable().describe('Total cash, cash equivalents and short-term investments on the balance sheet'),
  totalDebt:         z.number().nullable().describe('Total interest-bearing debt (short-term + long-term)'),
  longTermDebt:      z.number().nullable().describe('Long-term debt only (excludes current portion), used in Piotroski F5 and Altman Z'),
  debtToEquity:      z.number().nullable().describe('Total debt divided by shareholders equity (ratio, not percentage)'),
  currentRatio:      z.number().nullable().describe('Current assets / current liabilities; liquidity indicator (Piotroski F6)'),
  quickRatio:        z.number().nullable().describe('(Current assets − inventory) / current liabilities; stricter liquidity measure'),

  // ── Income Statement (annual, latest) ───────────────────────────────────────
  revenue:          z.number().nullable().describe('Total revenue from the most recent annual income statement'),
  grossProfit:      z.number().nullable().describe('Revenue minus cost of goods sold from the most recent annual period'),
  ebit:             z.number().nullable().describe('Earnings before interest and taxes (operating income) from the latest annual period'),
  netIncome:        z.number().nullable().describe('Net income attributable to common shareholders from the latest annual period'),
  ebitda:           z.number().nullable().describe('Earnings before interest, taxes, depreciation and amortisation TTM'),
  interestExpense:  z.number().nullable().describe('Interest expense from the latest annual income statement (used in interest coverage ratio)'),
  incomeTaxExpense: z.number().nullable().describe('Income tax provision from the latest annual period (used to derive effective tax rate)'),
  incomeBeforeTax:  z.number().nullable().describe('Pre-tax income from the latest annual period'),
  taxRate:          z.number().nullable().describe('Effective tax rate (decimal): incomeTaxExpense / incomeBeforeTax; used in EPV and DCF'),

  // ── Balance Sheet (annual, latest) ──────────────────────────────────────────
  totalAssets:             z.number().nullable().describe('Total assets from the latest annual balance sheet (Altman Z, Beneish)'),
  totalCurrentAssets:      z.number().nullable().describe('Current assets from the latest annual balance sheet'),
  totalCurrentLiabilities: z.number().nullable().describe('Current liabilities from the latest annual balance sheet'),
  totalLiabilities:        z.number().nullable().describe('Total liabilities from the latest annual balance sheet'),
  retainedEarnings:        z.number().nullable().describe('Accumulated retained earnings from the latest balance sheet (Altman Z X2)'),
  workingCapital:          z.number().nullable().describe('Current assets minus current liabilities (Altman Z X1 numerator)'),

  // ── Cash Flow (annual, latest) ───────────────────────────────────────────────
  operatingCashFlowAnnual: z.number().nullable().describe('Operating cash flow from the latest annual cash flow statement (Beneish TATA)'),
  capex:                   z.number().nullable().describe('Capital expenditure (absolute value) from the latest annual cash flow statement'),
  depreciation:            z.number().nullable().describe('Depreciation & amortisation from the latest annual cash flow statement (Beneish DEPI)'),

  // ── EV & Multiples ──────────────────────────────────────────────────────────
  enterpriseValue:   z.number().nullable().describe('Enterprise value: market cap + total debt − cash (from Yahoo defaultKeyStatistics)'),
  sharesOutstanding: z.number().nullable().describe('Diluted shares outstanding'),
  targetMeanPrice:   z.number().nullable().describe('Consensus analyst mean price target (from Yahoo financialData)'),

  // ── Analyst Estimates ────────────────────────────────────────────────────────
  analystTargetHigh:   z.number().nullable().describe('Highest individual analyst price target'),
  analystTargetLow:    z.number().nullable().describe('Lowest individual analyst price target'),
  analystTargetMedian: z.number().nullable().describe('Median analyst price target'),
  analystCount:        z.number().nullable().describe('Total number of analysts covering the stock'),
  analystStrongBuy:    z.number().nullable().describe('Number of analysts with a Strong Buy rating (current month from recommendationTrend)'),
  analystBuy:          z.number().nullable().describe('Number of analysts with a Buy rating'),
  analystHold:         z.number().nullable().describe('Number of analysts with a Hold rating'),
  analystSell:         z.number().nullable().describe('Number of analysts with a Sell rating'),
  analystStrongSell:   z.number().nullable().describe('Number of analysts with a Strong Sell rating'),

  // ── Market Data ─────────────────────────────────────────────────────────────
  fiftyTwoWeekHigh: z.number().nullable().describe('Highest closing price over the trailing 52 weeks'),
  fiftyTwoWeekLow:  z.number().nullable().describe('Lowest closing price over the trailing 52 weeks'),
  beta:             z.number().nullable().describe('5-year monthly beta relative to the S&P 500 (market sensitivity; used in CAPM for DDM/EPV)'),
  dividendYield:    z.number().nullable().describe('Trailing annual dividend yield (decimal, e.g. 0.005 = 0.5%)'),
  payoutRatio:      z.number().nullable().describe('Dividends paid as a fraction of net income (decimal); null if no dividend'),

  // ── Classification ───────────────────────────────────────────────────────────
  sector:   z.string().nullable().describe('GICS sector (e.g. Technology, Industrials) from Yahoo assetProfile'),
  industry: z.string().nullable().describe('GICS industry group (e.g. Aerospace & Defense) from Yahoo assetProfile'),

  // ── Company Profile ──────────────────────────────────────────────────────────
  website:      z.string().nullable().describe('Company website URL from Yahoo assetProfile'),
  employees:    z.number().nullable().describe('Full-time employee count from Yahoo assetProfile'),
  headquarters: z.string().nullable().describe('City, state/region, country composed from Yahoo assetProfile address fields'),
  description:  z.string().nullable().describe('Long business summary from Yahoo assetProfile (up to ~400 chars shown in report)'),
  isin:         z.string().nullable().describe('International Securities Identification Number (12-char, e.g. DE000ENER6Y0); fetched from Yahoo Finance search'),
  wkn:          z.string().nullable().describe('Wertpapierkennnummer — 6-char German identifier; derived from ISIN for DE0 stocks'),

  // ── Finnhub-enriched ─────────────────────────────────────────────────────────
  roic:                z.number().nullable().describe('Return on invested capital TTM (decimal) from Finnhub /stock/metric roicTTM ÷ 100'),
  epsGrowth3Y:         z.number().nullable().describe('3-year EPS compound annual growth rate (decimal) from Finnhub epsGrowth3Y ÷ 100; preferred over TTM earningsGrowth in Graham Revised'),
  dividendGrowthRate5Y: z.number().nullable().describe('5-year dividend per share CAGR (decimal) from Finnhub dividendGrowthRate5Y ÷ 100; used in DDM growth estimate'),

  // ── Beneish M-Score inputs ───────────────────────────────────────────────────
  receivables: z.number().nullable().describe('Accounts receivable from the latest annual balance sheet (Beneish DSRI)'),
  ppe:         z.number().nullable().describe('Net property, plant & equipment from the latest annual balance sheet (Beneish AQI/DEPI)'),
  sga:         z.number().nullable().describe('Selling, general & administrative expenses from the latest annual income statement (Beneish SGAI)'),

  // ── Sortino inputs ───────────────────────────────────────────────────────────
  monthlyReturns: z.array(z.number()).describe('Array of ~11 monthly price returns (decimal) for the trailing 12 months; used to compute Sortino ratio downside deviation'),

  // ── Piotroski / Beneish prior-year snapshot ──────────────────────────────────
  prevYear: PrevYearSnapshotSchema.nullable().describe('Prior fiscal year financials; null when fewer than two annual periods are available'),

  // ── Short Interest ───────────────────────────────────────────────────────────
  shortPercentOfFloat:   z.number().nullable().describe('Fraction of float sold short (decimal, e.g. 0.045 = 4.5%); sourced from Yahoo defaultKeyStatistics'),
  shortRatio:            z.number().nullable().describe('Days to cover: shares short ÷ avg daily volume; measures how crowded the short is'),
  sharesShort:           z.number().nullable().describe('Total number of shares currently sold short'),
  sharesShortPriorMonth: z.number().nullable().describe('Shares short at prior settlement date — compare with sharesShort to see trend'),

  // ── Calendar Events ──────────────────────────────────────────────────────────
  nextEarningsDate:   z.string().nullable().describe('Next earnings announcement date (YYYY-MM-DD); may be an estimate'),
  exDividendDate:     z.string().nullable().describe('Ex-dividend date for the next/most-recent dividend (YYYY-MM-DD)'),
  dividendPayDate:    z.string().nullable().describe('Dividend payment date (YYYY-MM-DD)'),
  nextDividendAmount: z.number().nullable().describe('Expected dividend per share for the upcoming payment'),

  // ── Ownership ────────────────────────────────────────────────────────────────
  institutionsPercentHeld: z.number().nullable().describe('Fraction of total shares held by institutional investors (decimal)'),
  insidersPercentHeld:     z.number().nullable().describe('Fraction of total shares held by company insiders (decimal)'),
  institutionsCount:       z.number().nullable().describe('Number of institutional shareholders on record'),

  // ── Earnings Surprises (last ≤4 quarters) ────────────────────────────────────
  earningsSurprises: z.array(EarningsSurpriseSchema).describe('Last up-to-4 quarters of EPS surprise history from Yahoo earningsHistory'),

  // ── Insider Activity (last 6 months) ─────────────────────────────────────────
  insiderBuyShares:  z.number().nullable().describe('Total shares bought by insiders in the last 6 months'),
  insiderSellShares: z.number().nullable().describe('Total shares sold by insiders in the last 6 months'),
  insiderBuyValue:   z.number().nullable().describe('Total dollar value of insider purchases in the last 6 months'),
  insiderSellValue:  z.number().nullable().describe('Total dollar value of insider sales in the last 6 months'),
  insiderBuyCount:   z.number().nullable().describe('Number of distinct insider buy transactions in the last 6 months'),
  insiderSellCount:  z.number().nullable().describe('Number of distinct insider sell transactions in the last 6 months'),
});
export type StockFinancials = z.infer<typeof StockFinancialsSchema>;

// ─── Result Types ─────────────────────────────────────────────────────────────

export const DCFResultSchema = z.object({
  fairValue:          z.number().nullable().describe('Central DCF fair value per share; null when FCF is negative'),
  fairValueLow:       z.number().nullable().describe('Bear-case DCF fair value; null when not calculable'),
  fairValueHigh:      z.number().nullable().describe('Bull-case DCF fair value; null when not calculable'),
  wacc:               z.number().describe('Weighted average cost of capital used (decimal)'),
  terminalGrowthRate: z.number().describe('Perpetual terminal growth rate applied after projection period (decimal)'),
  projectionYears:    z.number().describe('Number of years explicitly projected (default 5)'),
  projectedFCFs:      z.array(z.number()).describe('Year-by-year projected free cash flows'),
  assumptions:        z.string().describe('Human-readable summary of the key DCF assumptions'),
});
export type DCFResult = z.infer<typeof DCFResultSchema>;

export const GrahamResultSchema = z.object({
  grahamNumber:    z.number().nullable().describe('Graham Number: sqrt(22.5 × EPS × bookValue); requires positive EPS and book value'),
  marginOfSafety:  z.number().nullable().describe('(grahamNumber − price) / price; positive means undervalued'),
  isUndervalued:   z.boolean().describe('True when the Graham Number exceeds the current price'),
});
export type GrahamResult = z.infer<typeof GrahamResultSchema>;

export const RatioResultSchema = z.object({
  pe:             z.number().nullable().describe('Trailing P/E ratio'),
  forwardPE:      z.number().nullable().describe('Forward P/E ratio'),
  peg:            z.number().nullable().describe('PEG ratio'),
  pb:             z.number().nullable().describe('Price-to-book ratio: price / bookValue'),
  roe:            z.number().nullable().describe('Return on equity (decimal)'),
  roa:            z.number().nullable().describe('Return on assets (decimal)'),
  debtToEquity:   z.number().nullable().describe('Total debt / shareholders equity'),
  currentRatio:   z.number().nullable().describe('Current assets / current liabilities'),
  operatingMargin: z.number().nullable().describe('Operating margin (decimal)'),
  netMargin:      z.number().nullable().describe('Net profit margin (decimal)'),
  revenueGrowth:  z.number().nullable().describe('YoY revenue growth (decimal)'),
  dividendYield:  z.number().nullable().describe('Trailing dividend yield (decimal)'),
});
export type RatioResult = z.infer<typeof RatioResultSchema>;

export const ReverseDCFResultSchema = z.object({
  impliedGrowthRate: z.number().nullable().describe('FCF growth rate (decimal) implied by the current market price, solved by inverting the DCF model'),
  wacc:              z.number().describe('WACC assumption used in the reverse solve (decimal)'),
  terminalGrowthRate: z.number().describe('Terminal growth rate assumption used (decimal)'),
  years:             z.number().describe('Projection horizon in years'),
  interpretation:    z.string().describe('Plain-English verdict on whether the implied growth rate is realistic'),
  isPossible:        z.boolean().describe('False when the reverse solve has no valid solution (e.g. negative FCF)'),
});
export type ReverseDCFResult = z.infer<typeof ReverseDCFResultSchema>;

export const PeterLynchResultSchema = z.object({
  fairValue:            z.number().nullable().describe('Lynch fair value: EPS × growth rate (no dividend); requires positive growth'),
  fairValueWithDividend: z.number().nullable().describe('Lynch fair value including dividend yield: EPS × (growth rate + dividend yield %)'),
  growthRate:           z.number().nullable().describe('Growth rate used in the Lynch formula (decimal); sourced from earningsGrowth or revenueGrowth'),
  isUndervalued:        z.boolean().nullable().describe('True when fairValue exceeds the current price'),
  marginOfSafety:       z.number().nullable().describe('(fairValue − price) / price'),
});
export type PeterLynchResult = z.infer<typeof PeterLynchResultSchema>;

export const EVMultiplesResultSchema = z.object({
  enterpriseValue: z.number().nullable().describe('Enterprise value in reporting currency'),
  evToEbitda:      z.number().nullable().describe('EV / EBITDA — most widely used EV multiple'),
  evToRevenue:     z.number().nullable().describe('EV / Revenue — useful for pre-profit or low-margin businesses'),
  evToFCF:         z.number().nullable().describe('EV / Free Cash Flow'),
  priceToFCF:      z.number().nullable().describe('Market cap / Free cash flow (equity-level FCF multiple)'),
  priceToSales:    z.number().nullable().describe('Market cap / Revenue (Price-to-Sales)'),
});
export type EVMultiplesResult = z.infer<typeof EVMultiplesResultSchema>;

export const RuleOf40ResultSchema = z.object({
  score:            z.number().nullable().describe('Rule of 40 score: revenue growth % + operating/net margin %; ≥40 is considered healthy for SaaS/growth companies'),
  revenueGrowthPct: z.number().nullable().describe('Revenue growth component in percentage points'),
  profitMarginPct:  z.number().nullable().describe('Margin component in percentage points (operating margin preferred, net margin as fallback)'),
  passes:           z.boolean().nullable().describe('True when score ≥ 40'),
});
export type RuleOf40Result = z.infer<typeof RuleOf40ResultSchema>;

export const GrahamRevisedResultSchema = z.object({
  fairValue:      z.number().nullable().describe('Graham V* intrinsic value: EPS × (8.5 + 2G) × 4.4 / Y, where G is growth % (capped at 15) and Y is AAA yield %'),
  bondYield:      z.number().describe('AAA corporate bond yield used as Y in the formula (decimal, e.g. 0.055 = 5.5%)'),
  growthRate:     z.number().nullable().describe('Growth rate used in the formula (decimal, capped at 0.15); sourced from epsGrowth3Y when available'),
  marginOfSafety: z.number().nullable().describe('(fairValue − price) / price'),
  isUndervalued:  z.boolean().nullable().describe('True when V* exceeds the current price'),
});
export type GrahamRevisedResult = z.infer<typeof GrahamRevisedResultSchema>;

export const PiotroskiSignalsSchema = z.object({
  f1_positiveROA:          z.boolean().nullable().describe('F1: ROA > 0 (profitable on assets)'),
  f2_positiveCFO:          z.boolean().nullable().describe('F2: Operating cash flow > 0'),
  f3_improvingROA:         z.boolean().nullable().describe('F3: ROA improved vs prior year'),
  f4_accruals:             z.boolean().nullable().describe('F4: CFO/Assets > ROA (cash earnings quality)'),
  f5_reducingLeverage:     z.boolean().nullable().describe('F5: Long-term debt / assets ratio declined vs prior year'),
  f6_improvingLiquidity:   z.boolean().nullable().describe('F6: Current ratio improved vs prior year'),
  f7_noNewShares:          z.boolean().nullable().describe('F7: No dilutive share issuance in the past year (not computed — always null)'),
  f8_improvingGrossMargin: z.boolean().nullable().describe('F8: Gross margin improved vs prior year'),
  f9_improvingAssetTurnover: z.boolean().nullable().describe('F9: Asset turnover (revenue / assets) improved vs prior year'),
});
export type PiotroskiSignals = z.infer<typeof PiotroskiSignalsSchema>;

export const PiotroskiResultSchema = z.object({
  score:          z.number().describe('Sum of all true Piotroski signals (0–9; F7 excluded so effective max is 8)'),
  maxScore:       z.number().describe('Maximum possible score given available data (8 when F7 is excluded)'),
  signals:        PiotroskiSignalsSchema.describe('Individual boolean outcomes for each of the nine Piotroski criteria'),
  interpretation: z.enum(['strong', 'neutral', 'weak']).describe('strong = score ≥ 7; weak = score ≤ 2; neutral otherwise'),
});
export type PiotroskiResult = z.infer<typeof PiotroskiResultSchema>;

export const AltmanZResultSchema = z.object({
  score:      z.number().nullable().describe('Altman Z-Score; higher is safer'),
  zone:       z.enum(['safe', 'grey', 'distress', 'unknown']).describe('safe = low bankruptcy risk; grey = uncertain; distress = high risk'),
  x1:         z.number().nullable().describe('Working capital / total assets'),
  x2:         z.number().nullable().describe('Retained earnings / total assets'),
  x3:         z.number().nullable().describe('EBIT / total assets'),
  x4:         z.number().nullable().describe('Market cap / total liabilities (original) or book equity / total liabilities (modified)'),
  x5:         z.number().nullable().describe('Revenue / total assets'),
  model:      z.enum(['original', 'modified']).describe('original = public manufacturing firms; modified = non-manufacturing or private firms'),
  thresholds: z.object({
    safe:     z.number().describe('Z-Score above this → safe zone'),
    distress: z.number().describe('Z-Score below this → distress zone'),
  }).describe('Model-specific zone boundaries'),
});
export type AltmanZResult = z.infer<typeof AltmanZResultSchema>;

export const DDMResultSchema = z.object({
  fairValue:           z.number().nullable().describe('Gordon Growth Model fair value: D1 / (r − g); null when g ≥ r − 2% (model unstable) or no dividend'),
  dividendPerShare:    z.number().nullable().describe('Annual dividend per share: price × dividendYield'),
  dividendGrowthRate:  z.number().nullable().describe('Dividend growth rate used in the model (decimal, capped at 10%)'),
  requiredReturn:      z.number().nullable().describe('CAPM required return: riskFreeRate + beta × 5.5% equity premium (decimal)'),
  isApplicable:        z.boolean().describe('False when the stock pays no dividend'),
});
export type DDMResult = z.infer<typeof DDMResultSchema>;

export const SortinoResultSchema = z.object({
  ratio:              z.number().nullable().describe('Sortino ratio: (annualReturn − riskFreeRate) / downsideDeviation; null when fewer than 6 monthly returns are available'),
  annualReturn:       z.number().nullable().describe('Annualised arithmetic return from monthly price data (decimal)'),
  downsideDeviation:  z.number().nullable().describe('Annualised standard deviation of negative monthly excess returns only (decimal)'),
  riskFreeRate:       z.number().describe('Risk-free rate used as the MAR (decimal); sourced from FRED DGS10 or defaults to 4.5%'),
  interpretation:     z.enum(['excellent', 'good', 'acceptable', 'poor', 'very poor', 'unknown']).describe('excellent ≥ 2; good ≥ 1; acceptable ≥ 0.5; poor ≥ 0; very poor < 0'),
});
export type SortinoResult = z.infer<typeof SortinoResultSchema>;

export const BeneishResultSchema = z.object({
  score:             z.number().nullable().describe('Beneish M-Score: weighted sum of 8 accrual-based variables; > −1.78 indicates likely earnings manipulation'),
  probability:       z.enum(['likely manipulator', 'grey zone', 'unlikely manipulator', 'unknown']).describe('likely manipulator = M > −1.78; unlikely = M < −2.22; grey zone in between'),
  dsri:  z.number().nullable().describe('Days Sales Receivable Index: receivables growth vs revenue growth; >1 suggests revenue inflation'),
  gmi:   z.number().nullable().describe('Gross Margin Index: prior gross margin / current; >1 indicates deteriorating margins'),
  aqi:   z.number().nullable().describe('Asset Quality Index: non-current/non-PPE assets as share of total; >1 suggests off-balance-sheet capitalisation'),
  sgi:   z.number().nullable().describe('Sales Growth Index: current revenue / prior revenue; high growth can accompany manipulation'),
  depi:  z.number().nullable().describe('Depreciation Index: prior depreciation rate / current; >1 may indicate slowing depreciation to inflate earnings'),
  sgai:  z.number().nullable().describe('SG&A Index: current SGA/revenue vs prior; >1 suggests rising overhead not matched by revenue'),
  tata:  z.number().nullable().describe('Total Accruals to Total Assets: (net income − CFO) / assets; high accruals relative to cash earnings is a red flag'),
  lvgi:  z.number().nullable().describe('Leverage Index: current total debt ratio / prior; >1 indicates increasing leverage'),
  variablesComputed: z.number().describe('Number of the 8 Beneish variables successfully calculated; fewer than 4 makes the score unreliable'),
});
export type BeneishResult = z.infer<typeof BeneishResultSchema>;

export const EPVResultSchema = z.object({
  fairValue:       z.number().nullable().describe('Earnings Power Value per share (Greenwald method): normalizedEbit × (1 − taxRate) / WACC / sharesOutstanding'),
  normalizedEbit:  z.number().nullable().describe('EBIT adjusted for D&A to approximate maintainable earnings power'),
  taxRate:         z.number().describe('Effective tax rate applied (decimal); uses computed taxRate or defaults to 21%'),
  wacc:            z.number().describe('WACC used to capitalise normalised earnings (decimal; defaults to 8%)'),
  marginOfSafety:  z.number().nullable().describe('(fairValue − price) / price'),
});
export type EPVResult = z.infer<typeof EPVResultSchema>;

export const InterestCoverageResultSchema = z.object({
  ratio:          z.number().nullable().describe('EBIT / interest expense; measures how many times operating profit covers interest payments'),
  interpretation: z.enum(['excellent', 'good', 'fair', 'poor', 'critical', 'unknown']).describe('excellent ≥ 8; good ≥ 4; fair ≥ 2; poor ≥ 1; critical < 1'),
});
export type InterestCoverageResult = z.infer<typeof InterestCoverageResultSchema>;

export const SectorMediansSchema = z.object({
  // Valuation multiples
  pe:          z.number().nullable().describe('Median trailing P/E of the peer group (outliers beyond ±500 removed)'),
  evToEbitda:  z.number().nullable().describe('Median EV/EBITDA of the peer group'),
  evToRevenue: z.number().nullable().describe('Median EV/Revenue of the peer group'),
  priceToFCF:  z.number().nullable().describe('Median Price/FCF of the peer group'),
  pb:          z.number().nullable().describe('Median Price/Book of the peer group'),
  // Profitability
  operatingMargin:  z.number().nullable().describe('Median operating margin of the peer group (decimal)'),
  netMargin:        z.number().nullable().describe('Median net profit margin of the peer group (decimal)'),
  roe:              z.number().nullable().describe('Median return on equity of the peer group (decimal)'),
  roic:             z.number().nullable().describe('Median return on invested capital of the peer group (decimal)'),
  // Growth
  revenueGrowthYoY: z.number().nullable().describe('Median YoY revenue growth of the peer group TTM (decimal)'),
  peerCount: z.number().describe('Number of peers whose data was successfully fetched'),
  peers:     z.array(z.string()).describe('List of peer ticker symbols used to compute medians'),
});
export type SectorMedians = z.infer<typeof SectorMediansSchema>;

// ─── News & Search ────────────────────────────────────────────────────────────

export const NewsItemSchema = z.object({
  headline:  z.string().describe('Article headline from Finnhub company-news endpoint'),
  source:    z.string().describe('News source / publication name'),
  url:       z.string().describe('Direct URL to the news article'),
  datetime:  z.number().describe('Unix timestamp (seconds) of publication'),
  summary:   z.string().describe('Short article summary from Finnhub'),
  sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Sentiment label derived from Finnhub sentiment score (>0.1 positive, <−0.1 negative)'),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const SearchResultSchema = z.object({
  title:   z.string().describe('Page title of the search result'),
  url:     z.string().describe('URL of the search result'),
  content: z.string().describe('Snippet or extracted content from the page'),
  score:   z.number().optional().describe('Relevance score returned by the search provider (Tavily/Brave)'),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ─── LLM Output ───────────────────────────────────────────────────────────────

export const LLMAnalysisSchema = z.object({
  bullCase:          z.string().describe('Detailed bull case: specific catalysts, competitive advantages, and valuation support'),
  bearCase:          z.string().describe('Detailed bear case: key risks, valuation concerns, and downside scenarios'),
  keyRisks:          z.array(z.string()).describe('Top 3 most important risks cited with specific data points'),
  thesis:            z.string().describe('Single 1–2 sentence investment thesis summarising the overall view'),
  score:             z.number().min(0).max(10).describe('Overall investment attractiveness score from 0 (avoid) to 10 (strong conviction buy)'),
  recommendation:    z.enum(['STRONG BUY', 'BUY', 'HOLD', 'SELL', 'STRONG SELL']).describe('Structured recommendation label'),
  fairValueEstimate: z.string().describe('LLM-synthesised fair value range as a string (e.g. "$120 – $145")'),
});
export type LLMAnalysis = z.infer<typeof LLMAnalysisSchema>;

// ─── Top-level Result & Options ───────────────────────────────────────────────

export const AnalysisResultSchema = z.object({
  symbol:          z.string().describe('Resolved Yahoo Finance ticker symbol'),
  timestamp:       z.string().describe('ISO 8601 timestamp of when the analysis was run'),
  provider:        z.string().describe('Actual model ID used for analysis (e.g. claude-sonnet-4-6, gpt-5.4-mini)'),
  searchProvider:  z.string().describe('Web search mode used (none | brave | tavily | claude | openai | openai-tavily)'),
  financials:      StockFinancialsSchema,
  dcf:             DCFResultSchema,
  grahamNumber:    GrahamResultSchema,
  ratios:          RatioResultSchema,
  reverseDCF:      ReverseDCFResultSchema,
  peterLynch:      PeterLynchResultSchema,
  evMultiples:     EVMultiplesResultSchema,
  ruleOf40:        RuleOf40ResultSchema,
  grahamRevised:   GrahamRevisedResultSchema,
  piotroski:       PiotroskiResultSchema,
  altmanZ:         AltmanZResultSchema,
  ddm:             DDMResultSchema,
  epv:             EPVResultSchema,
  interestCoverage: InterestCoverageResultSchema,
  sortino:         SortinoResultSchema,
  beneish:         BeneishResultSchema,
  sectorMedians:   SectorMediansSchema.nullable().describe('Peer group median metrics; null when Finnhub peer data is unavailable'),
  llmAnalysis:     LLMAnalysisSchema,
  news:            z.array(NewsItemSchema).describe('Up to 10 recent news items from Finnhub'),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const AnalysisOptionsSchema = z.object({
  provider: z.enum(['claude', 'openai', 'gemini']).describe('Resolved LLM provider (claude | openai | gemini)'),
  modelId:  z.string().describe('Actual model ID sent to the API (e.g. claude-sonnet-4-6, gpt-5.4-mini)'),
  search:   z.enum(['claude', 'openai', 'tavily', 'openai-tavily', 'brave', 'none']).describe('Web search mode; claude requires Claude provider, openai requires OpenAI provider'),
  cache:    z.boolean().describe('Whether to read/write the financial data file cache (TTL 1 hour, invalidated on schema version bump)'),
  output:   z.string().optional().describe('Output file path; .md produces Markdown, .json produces raw JSON'),
  verbose:  z.boolean().describe('Enable debug-level logging'),
});
export type AnalysisOptions = z.infer<typeof AnalysisOptionsSchema>;
