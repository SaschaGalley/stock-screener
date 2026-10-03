import { z } from 'zod';
import { RECOMMENDATIONS } from './verdict.js';
import { CASE_DIRECTIONS, type CaseDirection, type CaseSection } from './cases.js';
import { PERPLEXITY_MODEL_IDS, PROVIDERS } from './models.js';
import { RATINGS, type Rating } from './data/ratings.js';

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
  sharesOutstanding:  z.number().nullable().optional().describe('Weighted-average shares from the prior fiscal year, on the same measure as sharesOutstandingAnnual (Piotroski F7)'),
  depreciation:       z.number().nullable().describe('Depreciation & amortization from the prior fiscal year (Beneish DEPI)'),
});
export type PrevYearSnapshot = z.infer<typeof PrevYearSnapshotSchema>;

export const EarningsSurpriseSchema = z.object({
  quarter:     z.string().describe('Period label from Yahoo Finance — relative, e.g. "-1q"'),
  endDate:     z.string().nullable().optional().describe('End of the fiscal quarter (YYYY-MM-DD); absent on payloads from before 2 October 2026'),
  epsEstimate: z.number().nullable().describe('Consensus analyst EPS estimate before the announcement'),
  epsActual:   z.number().nullable().describe('Actual reported EPS'),
  surprisePct: z.number().nullable().describe('Beat/miss as decimal (positive = beat, e.g. 0.079 = +7.9%)'),
});
export type EarningsSurprise = z.infer<typeof EarningsSurpriseSchema>;

export const QuarterlyRevenueSchema = z.object({
  endDate: z.string().describe('Quarter end date (YYYY-MM-DD)'),
  revenue: z.number().describe('Total revenue for the fiscal quarter'),
});
export type QuarterlyRevenue = z.infer<typeof QuarterlyRevenueSchema>;

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

/**
 * A contradiction found between fields of the same payload, or a coverage gap
 * that limits how far the numbers can be trusted. Produced by
 * `analysis/data-quality.ts` and surfaced to the model in the prompt, so a
 * verdict is never built on stale inputs without saying so.
 */
export const DataQualityWarningSchema = z.object({
  code:     z.string().describe('Stable machine-readable check id (e.g. "stale-fundamentals", "ebitda-below-ebit")'),
  severity: z.enum(['error', 'warn']).describe('"error" = the affected figures are unusable; "warn" = usable but qualify the conclusion'),
  fields:   z.array(z.string()).describe('StockFinancials field names this finding invalidates'),
  message:  z.string().describe('Human- and model-readable explanation, including the conflicting values'),
});
export type DataQualityWarning = z.infer<typeof DataQualityWarningSchema>;

export const StockFinancialsSchema = z.object({
  // ── Identity ────────────────────────────────────────────────────────────────
  symbol:      z.string().describe('Exchange ticker symbol as used by Yahoo Finance (e.g. AAPL, 0QW9.IL)'),
  companyName: z.string().describe('Full legal company name from Yahoo Finance price data'),
  price:       z.number().describe('Most recent regular market close price in USD (or local currency)'),
  marketCap:   z.number().describe('Total market capitalisation: shares outstanding × price'),
  tradingCurrency:   z.string().nullable().optional().describe('Currency of price/marketCap/analyst targets (the quote/trading currency, e.g. USD for an ADR)'),
  financialCurrency: z.string().nullable().optional().describe('Reporting currency of the financial statements (e.g. CNY). When it differs from tradingCurrency, all statement-sourced figures below are FX-converted into tradingCurrency so per-share models stay consistent.'),

  // ── Data provenance & quality ───────────────────────────────────────────────
  // How current Yahoo's market-side modules are for *this listing*. A secondary
  // line can serve a `financialData` block years out of date while the
  // statement series stay fresh, which makes every trailing ratio wrong in a
  // way no single field reveals — see `analysis/data-quality.ts`.
  mostRecentQuarter:   z.string().nullable().optional().describe('End date (YYYY-MM-DD) of the newest quarter Yahoo reports for this listing. Older than ~9 months means the market-side modules are stale and trailing ratios are unreliable.'),
  lastFiscalYearEnd:   z.string().nullable().optional().describe('End date (YYYY-MM-DD) of the newest fiscal year Yahoo reports for this listing'),
  fundamentalsStale:   z.boolean().optional().describe('True when mostRecentQuarter is old enough that revenue/EPS/margins/EV were taken from the annual statements instead of Yahoo financialData'),
  dataQualityWarnings: z.array(DataQualityWarningSchema).default([]).describe('Contradictions found between fields of this payload, plus coverage gaps. Empty for a clean payload.'),

  // ── Valuation ───────────────────────────────────────────────────────────────
  peRatio:   z.number().nullable().describe('Trailing 12-month P/E ratio (price / EPS TTM)'),
  forwardPE: z.number().nullable().describe('Forward P/E ratio based on next-12-month consensus EPS estimate'),
  avgPE5Y:   z.number().nullable().describe('Simple average of trailing P/E at fiscal year-end for each of the last 3-4 profitable years (loss years excluded)'),
  pegRatio:  z.number().nullable().describe('Price/Earnings-to-Growth ratio: P/E divided by expected earnings growth rate'),
  eps:       z.number().nullable().describe('Trailing 12-month earnings per share (diluted)'),
  bookValue: z.number().nullable().describe('Book value per share: common equity on the newest balance sheet ÷ sharesOutstanding, in the unit the price is quoted per'),

  // ── Profitability ───────────────────────────────────────────────────────────
  roe:              z.number().nullable().describe('Return on equity (decimal): net income / average shareholders equity TTM'),
  roa:              z.number().nullable().describe('Return on assets (decimal): net income / average total assets TTM'),
  operatingMargin:  z.number().nullable().describe('Operating income as a fraction of revenue TTM (decimal, e.g. 0.30 = 30%)'),
  netMargin:        z.number().nullable().describe('Net income as a fraction of revenue TTM (decimal)'),
  revenueGrowth:    z.number().nullable().describe('Revenue growth (decimal): the trailing four quarters against the four before them, else the two newest fiscal years. Before FINANCIALS_VERSION 21 this was Yahoo\'s latest-quarter-vs-year-ago rate'),
  revenueGrowthYoY: z.number().nullable().describe('Alias of revenueGrowth; provided for consistency with SectorMedians field naming'),
  earningsGrowth:   z.number().nullable().describe('Net income growth (decimal) on the same basis as revenueGrowth; null when the base is not positive. Before FINANCIALS_VERSION 21 this was Yahoo\'s single-quarter rate, which read 294 % on a revaluation gain'),

  // ── Cash & Liquidity ────────────────────────────────────────────────────────
  freeCashFlow:      z.number().nullable().describe('Free cash flow as the statements define it — operating cash flow less capex — summed over the last four quarters, else the newest fiscal year; FX-converted into the trading currency. Before FINANCIALS_VERSION 21 (no trailingSource) this was Yahoo\'s levered free cash flow, a different figure'),
  operatingCashFlow: z.number().nullable().describe('Operating cash flow over the last four quarters, else Yahoo financialData'),
  totalCash:         z.number().nullable().describe('Total cash, cash equivalents and short-term investments on the balance sheet'),
  totalDebt:         z.number().nullable().describe('Total debt including lease obligations (short-term + long-term), as Yahoo reports it'),
  longTermDebt:      z.number().nullable().describe('Long-term debt only (excludes current portion), used in Piotroski F5 and Altman Z'),
  debtToEquity:      z.number().nullable().describe('Total debt divided by shareholders equity (ratio; Yahoo supplies percent, divided by 100 from FINANCIALS_VERSION 21)'),
  currentRatio:      z.number().nullable().describe('Current assets / current liabilities; liquidity indicator (Piotroski F6)'),
  quickRatio:        z.number().nullable().describe('(Current assets − inventory) / current liabilities; stricter liquidity measure'),
  deferredRevenueShare: z.number().nullable().describe('Current deferred revenue / current liabilities, latest annual balance sheet (decimal). Prepaid subscriptions sit in current liabilities without being cash owed, so a high share makes the current ratio understate liquidity'),

  // ── Income Statement (trailing twelve months unless noted) ──────────────────
  revenue:          z.number().nullable().describe('Total revenue over the trailing twelve months (Yahoo financialData, equal to the last four quarters)'),
  grossProfit:      z.number().nullable().describe('Gross profit over the trailing twelve months'),
  ebit:             z.number().nullable().describe('Operating income over the last four quarters, else the newest fiscal year. Never Yahoo\'s EBIT line, which is pretax income plus interest and so carries investment gains (payloads before FINANCIALS_VERSION 21 did read that line, from the newest fiscal year)'),
  netIncome:        z.number().nullable().describe('Net income attributable to common shareholders over the trailing twelve months'),
  normalizedNetIncome: z.number().nullable().optional().describe('Net income excluding unusual items (Yahoo normalizedIncome) over the last four quarters, else the newest fiscal year — the earnings the per-share models capitalise'),
  ebitda:           z.number().nullable().describe('Operating income plus depreciation and amortisation over the last four quarters, else Yahoo financialData'),
  interestExpense:  z.number().nullable().describe('Interest expense over the last four quarters, else the newest fiscal year (interest coverage, synthetic rating)'),
  incomeTaxExpense: z.number().nullable().describe('Income tax provision from the latest annual period'),
  incomeBeforeTax:  z.number().nullable().describe('Pre-tax income from the latest annual period'),
  taxRate:          z.number().nullable().describe('Effective tax rate over the newest three fiscal years together (Σ tax ÷ Σ pretax income), clamped to 0–35 %; used in EPV and DCF'),

  // ── Balance Sheet (annual, latest) ──────────────────────────────────────────
  totalAssets:             z.number().nullable().describe('Total assets from the latest annual balance sheet (Altman Z, Beneish)'),
  totalCurrentAssets:      z.number().nullable().describe('Current assets from the latest annual balance sheet'),
  totalCurrentLiabilities: z.number().nullable().describe('Current liabilities from the latest annual balance sheet'),
  totalLiabilities:        z.number().nullable().describe('Total liabilities from the latest annual balance sheet'),
  retainedEarnings:        z.number().nullable().describe('Accumulated retained earnings from the latest balance sheet (Altman Z X2)'),
  workingCapital:          z.number().nullable().describe('Current assets minus current liabilities (Altman Z X1 numerator)'),

  // ── Cash Flow (annual, latest) ───────────────────────────────────────────────
  operatingCashFlowAnnual: z.number().nullable().describe('Operating cash flow from the latest annual cash flow statement (Beneish TATA)'),
  interestInOperatingCashFlow: z.boolean().nullable().optional().describe('Whether interest paid sits inside operating cash flow — always under US GAAP, by choice under IFRS. Decides whether free cash flow is after interest, and so whether the DCF adds after-tax interest back to reach FCFF. Null when the statement does not say'),
  sharesOutstandingAnnual: z.number().nullable().optional().describe('Weighted-average shares for the latest fiscal year — diluted where both years report it, basic otherwise (Piotroski F7)'),
  capex:                   z.number().nullable().describe('Capital expenditure (absolute value) over the last four quarters, else the newest fiscal year'),
  depreciation:            z.number().nullable().describe('Depreciation & amortisation from the latest annual cash flow statement (Beneish DEPI)'),
  stockBasedCompensation:  z.number().nullable().optional().describe('Stock-based compensation over the last four quarters, else the newest fiscal year — a real cost operating cash flow adds back'),
  trailingSource:          z.enum(['quarters', 'annual']).optional().describe('Where freeCashFlow and ebit came from: summed quarters, or the newest fiscal year where the quarters are incomplete. Absent before FINANCIALS_VERSION 21, whose freeCashFlow is Yahoo\'s levered figure and whose ebit is the annual EBIT line'),

  // ── Equity bridge (newest balance sheet) ──────────────────────────────────────
  minorityInterest:   z.number().nullable().optional().describe('Non-controlling interests: equity in consolidated subsidiaries that belongs to others, subtracted on the way from firm value to the common shareholders'),
  preferredEquity:    z.number().nullable().optional().describe('Preferred stock, a claim senior to the common shareholders'),
  nonOperatingAssets: z.number().nullable().optional().describe('Investments the operating income does not earn on: non-current marketable securities and stakes carried at cost or by the equity method (Yahoo investmentsAndAdvances)'),
  leaseObligations:   z.number().nullable().optional().describe('Lease liabilities included in totalDebt (Yahoo capitalLeaseObligations)'),
  operatingLeaseLiabilities: z.number().nullable().optional().describe('Operating lease liabilities reported to the SEC (us-gaap:OperatingLeaseLiability) — under US GAAP their cost already sits in operating income and operating cash flow, so the part of totalDebt they make up is not debt the cash flows are before'),
  investedCapital:    z.number().nullable().optional().describe('Invested capital on the newest balance sheet (Yahoo: debt plus equity)'),
  tangibleBookValue:  z.number().nullable().optional().describe('Tangible book value (common equity less goodwill and intangibles) on the newest balance sheet, total'),
  dilutedShareRatio:  z.number().nullable().optional().describe('Diluted over basic weighted-average shares for the newest fiscal year (≥ 1): what options, RSUs and convertibles add to the count the price is quoted against'),

  // ── EV & Multiples ──────────────────────────────────────────────────────────
  enterpriseValue:   z.number().nullable().describe('Enterprise value: market cap + total debt − cash (from Yahoo defaultKeyStatistics)'),
  sharesOutstanding: z.number().nullable().describe('Shares the market cap is spread over, in the unit the price is quoted per: market cap ÷ price, so every share class and ADR units for an ADR. Before FINANCIALS_VERSION 21 this was Yahoo\'s count of one share class'),
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
  beta:             z.number().nullable().describe('5-year monthly beta relative to the S&P 500 (market sensitivity; the CAPM cost of equity in DCF, DDM, EPV and RIM)'),
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
  country:      z.string().nullable().optional().describe('Country of the headquarters from Yahoo assetProfile — the country risk premium is read for it'),

  // ── Country risk (Damodaran's table, relative to the United States) ─────────
  countryRiskPremium:    z.number().nullable().optional().describe('Equity risk premium the headquarters country carries over the United States (decimal; slightly negative for Aaa countries) — added to the implied ERP, which is measured on the S&P 500'),
  countryDefaultSpread:  z.number().nullable().optional().describe('Sovereign default spread of the headquarters country over the United States (decimal, ≥ 0) — added to the cost of debt'),
  marginalTaxRate:       z.number().nullable().optional().describe('Marginal corporate tax rate of the headquarters country (decimal) — the rate a mature business converges to in the DCF'),
  currencyDefaultSpread: z.number().nullable().optional().describe('Default spread of the government whose yield is the risk-free rate for the trading currency, over the United States (decimal, ≥ 0) — taken out of that yield before it is called risk-free'),

  // ── Finnhub-enriched ─────────────────────────────────────────────────────────
  roic:                z.number().nullable().describe('Return on invested capital for the latest fiscal year (decimal), from Finnhub series.annual.roic; caps the DCF terminal ROIC together with the peer median'),
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

  // ── Multi-year fundamentals history (≤5y annual, oldest first) ──────────────
  fundamentalsHistory: z.object({
    revenue:           z.array(z.object({ year: z.number(), value: z.number() })),
    grossProfit:       z.array(z.object({ year: z.number(), value: z.number() })),
    operatingIncome:   z.array(z.object({ year: z.number(), value: z.number() })),
    netIncome:         z.array(z.object({ year: z.number(), value: z.number() })),
    normalizedIncome:  z.array(z.object({ year: z.number(), value: z.number() })).optional(),
    eps:               z.array(z.object({ year: z.number(), value: z.number() })),
    freeCashFlow:      z.array(z.object({ year: z.number(), value: z.number() })),
    operatingCashFlow: z.array(z.object({ year: z.number(), value: z.number() })),
    totalAssets:       z.array(z.object({ year: z.number(), value: z.number() })),
    stockholdersEquity:z.array(z.object({ year: z.number(), value: z.number() })),
  }).describe('Last ~5 fiscal years of headline metrics for trend charts'),

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

  // ── Quarterly Revenue (run-rate basis for Simple Valuation Ratio) ────────────
  quarterlyRevenues: z.array(QuarterlyRevenueSchema).describe('Last ≤8 fiscal quarters of total revenue, oldest first. The most recent quarter × 4 is the SVR (run-rate P/S) denominator — more responsive to YoY changes than TTM P/S'),

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

/** Where the price sits on its own recent path (`analysis/timing.ts`). Candidates; none of them scores. */
export const TimingReadingsSchema = z.object({
  m1:           z.number().describe('Return over the last 21 sessions (decimal)'),
  rsi14:        z.number().nullable().describe('14-day Wilder RSI over the last year of closes (0–100)'),
  distSma50:    z.number().nullable().describe('ln(price / SMA50); negative = below the line'),
  distSma200:   z.number().nullable().describe('ln(price / SMA200); negative = below the line'),
  channelZ:     z.number().nullable().describe('Last log close against the 63-session trend line, in residual standard deviations; −2 = lower edge'),
  channelSlope: z.number().nullable().describe('That trend line\'s slope, annualised log return'),
  fromLow126:   z.number().describe('ln(price / lowest close of the last 126 sessions); 0 = at the low'),
  lowAgo:       z.number().describe('Sessions since that low'),
  atr14:        z.number().nullable().describe('Mean absolute close-to-close move over 14 sessions, as a share of the price: a close-only ATR. Null in readings stored before it existed'),
  fromHigh252:  z.number().nullable().describe('ln(price / highest close of the last 252 sessions); 0 = at the high. Null in readings stored before it existed'),
});
export type TimingReadings = z.infer<typeof TimingReadingsSchema>;

export const TechnicalIndicatorsSchema = z.object({
  returns:           TechnicalReturnsSchema.describe('Trailing total returns over standard horizons'),
  // Moving averages — full ladder for the technicals gauge
  sma10:             z.number().nullable().describe('10-day SMA'),
  sma20:             z.number().nullable().describe('20-day SMA'),
  sma30:             z.number().nullable().describe('30-day SMA'),
  sma50:             z.number().nullable().describe('50-day SMA'),
  sma100:            z.number().nullable().describe('100-day SMA'),
  sma200:            z.number().nullable().describe('200-day SMA'),
  ema10:             z.number().nullable().describe('10-day EMA'),
  ema20:             z.number().nullable().describe('20-day EMA'),
  ema30:             z.number().nullable().describe('30-day EMA'),
  ema50:             z.number().nullable().describe('50-day EMA'),
  ema100:            z.number().nullable().describe('100-day EMA'),
  ema200:            z.number().nullable().describe('200-day EMA'),
  distFromSMA50Pct:  z.number().nullable().describe('(price − SMA50) / SMA50 (decimal); positive = above the average'),
  distFromSMA200Pct: z.number().nullable().describe('(price − SMA200) / SMA200 (decimal); positive = above the average'),
  goldenCross:       z.boolean().nullable().describe('True when SMA50 > SMA200 (medium-term uptrend)'),
  rsi14:             z.number().nullable().describe('14-day Wilder RSI (0–100); >70 overbought, <30 oversold'),
  macdLine:          z.number().nullable().describe('MACD line (12-EMA − 26-EMA)'),
  macdSignal:        z.number().nullable().describe('MACD signal line (9-EMA of MACD)'),
  macdHistogram:     z.number().nullable().describe('MACD histogram (line − signal); sign indicates momentum direction'),
  stochK14:          z.number().nullable().describe('Stochastic %K (14, smoothed 3) — 0–100; >80 overbought, <20 oversold'),
  stochD14:          z.number().nullable().describe('Stochastic %D (SMA-3 of %K)'),
  williamsR14:       z.number().nullable().describe('Williams %R (14) — −100 to 0; ≤−80 oversold, ≥−20 overbought'),
  cci20:             z.number().nullable().describe('Commodity Channel Index (20); >100 overbought, <−100 oversold'),
  momentum10:        z.number().nullable().describe('Price momentum (latest close − close 10 sessions ago)'),
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
  timing:            TimingReadingsSchema.nullable().optional().describe('Entry-timing readings; absent in signals stored before they existed'),
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

// ─── Technical Signals (TradingView-style aggregate) ─────────────────────────

export const SignalDirectionSchema = z.enum(['buy', 'sell', 'neutral']);
export type SignalDirection = z.infer<typeof SignalDirectionSchema>;

export const SignalItemSchema = z.object({
  name:      z.string().describe('Indicator name (e.g. "RSI 14", "EMA 50")'),
  value:     z.number().nullable().describe('Numeric value of the indicator'),
  signal:    SignalDirectionSchema,
  hint:      z.string().describe('Why this indicator votes the way it does (e.g. "RSI 72 > 70 → overbought")'),
});
export type SignalItem = z.infer<typeof SignalItemSchema>;

export const SignalGroupSchema = z.object({
  items:   z.array(SignalItemSchema),
  buy:     z.number().describe('Number of indicators voting buy'),
  sell:    z.number().describe('Number voting sell'),
  neutral: z.number().describe('Number voting neutral'),
  score:   z.number().describe('(buy − sell) / total — range −1 (Strong Sell) to +1 (Strong Buy)'),
  verdict: z.enum(['STRONG BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG SELL']),
});
export type SignalGroup = z.infer<typeof SignalGroupSchema>;

export const TechnicalSignalsSchema = z.object({
  movingAverages: SignalGroupSchema,
  oscillators:    SignalGroupSchema,
  overall:        SignalGroupSchema,
});
export type TechnicalSignals = z.infer<typeof TechnicalSignalsSchema>;

// ─── Result Types ─────────────────────────────────────────────────────────────

export const DcfDistributionSchema = z.object({
  p10: z.number().describe('10th percentile of value per share across the simulation'),
  p25: z.number().describe('25th percentile'),
  p50: z.number().describe('Median value per share across the simulation'),
  p75: z.number().describe('75th percentile'),
  p90: z.number().describe('90th percentile'),
  probabilityAbovePrice: z.number().describe('Share of the simulated values above the current price (0–1) — what the valuation pillar reads'),
  draws: z.number().describe('Simulated draws the percentiles are taken over'),
});
export type DcfDistribution = z.infer<typeof DcfDistributionSchema>;

export const DCFResultSchema = z.object({
  fairValue:          z.number().nullable().describe('Base-case value per share: ten years of free cash flow to the firm built from revenue, operating margin, tax and reinvestment, plus a terminal value, discounted mid-year at WACC and bridged to equity; null for banks, insurers, brokers and lenders, and for firms with no margin to converge to'),
  fairValueBear:      z.number().nullable().describe('10th percentile of the simulated values per share'),
  fairValueBull:      z.number().nullable().describe('90th percentile of the simulated values per share'),
  distribution:       DcfDistributionSchema.nullable().describe('The value per share under 512 deterministic draws of growth, target margin, sales-to-capital, discount rate and terminal growth'),
  discountRate:       z.number().nullable().describe('WACC for the first five years: E/V·(CAPM cost of equity) + D/V·kd·(1 − marginal tax)'),
  terminalDiscountRate: z.number().nullable().describe('WACC the rate converges to by year ten: the same capital structure at beta 1 — a mature firm'),
  costOfDebt:         z.number().nullable().describe('Pre-tax cost of debt kd (decimal): risk-free rate + the live ICE BofA spread for the synthetic rating + the headquarters country\'s default spread; null for debt-free firms'),
  syntheticRating:    z.enum(RATINGS as [Rating, ...Rating[]]).nullable().describe("Rating bucket the firm's interest coverage (operating income ÷ interest) earns on Damodaran's table; null when unrated (priced as BBB) or debt-free"),
  beta:               z.number().nullable().describe('Beta used for CAPM: two thirds the regression beta, one third the peers\' median beta (else 1), bounded to 0.8–2.0'),
  riskFreeRate:       z.number().describe("Risk-free rate used (decimal): the ten-year government yield in the stock's trading currency, the Treasury for dollars"),
  equityRiskPremium:  z.number().describe("Equity risk premium used (decimal): Damodaran's implied ERP for the latest month plus the model's adjustment"),
  premiumAdjustment:  z.number().nullable().optional().describe('What the model adds to the market\'s implied premium so that it prices the typical universe stock at its price (decimal; negative where the model\'s cash flows are more conservative than the market\'s)'),
  countryRiskPremium: z.number().nullable().describe('Premium the headquarters country adds over the United States (decimal)'),
  revenueBase:        z.number().nullable().describe('Trailing twelve-month revenue the forecast starts from'),
  growthYear1:        z.number().nullable().describe('Revenue growth in year one (decimal): consensus for the current fiscal year, else trailing'),
  growthYear2:        z.number().nullable().describe('Revenue growth in year two (decimal): consensus for next fiscal year, else trailing; from year three it fades to terminal growth with a half-life of about two and a half years'),
  growthSource:       z.enum(['analyst consensus', 'trailing twelve months', 'steady state']).nullable().describe('Where the growth path starts from'),
  operatingMargin:    z.number().nullable().describe('Trailing operating margin the forecast starts from (decimal)'),
  targetMargin:       z.number().nullable().describe('Operating margin reached by year five and held (decimal): the highest of today\'s, the recent years\' average and the consensus-implied one, else halfway to the peer median'),
  targetMarginSource: z.enum(['current', 'own history', 'consensus', 'halfway to peers']).nullable().describe('Where the target margin comes from: today\'s, the recent years\' average, the margin next year\'s consensus earnings and revenue imply, or halfway to the peer median'),
  salesToCapital:     z.number().nullable().describe('Revenue added per unit of capital reinvested: growth is paid for at this rate'),
  salesToCapitalSource: z.enum(['history', 'balance sheet', 'default']).nullable().describe('How sales-to-capital was measured: revenue over operating capital (equity + debt − cash − investments), else the last years\' marginal ratio, else 1.5'),
  taxRate:            z.number().nullable().describe('Effective tax rate the forecast starts from (decimal)'),
  terminalTaxRate:    z.number().nullable().describe('Marginal rate it converges to by year ten (decimal)'),
  terminalGrowthRate: z.number().describe('Stable growth after year ten (decimal): the second-year growth rate, held between half and all of the risk-free rate, and at least two points below the terminal WACC'),
  terminalRoic:       z.number().nullable().describe('Return on new capital in perpetuity (decimal): target margin after tax × sales to capital, capped at own and peer ROIC, never below the terminal WACC'),
  terminalReinvestmentRate: z.number().nullable().describe('Share of terminal NOPAT reinvested to grow at the terminal rate: g ÷ terminal ROIC (decimal)'),
  forecastYears:      z.number().describe('Years forecast explicitly before the terminal value'),
  projectedFCFs:      z.array(z.number()).describe('Year-by-year free cash flow to the firm over the forecast'),
  terminalValue:      z.number().nullable().describe('Terminal value at the end of the forecast: NOPAT(n+1) × (1 − g ÷ ROIC) / (r − g)'),
  enterpriseValue:    z.number().nullable().describe('Present value of the forecast cash flows and the terminal value'),
  terminalShare:      z.number().nullable().describe('Share of enterprise value that sits in the terminal value (decimal)'),
  netDebt:            z.number().nullable().describe('What stands between firm value and the common shareholders: debt − cash − non-operating investments + minority interest + preferred equity'),
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

export const ImpliedMarginSchema = z.object({
  requiredMargin:   z.number().describe('The operating margin (decimal, pre-tax) the business has to settle at for today\'s price to be fair, on the DCF\'s own revenue path, reinvestment and discount rate'),
  achievableMargin: z.number().nullable().describe('The best operating margin already shown: today\'s, the recent years\' average, or the peer median (five peers or more)'),
  achievableBasis:  z.enum(['current', 'history', 'peers']).nullable().describe('Which of the three the achievable margin is'),
  ratio:            z.number().nullable().describe('Required ÷ achievable: 1 is priced for exactly what the business has shown'),
  revenueBase:      z.number().describe('Trailing revenue the path starts from'),
  revenueGrowth:    z.number().describe('Growth in the second forecast year (decimal), fading to terminal growth'),
  growthSource:     z.enum(['analyst consensus', 'trailing twelve months', 'steady state']).describe('Where the revenue growth came from'),
  discountRate:     z.number().describe('WACC used (decimal)'),
  interpretation:   z.string().describe('Plain-English verdict on how the required margin compares with the achievable one'),
});
export type ImpliedMargin = z.infer<typeof ImpliedMarginSchema>;

export const ReverseDCFResultSchema = z.object({
  impliedGrowthRate: z.number().nullable().describe('Revenue growth (years one and two, decimal) at which the forward DCF equals the current price, margin path held'),
  consensusGrowth:   z.number().nullable().describe('Consensus revenue growth for next fiscal year, for comparison; null without coverage'),
  discountRate:      z.number().nullable().describe('WACC used (decimal) — the forward DCF\'s own'),
  terminalGrowthRate: z.number().describe('Terminal growth rate assumption used (decimal)'),
  interpretation:    z.string().describe('Plain-English verdict on the implied growth'),
  isPossible:        z.boolean().describe('False when the growth solve has no answer'),
  impliedMargin:     ImpliedMarginSchema.nullable().describe('The margin the price requires — solvable for pre-profit firms, where the growth solve is not'),
});
export type ReverseDCFResult = z.infer<typeof ReverseDCFResultSchema>;

export const PeterLynchResultSchema = z.object({
  fairValue:            z.number().nullable().describe('Lynch fair value: normalised EPS × (growth + dividend yield) in percent — a P/E equal to growth plus yield; growth capped at 25 %, and the rule abstains below 5 %'),
  growthRate:           z.number().nullable().describe('Growth rate used (decimal): next-year consensus EPS growth, else the three-year EPS CAGR, capped at 25 %'),
  growthSource:         z.enum(['consensus', '3y CAGR']).nullable().describe('Where the growth rate came from'),
  isUndervalued:        z.boolean().nullable().describe('True when fairValue exceeds the current price'),
  marginOfSafety:       z.number().nullable().describe('(fairValue − price) / price'),
});
export type PeterLynchResult = z.infer<typeof PeterLynchResultSchema>;

export const EVMultiplesResultSchema = z.object({
  enterpriseValue:     z.number().nullable().describe('Enterprise value in the trading currency (statement figures are FX-converted upstream)'),
  evToEbitda:          z.number().nullable().describe('EV / EBITDA — most widely used EV multiple'),
  evToRevenue:         z.number().nullable().describe('EV / Revenue — useful for pre-profit or low-margin businesses'),
  evToFCF:             z.number().nullable().describe('EV / Free Cash Flow'),
  priceToFCF:          z.number().nullable().describe('Market cap / Free cash flow (equity-level FCF multiple)'),
  priceToSales:        z.number().nullable().describe('Trailing Market cap / Revenue (Price-to-Sales TTM)'),
  forwardPriceToSales: z.number().nullable().describe('Forward P/S: Market cap / consensus forward revenue (FY+1 if available, else FY+0); reveals NTM multiple compression for growth firms'),
  simpleValuationRatio: z.number().nullable().describe('Run-rate P/S = Market cap / (latest quarter revenue × 4). Drops the older 3 quarters from the TTM denominator so it reacts immediately to acceleration or deceleration; useful for sector peer comparison among fast-moving names. Caveat: noisy for highly seasonal businesses.'),
  seasonallyAdjustedValuationRatio: z.number().nullable().describe('SVR with the seasonal pattern divided out: Market cap / Σ(last 4 quarters, each grown by its age to the latest quarter\'s date at that quarter\'s YoY growth). Equals SVR when revenue grows steadily; null without 5 consecutive quarters'),
  seasonalGap:          z.number().nullable().describe('SVR / seasonally adjusted SVR − 1 (decimal). Negative: the latest quarter is a seasonal high or carries a one-off; positive: a seasonal low'),
  latestQuarterRevenue: z.number().nullable().describe('Most recent fiscal quarter revenue used as the SVR denominator (annualized × 4)'),
  latestQuarterEndDate: z.string().nullable().describe('End date of the quarter used for SVR (YYYY-MM-DD)'),
  latestQuarterYoYGrowth: z.number().nullable().describe('Latest quarter revenue against the same quarter a year earlier (decimal)'),
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
  f7_noNewShares:          z.boolean().nullable().describe('F7: weighted-average shares did not rise vs the prior fiscal year (diluted where both years report it)'),
  f8_improvingGrossMargin: z.boolean().nullable().describe('F8: Gross margin improved vs prior year'),
  f9_improvingAssetTurnover: z.boolean().nullable().describe('F9: Asset turnover (revenue / assets) improved vs prior year'),
});
export type PiotroskiSignals = z.infer<typeof PiotroskiSignalsSchema>;

export const PiotroskiResultSchema = z.object({
  score:          z.number().describe('Sum of all true Piotroski signals (0–9)'),
  maxScore:       z.number().describe('Signals computable from the available data (up to 9)'),
  signals:        PiotroskiSignalsSchema.describe('Individual boolean outcomes for each of the nine Piotroski criteria'),
  interpretation: z.enum(['strong', 'neutral', 'weak']).describe('strong = score ≥ 75% of computable signals; weak = score ≤ 33%; neutral otherwise'),
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
  fairValue:           z.number().nullable().describe('Two-stage dividend discount value per share: five years at the dividend\'s own growth, five fading to stable growth, Gordon\'s formula after; null without a dividend'),
  dividendPerShare:    z.number().nullable().describe('Annual dividend per share: price × dividendYield'),
  dividendGrowthRate:  z.number().nullable().describe('Dividend growth for the first five years (decimal): 5y dividend CAGR, else consensus EPS growth, else stable growth; bounded to 0–15 %. Fades to terminal growth over the next five'),
  terminalGrowthRate:  z.number().describe('Stable dividend growth after year ten (decimal), capped at the risk-free rate'),
  requiredReturn:      z.number().nullable().describe("CAPM required return: riskFreeRate + beta × Damodaran's implied equity risk premium (decimal)"),
  isApplicable:        z.boolean().describe('False when the stock pays no dividend'),
});
export type DDMResult = z.infer<typeof DDMResultSchema>;

export const SortinoResultSchema = z.object({
  ratio:              z.number().nullable().describe('Sortino ratio: (annualReturn − riskFreeRate) / downsideDeviation; null when fewer than 6 monthly returns are available'),
  annualReturn:       z.number().nullable().describe('Annualised arithmetic return from monthly price data (decimal)'),
  downsideDeviation:  z.number().nullable().describe('Annualised standard deviation of negative monthly excess returns only (decimal)'),
  riskFreeRate:       z.number().describe("Risk-free rate used as the MAR (decimal): the ten-year government yield in the stock's trading currency"),
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
  fairValue:       z.number().nullable().describe('Earnings Power Value per share (Greenwald method): NOPAT / discountRate, plus cash − debt bridge; null for banks, insurers and brokers'),
  normalizedEbit:  z.number().nullable().describe('Sustainable operating income: the average operating margin of the last five fiscal years × trailing revenue'),
  normalizedMargin: z.number().nullable().describe('That average operating margin (decimal)'),
  taxRate:         z.number().describe('Tax rate applied (decimal): the higher of the effective and the marginal rate — a no-growth steady state pays the statutory rate'),
  wacc:            z.number().describe('WACC used to capitalise NOPAT (decimal): E/V·CAPM-ke + D/V·kd·(1−tax), kd from the synthetic rating'),
  marginOfSafety:  z.number().nullable().describe('(fairValue − price) / price'),
});
export type EPVResult = z.infer<typeof EPVResultSchema>;

export const RIMResultSchema = z.object({
  fairValue:      z.number().nullable().describe('Excess return value per share: book value + the present value of returns above the cost of equity, ROE fading over ten years to the cost of equity plus half of today\'s excess, then a perpetuity'),
  costOfEquity:   z.number().describe('CAPM cost of equity used as required return (decimal)'),
  sustainableRoe: z.number().nullable().describe('Return on equity the model starts from: normalised earnings over common equity, averaged with the last three fiscal years (decimal)'),
  terminalRoe:    z.number().nullable().describe('Return on equity it settles at (decimal)'),
  excessReturn:   z.number().nullable().describe('Sustainable ROE minus cost of equity (decimal); positive = value-creating'),
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
  medianFairPrice: z.number().nullable().describe('Median fair price with one vote per fundamental priced (earnings, EBITDA, revenue, cash flow, book value); EV/Revenue and P/S share the revenue vote'),
  meanFairPrice:   z.number().nullable().describe('Mean of the same per-fundamental votes'),
  count:           z.number().describe('Number of multiples that produced a valid fair price'),
  peerCount:       z.number().optional().describe('Peers the medians came from; below five the model counts half in the composite'),
  marginOfSafety:  z.number().nullable().describe('(medianFairPrice − price) / price'),
});
export type PeerMultiplesResult = z.infer<typeof PeerMultiplesResultSchema>;

export const CompositeContributorSchema = z.object({
  name:      z.string().describe('Model name (e.g. "DCF (Revenue-Driven)", "Graham Revised V*", "Peer Multiples")'),
  fairValue: z.number().describe('Fair value contributed by this model'),
  weight:    z.number().optional().describe('How much this model counts in its tier\'s median: 1, or 0.5 for a known weakness (a DCF resting on its terminal value, a thin peer group, a rule of thumb)'),
});
export type CompositeContributor = z.infer<typeof CompositeContributorSchema>;

export const CompositeExclusionSchema = z.object({
  name:   z.string().describe('Model name that was excluded'),
  reason: z.string().describe('Why this model is not applicable for this stock'),
});
export type CompositeExclusion = z.infer<typeof CompositeExclusionSchema>;

export const CompositeTierSchema = z.object({
  median:         z.number().nullable().describe('Weighted median of the models\' log values across this tier — the geometric middle, where half and twice the price balance'),
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
   * Includes: DCF (Revenue-Driven) — or the excess return model for a lender — Peer Multiples median,
   * Peter Lynch, Analyst Consensus.
   */
  primary:      CompositeTierSchema,
  /**
   * Conservative tier — value-investor lens (no-growth or asset-based assumptions).
   * Includes: Graham Number, Graham Revised V*, EPV, the excess return model, the two-stage DDM. Shown as a
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
  runRatePriceToSales: z.number().nullable().describe('Median run-rate P/S of the peer group — each peer\'s P/S TTM divided by the run-rate factor at its latest-quarter YoY revenue growth (TTM YoY where Finnhub has no quarterly figure). The like-for-like benchmark for SVR'),
  pb:           z.number().nullable().describe('Median Price/Book of the peer group'),
  // Profitability
  operatingMargin:  z.number().nullable().describe('Median operating margin of the peer group (decimal)'),
  netMargin:        z.number().nullable().describe('Median net profit margin of the peer group (decimal)'),
  roe:              z.number().nullable().describe('Median return on equity of the peer group (decimal)'),
  roic:             z.number().nullable().describe('Median return on invested capital of the peer group (decimal)'),
  // Growth
  revenueGrowthYoY: z.number().nullable().describe('Median YoY revenue growth of the peer group TTM (decimal)'),
  // Risk
  beta:             z.number().nullable().optional().describe('Median five-year beta of the peers (Finnhub, against the S&P 500), from at least three of them — the prior a stock\'s own beta is shrunk towards'),
  peerCount: z.number().describe('Number of peers whose data was successfully fetched'),
  peers:     z.array(z.string()).describe('List of peer ticker symbols used to compute medians'),
  emptyGroup: z.boolean().optional().describe('True when Finnhub answered but no peer survived the filters (the company itself, shells a fiftieth of its size) — no peer group, as opposed to a failed fetch, and the current state until the next reading'),
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

/**
 * Per-provider trace of what a search engine actually returned for this run.
 * Stored alongside the LLM verdict so a user can inspect what context the model
 * was given. Captures both *external* providers (Tavily, Brave — full result
 * payloads) and *native* providers (Claude / OpenAI web search — only the
 * queries the LLM chose to issue; the URLs it ultimately fetched are processed
 * server-side by the LLM vendor and not exposed back via the SDK).
 */
export const SearchProviderTraceSchema = z.object({
  provider:  z.enum(['tavily', 'brave', 'claude-web-search', 'openai-web-search']),
  queries:   z.array(z.string()).describe('Queries issued against the provider'),
  results:   z.array(SearchResultSchema).describe('Raw results returned (empty for native providers — only queries are observable)'),
  fetchedAt: z.string().describe('ISO timestamp when this provider was queried'),
});
export type SearchProviderTrace = z.infer<typeof SearchProviderTraceSchema>;

export const SearchTraceSchema = z.object({
  providers: z.array(SearchProviderTraceSchema).describe('One entry per search provider that ran for this analysis'),
});
export type SearchTrace = z.infer<typeof SearchTraceSchema>;

// ─── Deterministic factor score ──────────────────────────────────────────────

/**
 * The recommendation vocabulary and the bands that produce it live in
 * `src/verdict.ts`, which is dependency-free so the web app can import them as
 * values. Re-exported here because this is where the rest of the codebase looks
 * for a domain type.
 */
export { RECOMMENDATIONS } from './verdict.js';
export type { Recommendation } from './verdict.js';

/**
 * The pillars the deterministic score is built from. Order is display order.
 *
 * Declared here rather than in `analysis/score.ts` because the metric catalogue
 * needs them to turn `factor.pillars` into one series per pillar, and a schema
 * importing from the analysis layer would close a cycle. The scorer imports
 * this; nothing imports the scorer.
 */
export const PILLAR_KEYS = [
  'valuation', 'quality', 'health', 'consensus', 'momentum', 'revisions',
] as const;
export type PillarKey = (typeof PILLAR_KEYS)[number];

export const ScoreCriterionSchema = z.object({
  key:    z.string().describe('Stable identifier of this criterion within its pillar'),
  label:  z.string().describe('Human label, German — shown in the UI breakdown'),
  points: z.number().nullable().describe('0–1 after the ramp; null when the underlying input was missing'),
  weight: z.number().describe('Weight inside its pillar, before renormalising over missing siblings'),
  note:   z.string().describe('One line naming the actual figures behind the points'),
  impact: z.number().nullable().describe('Signed contribution to the raw score in points; all impacts sum to raw − 5'),
  value:  z.number().nullable().optional().describe('The figure the points were read from (a probability, a ratio, a margin) — what the calibration collects to find the criterion\'s neutral point'),
});
export type ScoreCriterion = z.infer<typeof ScoreCriterionSchema>;

export const ScorePillarSchema = z.object({
  key:      z.enum(PILLAR_KEYS).describe('Pillar identifier'),
  label:    z.string().describe('Human label, German'),
  score:    z.number().nullable().describe('0–10 weighted mean of the criteria that scored; null when none did'),
  weight:   z.number().describe('Configured weight of this pillar before dropping unscored ones'),
  effectiveWeight: z.number().describe('Weight after renormalising over the pillars that did score'),
  coverage: z.number().describe('Share of this pillar’s criterion weight that had data (0–1)'),
  criteria: z.array(ScoreCriterionSchema).describe('Every criterion considered, scored or not'),
});
export type ScorePillar = z.infer<typeof ScorePillarSchema>;

export const ScoreCapSchema = z.object({
  limit:  z.enum(['no-strong', 'hold-ceiling']).describe('no-strong forbids the STRONG labels; hold-ceiling also forbids BUY'),
  reason: z.string().describe('Why conviction is capped — shown verbatim to the reader'),
});
export type ScoreCap = z.infer<typeof ScoreCapSchema>;

export const ScoreFindingSchema = z.object({
  kind:   z.enum(['driver', 'drag', 'cap', 'divergence', 'gap']).describe('driver/drag move the score; divergence, cap and gap are context the criteria cannot express'),
  pillar: z.enum(PILLAR_KEYS).nullable().describe('Pillar this came from, null for cross-cutting findings'),
  note:   z.string().describe('The finding in one line, with its figures'),
  impact: z.number().describe('Signed score points for drivers and drags; 0 for the other kinds'),
});
export type ScoreFinding = z.infer<typeof ScoreFindingSchema>;

export const FactorScoreSchema = z.object({
  score:      z.number().describe('0–10 after shrinking toward neutral by confidence — the deterministic headline'),
  raw:        z.number().describe('0–10 before shrinking: what the pillars said on their own'),
  verdict:    z.enum(RECOMMENDATIONS).describe('Band of `score`, after the conviction caps'),
  uncappedVerdict: z.enum(RECOMMENDATIONS).describe('Band of `score` before the caps; equal to verdict when none bit'),
  confidence: z.number().describe('0–1: how much of the intended evidence was present and trustworthy'),
  coverage:   z.number().describe('0–1: share of configured pillar weight that produced a score'),
  shrink:     z.number().describe('Trust multiplier on (raw − 5): 0.4 + 0.6 × confidence'),
  agreement:  z.number().describe('0–1: |Σ w·dev| / Σ w·|dev| — 1 when every pillar points the same way, 0 when they cancel'),
  conviction: z.number().describe('Corroboration multiplier on (raw − 5), from agreement; 1 when fewer than three pillars scored'),
  pillars:    z.array(ScorePillarSchema).describe('One entry per pillar, always all of them'),
  caps:       z.array(ScoreCapSchema).describe('Conviction ceilings that applied'),
  findings:   z.array(ScoreFindingSchema).describe('The material rows — what a summary is allowed to talk about'),
});
export type FactorScore = z.infer<typeof FactorScoreSchema>;

/**
 * The dimensions of the qualitative read — what a business's trajectory is made
 * of, judged one at a time so no single headline can swing the whole score.
 */
export const NARRATIVE_DIMENSIONS = ['demand', 'position', 'execution', 'regulation', 'product'] as const;
export type NarrativeDimension = (typeof NARRATIVE_DIMENSIONS)[number];

const DimensionRatingSchema = z.object({
  rating: z.number().int().min(-2).max(2).nullable()
    .describe('−2 … +2 direction of this dimension as the sources describe it; null when the sources say nothing about it'),
  note:   z.string().default('').describe('One short clause naming the evidence behind the rating'),
});

export const NarrativeDimensionsSchema = z.object(
  Object.fromEntries(NARRATIVE_DIMENSIONS.map((d) => [d, DimensionRatingSchema.optional()])) as
    Record<NarrativeDimension, z.ZodOptional<typeof DimensionRatingSchema>>,
);
export type NarrativeDimensions = z.infer<typeof NarrativeDimensionsSchema>;

/**
 * The arguments in circulation, per side, as the valuation-blind reader found
 * them in Distill and Perplexity.
 *
 * The synthesis model sees the sources only through this stage, so without it
 * the debate in a Distill dossier reached the bull and bear case as one
 * sentence of a summary paragraph. Collected here, it arrives as arguments.
 */
export const NarrativeThesesSchema = z.object(
  Object.fromEntries(CASE_DIRECTIONS.map((d) => [d, z.array(z.string()).default([])])) as
    Record<CaseDirection, z.ZodDefault<z.ZodArray<z.ZodString>>>,
);
export type NarrativeTheses = z.infer<typeof NarrativeThesesSchema>;

/**
 * The qualitative half, scored from prose alone.
 *
 * Produced by a summariser that never sees a valuation model, so this number
 * cannot be the numbers wearing a different hat. When it disagrees with the
 * factor score, the disagreement is real information rather than an artefact of
 * one model weighing two kinds of evidence in one pass.
 */
export const NarrativeScoreSchema = z.object({
  summary:    z.string().describe('Short German synthesis of the qualitative sources'),
  events:     z.array(z.string()).describe('Concrete, dated developments the prose reports'),
  score:      z.number().min(0).max(10).nullable().describe('0–10 qualitative read; null when the sources carried nothing to judge'),
  confidence: z.number().min(0).max(1).describe('How much material there was to judge and how fresh, reduced when repeated reads disagree — drives the blend weight'),
  spread:     z.number().nullable().optional().describe('Highest minus lowest score across the repeated reads of the same prose; the narrative score is their median'),
  dimensions: NarrativeDimensionsSchema.optional().describe('The per-dimension ratings of the kept read; the score is 5 + 2.5 × their mean'),
  runs:       z.number().int().optional().describe('How many reads the narrative score was taken from'),
  theses:     NarrativeThesesSchema.optional().describe('The arguments for and against the company the sources make, as the kept read collected them — material for the bull and bear case, not for the score'),
  sources:    z.array(z.string()).describe('Which prose blocks were available (distill-company, distill-sector, perplexity, search)'),
  model:      z.string().describe('Model that produced this summary'),
  at:         z.string().describe('ISO timestamp of the read — a carried-forward narrative decays from here'),
});
export type NarrativeScore = z.infer<typeof NarrativeScoreSchema>;

/**
 * Where the two halves meet — in code, by confidence, not by a model's mood.
 *
 * The weights are the two confidences, so a flagged payload automatically hands
 * weight to the prose and a thin dossier automatically hands it back. The LLM's
 * own influence on the number is the bounded `adjustment`, which has to carry a
 * reason and cannot move the verdict by more than one band.
 */
export const FinalScoreSchema = z.object({
  score:            z.number().describe('0–10 headline: the confidence-weighted blend plus the bounded adjustment'),
  verdict:          z.enum(RECOMMENDATIONS).describe('Band of `score`, after re-applying the factor score’s caps'),
  blend:            z.number().describe('The blend before the adjustment'),
  factorWeight:     z.number().describe('Weight the deterministic score carried in the blend (0–1)'),
  narrativeWeight:  z.number().describe('Weight the narrative score carried in the blend (0–1)'),
  adjustment:       z.number().describe('Correction actually applied, in published score points: `score − blend`. Equals the requested one inside the STRONG bands, smaller towards the ends of the scale'),
  adjustmentRequested: z.number().optional().describe('Synthesis model’s correction as asked, bounded to ±1 and added before the ends of the scale are bent; the value a carried-forward card decays'),
  adjustmentReason: z.string().nullable().describe('Why the correction was applied; null when it was zero'),
});
export type FinalScore = z.infer<typeof FinalScoreSchema>;

export const ScoreCardSchema = z.object({
  factor:    FactorScoreSchema.describe('The deterministic half — pure arithmetic over stored data'),
  dataNote:  z.string().nullable().describe('Cheap model’s prose rendering of the factor findings; null when the step was skipped'),
  narrative: NarrativeScoreSchema.nullable().describe('The qualitative half; null when no prose sources were available'),
  final:     FinalScoreSchema.describe('How the two were combined'),
});
export type ScoreCard = z.infer<typeof ScoreCardSchema>;

// ─── LLM Output ───────────────────────────────────────────────────────────────

const CASE_SECTION_DESCRIPTION: Record<CaseSection, string> = {
  theses:   'The argument as the market has it — driver, what it does to the business, why it matters for the stock',
  figures:  'What the numbers say for this side: valuation, quality, growth, consensus, momentum',
  triggers: 'Observable conditions that would move the verdict in this side\'s direction',
};

/** One side of the case in sections — see `src/cases.ts` for why it is split. */
export const CaseSideSchema = z.object(
  Object.fromEntries(Object.entries(CASE_SECTION_DESCRIPTION).map(([k, d]) => [k, z.array(z.string()).describe(d)])) as
    Record<CaseSection, z.ZodArray<z.ZodString>>,
);

/**
 * A side as stored: sections today, a flat list until 2 October 2026, a single
 * paragraph in schema v3. Read through `readCases`, never by shape.
 */
const StoredCaseSchema = z.union([CaseSideSchema, z.array(z.string()), z.string()]);

export const LLMAnalysisSchema = z.object({
  bullCase:          StoredCaseSchema.describe('The bull case: theses, figures and the triggers that would raise the verdict'),
  bearCase:          StoredCaseSchema.describe('The bear case, risks included: theses, figures and the triggers that would lower the verdict'),
  keyRisks:          z.array(z.string()).optional().describe('Legacy: separate risk bullets from before 27 September. Risks now live in the bear case'),
  watch:             z.array(z.string()).optional().describe('Legacy: one list of triggers marked ↑/↓, from before 2 October. Triggers now live in their side of the case'),
  thesis:            z.string().describe('Single 1–2 sentence investment thesis summarising the overall view'),
  score:             z.number().min(0).max(10).describe('Overall investment attractiveness score from 0 (avoid) to 10 (strong conviction buy)'),
  recommendation:    z.enum(RECOMMENDATIONS).describe('Structured recommendation label'),
  fairValueEstimate: z.string().describe('LLM-synthesised fair value range as a string, in the stock\'s trading currency (e.g. "$120 – $145", "€95 – €110")'),
});
export type LLMAnalysis = z.infer<typeof LLMAnalysisSchema>;

/**
 * What each stage of the verdict pipeline is asked to return.
 *
 * Narrower than `LLMAnalysis` on purpose, and in the one field that matters:
 * none of them contains a score the model chose for the stock as a whole. The
 * data summariser gets no number at all, the narrative summariser scores only
 * the prose it was shown, and the synthesis model gets a bounded correction
 * with a reason attached. `LLMAnalysis` is assembled from these afterwards.
 *
 * Defaults are set where an omission is a plausible model slip rather than a
 * meaningful answer — a missing `events` list is an empty one, a missing
 * `adjustment` is zero. Everything else has to arrive or the call failed.
 */
export const DataSummaryOutputSchema = z.object({
  summary: z.string().describe('German prose rendering of the factor findings'),
});
export type DataSummaryOutput = z.infer<typeof DataSummaryOutputSchema>;

export const NarrativeOutputSchema = z.object({
  summary:    z.string().describe('German synthesis of the qualitative sources'),
  events:     z.array(z.string()).default([]).describe('Concrete dated developments the sources report'),
  theses:     NarrativeThesesSchema.default(() => NarrativeThesesSchema.parse({})).describe('Arguments for and against the company the sources make'),
  dimensions: NarrativeDimensionsSchema.describe('One rating per dimension; the score is computed from these in code'),
});
export type NarrativeOutput = z.infer<typeof NarrativeOutputSchema>;

/**
 * A side as the synthesis model writes it. The bounds are per section because
 * the sections do different jobs: a side with no thesis is the old table again,
 * a side with no figure has lost its anchor, and a trigger is welcome but not
 * owed. Generous at the top so one point too many does not cost the call.
 */
const CaseSideOutputSchema = z.object({
  theses:   z.array(z.string()).min(1).max(5),
  figures:  z.array(z.string()).min(1).max(4),
  triggers: z.array(z.string()).max(3).default([]),
} satisfies Record<CaseSection, z.ZodTypeAny>);

export const SynthesisOutputSchema = z.object({
  bullCase:          CaseSideOutputSchema,
  bearCase:          CaseSideOutputSchema,
  thesis:            z.string(),
  adjustment:        z.coerce.number().default(0).describe('Correction to the blended score in points; clamped to the configured limit before use'),
  adjustmentReason:  z.string().nullable().default(null).describe('Required whenever the adjustment is non-zero'),
});
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

// ─── Top-level Result & Options ───────────────────────────────────────────────

export const AnalysisResultSchema = z.object({
  symbol:          z.string().describe('Resolved Yahoo Finance ticker symbol'),
  timestamp:       z.string().describe('ISO 8601 timestamp of when the analysis was run'),
  provider:        z.string().describe('Actual model ID used for analysis (e.g. claude-sonnet-5-5, gpt-6.1-sol)'),
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
  scoreCard:       ScoreCardSchema.describe('Deterministic factor score, the narrative score, and the blend that produced the headline'),
  news:            z.array(NewsItemSchema).describe('Up to 10 recent news items from Finnhub'),
  perplexity:      z.object({
    model:     z.enum(PERPLEXITY_MODEL_IDS),
    synthesis: z.string(),
    citations: z.array(z.string()),
    fetchedAt: z.string(),
  }).nullable().optional(),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const AnalysisOptionsSchema = z.object({
  provider: z.enum(PROVIDERS).describe(`Resolved LLM provider (${PROVIDERS.join(' | ')})`),
  modelId:  z.string().describe('Actual model ID sent to the API (e.g. claude-sonnet-5-5, gpt-6.1-sol)'),
  search:   z.enum(['claude', 'openai', 'tavily', 'openai-tavily', 'brave', 'none']).describe('Web search mode; claude requires Claude provider, openai requires OpenAI provider'),
  cache:    z.boolean().describe('Whether to read/write the financial data file cache (TTL 1 hour, invalidated on schema version bump)'),
  output:   z.string().optional().describe('Output file path; .md produces Markdown, .json produces raw JSON'),
  verbose:  z.boolean().describe('Enable debug-level logging'),
});
export type AnalysisOptions = z.infer<typeof AnalysisOptionsSchema>;
