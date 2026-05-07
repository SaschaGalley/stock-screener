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

export const EarningsEstimateSchema = z.object({
  period:           z.string().describe('Period key: "0q" = current qtr, "+1q" = next qtr, "0y" = current year, "+1y" = next year'),
  endDate:          z.string().nullable().describe('Period end date (YYYY-MM-DD)'),
  epsEstimate:      z.number().nullable().describe('Consensus mean EPS estimate'),
  epsLow:           z.number().nullable().describe('Lowest analyst EPS estimate'),
  epsHigh:          z.number().nullable().describe('Highest analyst EPS estimate'),
  epsGrowth:        z.number().nullable().describe('Expected EPS YoY growth rate (decimal)'),
  revenueEstimate:  z.number().nullable().describe('Consensus mean revenue estimate'),
  revenueGrowth:    z.number().nullable().describe('Expected revenue YoY growth rate (decimal)'),
  numberOfAnalysts: z.number().nullable().describe('Number of analysts providing EPS estimates'),
});
export type EarningsEstimate = z.infer<typeof EarningsEstimateSchema>;

export const StockFinancialsSchema = z.object({
  // ── Identity ────────────────────────────────────────────────────────────────
  symbol:      z.string().describe('Exchange ticker symbol as used by Yahoo Finance (e.g. AAPL, 0QW9.IL)'),
  companyName: z.string().describe('Full legal company name from Yahoo Finance price data'),
  price:       z.number().describe('Most recent regular market close price in USD (or local currency)'),
  marketCap:   z.number().describe('Total market capitalisation: shares outstanding × price'),

  // ── Valuation ───────────────────────────────────────────────────────────────
  peRatio:   z.number().nullable().describe('Trailing 12-month P/E ratio (price / EPS TTM)'),
  forwardPE: z.number().nullable().describe('Forward P/E ratio based on next-12-month consensus EPS estimate'),
  avgPE5Y:   z.number().nullable().describe('Simple average of trailing P/E at fiscal year-end for each of the last 3-4 profitable years (loss years excluded)'),
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
  earningsEstimates: z.array(EarningsEstimateSchema).describe('Forward EPS & revenue estimates for current qtr, next qtr, current year, next year from Yahoo earningsTrend'),

  // ── Insider Activity (last 6 months) ─────────────────────────────────────────
  insiderBuyShares:  z.number().nullable().describe('Total shares bought by insiders in the last 6 months'),
  insiderSellShares: z.number().nullable().describe('Total shares sold by insiders in the last 6 months'),
  insiderBuyValue:   z.number().nullable().describe('Total dollar value of insider purchases in the last 6 months'),
  insiderSellValue:  z.number().nullable().describe('Total dollar value of insider sales in the last 6 months'),
  insiderBuyCount:   z.number().nullable().describe('Number of distinct insider buy transactions in the last 6 months'),
  insiderSellCount:  z.number().nullable().describe('Number of distinct insider sell transactions in the last 6 months'),
});
export type StockFinancials = z.infer<typeof StockFinancialsSchema>;

// ─── Market Signals (Technicals / Revisions / Options / Macro) ───────────────

export const TechnicalReturnsSchema = z.object({
  d1:  z.number().nullable().describe('1-day price return (decimal, e.g. 0.012 = +1.2%)'),
  w1:  z.number().nullable().describe('1-week price return (decimal)'),
  m1:  z.number().nullable().describe('1-month price return (decimal)'),
  m3:  z.number().nullable().describe('3-month price return (decimal)'),
  m6:  z.number().nullable().describe('6-month price return (decimal)'),
  ytd: z.number().nullable().describe('Year-to-date price return (decimal)'),
  y1:  z.number().nullable().describe('1-year price return (decimal)'),
});
export type TechnicalReturns = z.infer<typeof TechnicalReturnsSchema>;

export const TechnicalIndicatorsSchema = z.object({
  returns:           TechnicalReturnsSchema.describe('Trailing total returns over standard horizons'),
  sma50:             z.number().nullable().describe('50-day simple moving average'),
  sma200:            z.number().nullable().describe('200-day simple moving average'),
  distFromSMA50Pct:  z.number().nullable().describe('(price − SMA50) / SMA50 (decimal); positive = above the average'),
  distFromSMA200Pct: z.number().nullable().describe('(price − SMA200) / SMA200 (decimal); positive = above the average'),
  goldenCross:       z.boolean().nullable().describe('True when SMA50 > SMA200 (medium-term uptrend)'),
  rsi14:             z.number().nullable().describe('14-day Wilder RSI (0–100); >70 overbought, <30 oversold'),
  macdLine:          z.number().nullable().describe('MACD line (12-EMA − 26-EMA)'),
  macdSignal:        z.number().nullable().describe('MACD signal line (9-EMA of MACD)'),
  macdHistogram:     z.number().nullable().describe('MACD histogram (line − signal); sign indicates momentum direction'),
  bollingerUpper:    z.number().nullable().describe('Bollinger upper band (20-SMA + 2σ)'),
  bollingerMid:      z.number().nullable().describe('Bollinger middle band (20-SMA)'),
  bollingerLower:    z.number().nullable().describe('Bollinger lower band (20-SMA − 2σ)'),
  bollingerPercentB: z.number().nullable().describe('%B = (price − lower) / (upper − lower); 0 = lower band, 1 = upper band'),
  atr14:             z.number().nullable().describe('14-day Average True Range (absolute price units)'),
  atr14Pct:          z.number().nullable().describe('ATR14 / price (decimal); volatility relative to price'),
  hv30:              z.number().nullable().describe('30-day annualised historical volatility from log returns (decimal)'),
  hv90:              z.number().nullable().describe('90-day annualised historical volatility from log returns (decimal)'),
  drawdownFromHighPct: z.number().nullable().describe('(price − 1Y high) / 1Y high (decimal, ≤0); current drawdown vs 252-day high'),
  position52WPct:    z.number().nullable().describe('(price − 52W low) / (52W high − 52W low); 0 = at low, 1 = at high'),
  avgVolume30:       z.number().nullable().describe('Average daily volume over the last 30 sessions'),
  currentVolRatio:   z.number().nullable().describe('Latest session volume / 30-day average volume'),
  rsVsSPY3M:         z.number().nullable().describe('3-month outperformance vs S&P 500 (stockReturn − spyReturn, decimal)'),
  rsVsSector3M:      z.number().nullable().describe('3-month outperformance vs sector ETF (decimal); null when sector mapping unavailable'),
});
export type TechnicalIndicators = z.infer<typeof TechnicalIndicatorsSchema>;

export const EpsTrendSnapshotSchema = z.object({
  current: z.number().nullable().describe('Current consensus EPS estimate'),
  ago7d:   z.number().nullable().describe('Estimate as of ~7 days ago'),
  ago30d:  z.number().nullable().describe('Estimate as of ~30 days ago'),
  ago60d:  z.number().nullable().describe('Estimate as of ~60 days ago'),
  ago90d:  z.number().nullable().describe('Estimate as of ~90 days ago'),
});
export type EpsTrendSnapshot = z.infer<typeof EpsTrendSnapshotSchema>;

export const EpsRevisionCountsSchema = z.object({
  up7d:    z.number().nullable().describe('Analyst upward EPS revisions in the last 7 days'),
  up30d:   z.number().nullable().describe('Analyst upward EPS revisions in the last 30 days'),
  up90d:   z.number().nullable().describe('Analyst upward EPS revisions in the last 90 days'),
  down7d:  z.number().nullable().describe('Analyst downward EPS revisions in the last 7 days'),
  down30d: z.number().nullable().describe('Analyst downward EPS revisions in the last 30 days'),
  down90d: z.number().nullable().describe('Analyst downward EPS revisions in the last 90 days'),
});
export type EpsRevisionCounts = z.infer<typeof EpsRevisionCountsSchema>;

export const RevisionPeriodSchema = z.object({
  period:           z.string().describe('Period key: "0q" | "+1q" | "0y" | "+1y"'),
  epsTrend:         EpsTrendSnapshotSchema.describe('Estimate value at multiple lookback points'),
  revisions:        EpsRevisionCountsSchema.describe('Analyst revision counts (up/down) over 7/30/90 days'),
  netRevision30d:   z.number().nullable().describe('up30d − down30d; positive = bullish revision flow'),
  epsChange30dPct:  z.number().nullable().describe('(current − ago30d) / |ago30d| (decimal); estimate drift over 30 days'),
});
export type RevisionPeriod = z.infer<typeof RevisionPeriodSchema>;

export const AnalystRatingDeltaSchema = z.object({
  strongBuy:  z.number().describe('Δ in Strong Buy count vs prior month'),
  buy:        z.number().describe('Δ in Buy count vs prior month'),
  hold:       z.number().describe('Δ in Hold count vs prior month'),
  sell:       z.number().describe('Δ in Sell count vs prior month'),
  strongSell: z.number().describe('Δ in Strong Sell count vs prior month'),
});
export type AnalystRatingDelta = z.infer<typeof AnalystRatingDeltaSchema>;

export const EarningsRevisionsSchema = z.object({
  perPeriod:             z.array(RevisionPeriodSchema).describe('Per-period revision data (up to 4 entries: 0q, +1q, 0y, +1y)'),
  analystRatingMoMDelta: AnalystRatingDeltaSchema.nullable().describe('Month-over-month change in analyst rating buckets, null when no prior period'),
});
export type EarningsRevisions = z.infer<typeof EarningsRevisionsSchema>;

export const ImpliedMoveSchema = z.object({
  pct:            z.number().describe('Implied one-period move (decimal): ATM straddle / spot'),
  expirationDate: z.string().describe('Expiry used for the calculation (YYYY-MM-DD), first one after next earnings'),
});
export type ImpliedMove = z.infer<typeof ImpliedMoveSchema>;

export const OptionsSignalsSchema = z.object({
  ivAtm30d:               z.number().nullable().describe('ATM implied volatility (annualised, decimal) for the nearest expiry > ~21 days'),
  putCallVolumeRatio:     z.number().nullable().describe('Σ put volume / Σ call volume across strikes within ±15% of spot'),
  putCallOIRatio:         z.number().nullable().describe('Σ put open interest / Σ call open interest (same window)'),
  nextEarningsImpliedMove: ImpliedMoveSchema.nullable().describe('Implied move (straddle / spot) for first expiry after the next earnings date'),
  ivVsHv90Ratio:          z.number().nullable().describe('ivAtm30d / hv90; >1 = options expensive vs realised volatility, <1 = cheap'),
});
export type OptionsSignals = z.infer<typeof OptionsSignalsSchema>;

export const MacroContextSchema = z.object({
  vix:                z.number().nullable().describe('Latest CBOE VIX level (^VIX)'),
  vixRegime:          z.enum(['low', 'normal', 'elevated', 'high', 'unknown']).describe('low <15, normal 15–20, elevated 20–30, high >30'),
  spy3MReturn:        z.number().nullable().describe('S&P 500 (^GSPC) 3-month total return (decimal)'),
  yieldCurve2Y10Y:    z.number().nullable().describe('FRED T10Y2Y spread (10Y − 2Y) in basis points'),
  hySpreadBps:        z.number().nullable().describe('FRED BAMLH0A0HYM2 high-yield option-adjusted spread in basis points'),
  dxyLevel:           z.number().nullable().describe('US Dollar Index latest level (DX-Y.NYB)'),
  dxyChange3MPct:     z.number().nullable().describe('DXY 3-month change (decimal)'),
  sectorEtfSymbol:    z.string().nullable().describe('Mapped sector ETF symbol (e.g. XLK for Technology); null when no mapping exists'),
  sectorEtfReturn3M:  z.number().nullable().describe('Sector ETF 3-month return (decimal); null when sector ETF not fetched'),
  fetchedAt:          z.string().describe('ISO timestamp when this macro snapshot was fetched (used by cache)'),
});
export type MacroContext = z.infer<typeof MacroContextSchema>;

export const MarketSignalsSchema = z.object({
  technicals: TechnicalIndicatorsSchema,
  revisions:  EarningsRevisionsSchema,
  options:    OptionsSignalsSchema.nullable().describe('Null when no liquid options chain is available'),
  macro:      MacroContextSchema,
});
export type MarketSignals = z.infer<typeof MarketSignalsSchema>;

// ─── Result Types ─────────────────────────────────────────────────────────────

export const DCFResultSchema = z.object({
  fairValue:          z.number().nullable().describe('Base-case 2-stage DCF fair value per share (FCFF discounted at cost of equity, equity-bridge applied: + cash − debt)'),
  fairValueBear:      z.number().nullable().describe('Bear-case fair value: stage-1 growth −2pp, discount rate +1pp'),
  fairValueBull:      z.number().nullable().describe('Bull-case fair value: stage-1 growth +2pp, discount rate −1pp'),
  discountRate:       z.number().describe('Discount rate used (cost of equity from CAPM: rf + βcapped × ERP)'),
  beta:               z.number().nullable().describe('Beta used for CAPM (capped at [0.8, 2.0] per SWS convention)'),
  riskFreeRate:       z.number().describe('Risk-free rate used (10Y Treasury from FRED, decimal)'),
  stage1Growth:       z.number().describe('Stage-1 (years 1–5) FCF growth rate (decimal)'),
  terminalGrowthRate: z.number().describe('Stable terminal growth rate after fade (decimal)'),
  stage1Years:        z.number().describe('Number of years in stage 1 (high-growth, default 5)'),
  fadeYears:          z.number().describe('Number of years for linear growth fade (default 5)'),
  projectedFCFs:      z.array(z.number()).describe('Year-by-year projected free cash flows over the full horizon (stage1 + fade)'),
  terminalValue:      z.number().nullable().describe('Terminal value at end of fade period: FCF_n × (1+g_t) / (r − g_t)'),
  enterpriseValue:    z.number().nullable().describe('Sum of PV(FCFs) + PV(terminal) — pre-equity-bridge enterprise value'),
  netDebt:            z.number().nullable().describe('Total debt − total cash; subtracted from EV to get equity value'),
  assumptions:        z.string().describe('Human-readable summary of key DCF assumptions'),
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
  ownerEarningsYield: z.number().nullable().describe('Buffett-style owner earnings yield: (netIncome + depreciation − capex) / marketCap (decimal); higher = cheaper'),
});
export type RatioResult = z.infer<typeof RatioResultSchema>;

export const ReverseDCFResultSchema = z.object({
  impliedGrowthRate: z.number().nullable().describe('Stage-1 FCF growth rate (decimal) implied by the current market price, solved by inverting the 2-stage DCF model'),
  discountRate:      z.number().describe('CAPM-based cost of equity used (decimal)'),
  terminalGrowthRate: z.number().describe('Terminal growth rate assumption used (decimal)'),
  stage1Years:       z.number().describe('Stage-1 horizon in years (default 5)'),
  fadeYears:         z.number().describe('Fade horizon in years (default 5)'),
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
  enterpriseValue:     z.number().nullable().describe('Enterprise value in reporting currency'),
  evToEbitda:          z.number().nullable().describe('EV / EBITDA — most widely used EV multiple'),
  evToRevenue:         z.number().nullable().describe('EV / Revenue — useful for pre-profit or low-margin businesses'),
  evToFCF:             z.number().nullable().describe('EV / Free Cash Flow'),
  priceToFCF:          z.number().nullable().describe('Market cap / Free cash flow (equity-level FCF multiple)'),
  priceToSales:        z.number().nullable().describe('Trailing Market cap / Revenue (Price-to-Sales TTM)'),
  forwardPriceToSales: z.number().nullable().describe('Forward P/S: Market cap / consensus forward revenue (FY+1 if available, else FY+0); reveals NTM multiple compression for growth firms'),
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
  fairValue:       z.number().nullable().describe('Earnings Power Value per share (Greenwald method): NOPAT / discountRate, plus cash − debt bridge'),
  normalizedEbit:  z.number().nullable().describe('Sustainable EBIT used as input (= reported EBIT; no D&A boost — true Greenwald uses cycle-averaged EBIT which we approximate with latest annual)'),
  taxRate:         z.number().describe('Effective tax rate applied (decimal); uses computed taxRate or defaults to 21%'),
  wacc:            z.number().describe('Discount rate used to capitalise NOPAT (decimal); cost of equity from CAPM'),
  marginOfSafety:  z.number().nullable().describe('(fairValue − price) / price'),
});
export type EPVResult = z.infer<typeof EPVResultSchema>;

export const RIMResultSchema = z.object({
  fairValue:      z.number().nullable().describe('Residual Income Model value per share: BV₀ + Σ PV(excess returns over cost of equity), 5-year horizon with terminal RI = 0'),
  costOfEquity:   z.number().describe('CAPM cost of equity used as required return (decimal)'),
  excessReturn:   z.number().nullable().describe('Current ROE minus cost of equity (decimal); positive = value-creating'),
  bookValuePerShare: z.number().nullable().describe('Starting book value per share (BV₀)'),
  marginOfSafety: z.number().nullable().describe('(fairValue − price) / price'),
  isApplicable:   z.boolean().describe('False when bookValue ≤ 0 or ROE ≤ 0 (model not meaningful)'),
});
export type RIMResult = z.infer<typeof RIMResultSchema>;

export const NCAVResultSchema = z.object({
  ncavPerShare:   z.number().nullable().describe('Net Current Asset Value per share: (currentAssets − totalLiabilities) / shares; Graham-style liquidation floor'),
  buyThreshold:   z.number().nullable().describe('Graham buy threshold: (2/3) × NCAV — only buy below this'),
  marginOfSafety: z.number().nullable().describe('(ncavPerShare − price) / price; usually negative (NCAV below price for healthy firms)'),
  isApplicable:   z.boolean().describe('False when current assets ≤ total liabilities (no positive NCAV; deep-value floor model not applicable)'),
});
export type NCAVResult = z.infer<typeof NCAVResultSchema>;

export const PeerMultiplesEntrySchema = z.object({
  metric:       z.enum(['pe', 'evEbitda', 'evRevenue', 'priceFCF', 'priceSales', 'pb']).describe('Multiple identifier'),
  ownMetric:    z.number().nullable().describe('Own value of the underlying input (eps, ebitda, revenue, fcf, bookValue)'),
  sectorMedian: z.number().nullable().describe('Peer-group median multiple (from Finnhub sectorMedians)'),
  fairPrice:    z.number().nullable().describe('Fair price per share implied by applying sector median to own input'),
});
export type PeerMultiplesEntry = z.infer<typeof PeerMultiplesEntrySchema>;

export const PeerMultiplesResultSchema = z.object({
  byMultiple:      z.array(PeerMultiplesEntrySchema).describe('Per-multiple fair price estimates'),
  medianFairPrice: z.number().nullable().describe('Median fair price across all applicable multiples'),
  meanFairPrice:   z.number().nullable().describe('Mean fair price across all applicable multiples'),
  count:           z.number().describe('Number of multiples that produced a valid fair price'),
  marginOfSafety:  z.number().nullable().describe('(medianFairPrice − price) / price'),
});
export type PeerMultiplesResult = z.infer<typeof PeerMultiplesResultSchema>;

export const CompositeContributorSchema = z.object({
  name:      z.string().describe('Model name (e.g. "DCF (2-Stage)", "Graham Revised", "Peer Multiples")'),
  fairValue: z.number().describe('Fair value contributed by this model'),
});
export type CompositeContributor = z.infer<typeof CompositeContributorSchema>;

export const CompositeExclusionSchema = z.object({
  name:   z.string().describe('Model name that was excluded'),
  reason: z.string().describe('Why this model is not applicable for this stock'),
});
export type CompositeExclusion = z.infer<typeof CompositeExclusionSchema>;

export const CompositeTierSchema = z.object({
  median:         z.number().nullable().describe('Median fair value across this tier'),
  mean:           z.number().nullable().describe('Mean fair value across this tier'),
  p25:            z.number().nullable().describe('25th percentile of fair values in this tier'),
  p75:            z.number().nullable().describe('75th percentile'),
  min:            z.number().nullable().describe('Min fair value across this tier'),
  max:            z.number().nullable().describe('Max fair value across this tier'),
  marginOfSafety: z.number().nullable().describe('(median − price) / price for this tier'),
  models:         z.array(CompositeContributorSchema).describe('Contributing models in this tier'),
});
export type CompositeTier = z.infer<typeof CompositeTierSchema>;

export const CompositeFairValueResultSchema = z.object({
  /**
   * Headline tier — market-aligned, growth-aware models. This is "the" fair value.
   * Includes: DCF (2-Stage), Peer Multiples median, Peter Lynch, Analyst Consensus.
   */
  primary:      CompositeTierSchema,
  /**
   * Conservative tier — value-investor lens (no-growth or asset-based assumptions).
   * Includes: Graham Number, Graham Revised V*, EPV, RIM, DDM. Shown as a
   * separate "value lens" — typically prints lower than primary for growth firms.
   */
  conservative: CompositeTierSchema,
  excludedModels: z.array(CompositeExclusionSchema).describe('Models that were excluded with reason'),
  confidence:     z.number().describe('0–10 confidence score (based on primary tier coverage + IQR + Beneish)'),
  pctPrimaryUndervalued: z.number().nullable().describe('Fraction of primary models indicating undervaluation'),

  // Aliases for backwards-compat with existing readers — same as primary.*
  median:               z.number().nullable(),
  mean:                 z.number().nullable(),
  p25:                  z.number().nullable(),
  p75:                  z.number().nullable(),
  min:                  z.number().nullable(),
  max:                  z.number().nullable(),
  marginOfSafety:       z.number().nullable(),
  pctModelsUndervalued: z.number().nullable(),
  contributingModels:   z.array(CompositeContributorSchema),
});
export type CompositeFairValueResult = z.infer<typeof CompositeFairValueResultSchema>;

export const InterestCoverageResultSchema = z.object({
  ratio:          z.number().nullable().describe('EBIT / interest expense; measures how many times operating profit covers interest payments'),
  interpretation: z.enum(['excellent', 'good', 'fair', 'poor', 'critical', 'unknown']).describe('excellent ≥ 8; good ≥ 4; fair ≥ 2; poor ≥ 1; critical < 1'),
});
export type InterestCoverageResult = z.infer<typeof InterestCoverageResultSchema>;

export const SectorMediansSchema = z.object({
  // Valuation multiples
  pe:           z.number().nullable().describe('Median trailing P/E of the peer group (outliers beyond ±500 removed)'),
  evToEbitda:   z.number().nullable().describe('Median EV/EBITDA of the peer group'),
  evToRevenue:  z.number().nullable().describe('Median EV/Revenue of the peer group'),
  priceToFCF:   z.number().nullable().describe('Median Price/FCF of the peer group'),
  priceToSales: z.number().nullable().describe('Median Price/Sales (P/S) TTM of the peer group — equity-side analogue of EV/Revenue'),
  forwardPriceToSales: z.number().nullable().describe('Median forward P/S of the peer group — approximated as median(P/S TTM) / (1 + median revenue growth)'),
  pb:           z.number().nullable().describe('Median Price/Book of the peer group'),
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
  rim:             RIMResultSchema,
  ncav:            NCAVResultSchema,
  peerMultiples:   PeerMultiplesResultSchema,
  composite:       CompositeFairValueResultSchema,
  interestCoverage: InterestCoverageResultSchema,
  sortino:         SortinoResultSchema,
  beneish:         BeneishResultSchema,
  sectorMedians:   SectorMediansSchema.nullable().describe('Peer group median metrics; null when Finnhub peer data is unavailable'),
  marketSignals:   MarketSignalsSchema.describe('Technicals, earnings revisions, options market data, and macro context'),
  llmAnalysis:     LLMAnalysisSchema,
  news:            z.array(NewsItemSchema).describe('Up to 10 recent news items from Finnhub'),
  perplexity:      z.object({
    model:     z.enum(['sonar', 'sonar-pro']),
    synthesis: z.string(),
    citations: z.array(z.string()),
    fetchedAt: z.string(),
  }).nullable().optional(),
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
