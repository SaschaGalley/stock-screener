import {
  calculateDCF,
  calculateGraham,
  calculateRatios,
  calculateReverseDCF,
  calculatePeterLynch,
  calculateEVMultiples,
  calculateRuleOf40,
  calculateGrahamRevised,
  calculatePiotroski,
  calculateAltmanZ,
  calculateDDM,
  calculateEPV,
  calculateInterestCoverage,
  calculateSortino,
  calculateBeneish,
  calculateRIM,
  calculateNCAV,
  calculatePeerMultiples,
  calculateCompositeFairValue,
  fmt,
  fmtPct,
  fmtBig,
} from '../analysis/metrics.js';
import { getNews } from '../data/finnhub.js';
import { MarketSignals, SectorMedians, StockFinancials } from '../types.js';
import { PerplexityContext } from '../data/perplexity.js';

export interface PromptData {
  dcf: ReturnType<typeof calculateDCF>;
  grahamNumber: ReturnType<typeof calculateGraham>;
  ratios: ReturnType<typeof calculateRatios>;
  reverseDCF: ReturnType<typeof calculateReverseDCF>;
  peterLynch: ReturnType<typeof calculatePeterLynch>;
  evMultiples: ReturnType<typeof calculateEVMultiples>;
  ruleOf40: ReturnType<typeof calculateRuleOf40>;
  grahamRevised: ReturnType<typeof calculateGrahamRevised>;
  piotroski: ReturnType<typeof calculatePiotroski>;
  altmanZ: ReturnType<typeof calculateAltmanZ>;
  ddm: ReturnType<typeof calculateDDM>;
  epv: ReturnType<typeof calculateEPV>;
  rim: ReturnType<typeof calculateRIM>;
  ncav: ReturnType<typeof calculateNCAV>;
  peerMultiples: ReturnType<typeof calculatePeerMultiples>;
  composite: ReturnType<typeof calculateCompositeFairValue>;
  interestCoverage: ReturnType<typeof calculateInterestCoverage>;
  sortino: ReturnType<typeof calculateSortino>;
  beneish: ReturnType<typeof calculateBeneish>;
  sectorMedians: SectorMedians | null;
  news: Awaited<ReturnType<typeof getNews>>;
  marketSignals: MarketSignals;
}

// ─── Market-signal section helpers ───────────────────────────────────────────

function bps(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(0)}bps`;
}

function signedPct(n: number | null): string {
  if (n === null) return 'N/A';
  const v = n * 100;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function technicalsSection(s: MarketSignals): string {
  const t = s.technicals;
  const macdSign = t.macdHistogram === null ? 'N/A' : t.macdHistogram > 0 ? `bullish (+${t.macdHistogram.toFixed(2)})` : `bearish (${t.macdHistogram.toFixed(2)})`;
  const cross = t.goldenCross === null ? 'N/A' : t.goldenCross ? 'golden (SMA50 > SMA200)' : 'death (SMA50 < SMA200)';
  return `### Price Action & Technicals
- Returns: 1M ${signedPct(t.returns.m1)} | 3M ${signedPct(t.returns.m3)} | 6M ${signedPct(t.returns.m6)} | YTD ${signedPct(t.returns.ytd)} | 1Y ${signedPct(t.returns.y1)}
- Trend: SMA50 ${fmt(t.sma50)} (${signedPct(t.distFromSMA50Pct)} vs price) | SMA200 ${fmt(t.sma200)} (${signedPct(t.distFromSMA200Pct)}) | ${cross}
- Momentum: RSI14 ${fmt(t.rsi14, '', 1)} | MACD-Hist ${macdSign} | %B ${fmt(t.bollingerPercentB, '', 2)}
- Volatility: ATR14 ${fmtPct(t.atr14Pct)} of price | HV30 ${fmtPct(t.hv30)} | HV90 ${fmtPct(t.hv90)}
- Drawdown from 1Y high: ${fmtPct(t.drawdownFromHighPct)} | 52W position: ${fmtPct(t.position52WPct)}
- Volume: latest / 30d-avg = ${fmt(t.currentVolRatio, 'x', 2)}
- Relative Strength 3M: vs SPY ${signedPct(t.rsVsSPY3M)} | vs Sector ETF ${signedPct(t.rsVsSector3M)}`;
}

function revisionsSection(s: MarketSignals): string {
  const r = s.revisions;
  const PERIOD_LABEL: Record<string, string> = { '0q': 'Cur Qtr', '+1q': 'Nxt Qtr', '0y': 'Cur Year', '+1y': 'Nxt Year' };
  const lines = r.perPeriod.length > 0
    ? r.perPeriod.map((p) => {
        const label = PERIOD_LABEL[p.period] ?? p.period;
        const drift = p.epsChange30dPct !== null ? `${signedPct(p.epsChange30dPct)} drift 30d` : 'no drift';
        const net = p.netRevision30d !== null ? `net ${p.netRevision30d >= 0 ? '+' : ''}${p.netRevision30d} (30d up ${p.revisions.up30d ?? 0} / down ${p.revisions.down30d ?? 0})` : 'no revisions';
        return `- ${label}: estimate ${fmt(p.epsTrend.current)} (was ${fmt(p.epsTrend.ago30d)} 30d ago, ${fmt(p.epsTrend.ago90d)} 90d ago) — ${drift}; ${net}`;
      })
    : ['- No revision data available'];
  const moM = r.analystRatingMoMDelta
    ? `- Analyst rating MoM Δ: StrongBuy ${signSign(r.analystRatingMoMDelta.strongBuy)} | Buy ${signSign(r.analystRatingMoMDelta.buy)} | Hold ${signSign(r.analystRatingMoMDelta.hold)} | Sell ${signSign(r.analystRatingMoMDelta.sell)} | StrongSell ${signSign(r.analystRatingMoMDelta.strongSell)}`
    : '- Analyst rating MoM Δ: N/A';
  return `### Earnings Revisions Momentum
${lines.join('\n')}
${moM}`;
}

function signSign(n: number): string { return n > 0 ? `+${n}` : `${n}`; }

function optionsSection(s: MarketSignals): string {
  const o = s.options;
  if (!o) return `### Options Market Signals\n- No liquid options chain available`;
  const move = o.nextEarningsImpliedMove
    ? `${signedPct(o.nextEarningsImpliedMove.pct)} (expiry ${o.nextEarningsImpliedMove.expirationDate})`
    : 'N/A';
  return `### Options Market Signals
- ATM IV (~30d): ${fmtPct(o.ivAtm30d)}  |  IV / HV90: ${fmt(o.ivVsHv90Ratio, 'x', 2)}
- Put/Call Volume Ratio: ${fmt(o.putCallVolumeRatio, '', 2)}  |  P/C OI Ratio: ${fmt(o.putCallOIRatio, '', 2)}
- Implied Move at next earnings: ${move}`;
}

function macroSection(s: MarketSignals): string {
  const m = s.macro;
  return `### Macro Context
- VIX: ${fmt(m.vix, '', 1)} (${m.vixRegime})  |  SPY 3M: ${signedPct(m.spy3MReturn)}
- Yield curve 10Y-2Y: ${bps(m.yieldCurve2Y10Y)}  |  HY spread: ${bps(m.hySpreadBps)}
- DXY: ${fmt(m.dxyLevel, '', 1)} (3M ${signedPct(m.dxyChange3MPct)})
- Sector ETF: ${m.sectorEtfSymbol ?? 'unmapped'} 3M ${signedPct(m.sectorEtfReturn3M)}`;
}

export function buildAnalysisPrompt(f: StockFinancials, d: PromptData, perplexity?: PerplexityContext): string {

  const piotroskiLine = `${d.piotroski.score}/${d.piotroski.maxScore} (${d.piotroski.interpretation})`;
  const altmanLine = d.altmanZ.score !== null
    ? `${d.altmanZ.score.toFixed(2)} — ${d.altmanZ.zone} zone (${d.altmanZ.model} model)`
    : 'N/A';

  return `## Stock Analysis: ${f.symbol} — ${f.companyName}

### Market Overview
- Price: $${f.price.toFixed(2)} | Market Cap: ${fmtBig(f.marketCap)}
- Sector: ${f.sector ?? 'N/A'} / ${f.industry ?? 'N/A'}
- 52W Range: $${fmt(f.fiftyTwoWeekLow)} – $${fmt(f.fiftyTwoWeekHigh)}
- Beta: ${fmt(f.beta)}
- Analyst Price Target: ${f.targetMeanPrice ? `$${f.targetMeanPrice.toFixed(2)} avg` : 'N/A'}${f.analystTargetLow !== null && f.analystTargetHigh !== null ? ` | Range $${f.analystTargetLow}–$${f.analystTargetHigh}` : ''}${f.analystCount ? ` | ${f.analystCount} analysts` : ''}
- Analyst Ratings: ${[
    f.analystStrongBuy  ? `Strong Buy: ${f.analystStrongBuy}`  : '',
    f.analystBuy        ? `Buy: ${f.analystBuy}`               : '',
    f.analystHold       ? `Hold: ${f.analystHold}`             : '',
    f.analystSell       ? `Sell: ${f.analystSell}`             : '',
    f.analystStrongSell ? `Strong Sell: ${f.analystStrongSell}` : '',
  ].filter(Boolean).join(' | ') || 'N/A'}

### Traditional Valuation
- P/E: ${fmt(d.ratios.pe, 'x')} | Forward P/E: ${fmt(d.ratios.forwardPE, 'x')} | Avg P/E 5Y: ${fmt(f.avgPE5Y, 'x')} | PEG: ${fmt(d.ratios.peg)}
- P/B: ${fmt(d.ratios.pb, 'x')} | P/S: ${fmt(d.evMultiples.priceToSales, 'x')} | P/FCF: ${fmt(d.evMultiples.priceToFCF, 'x')}
- EV/EBITDA: ${fmt(d.evMultiples.evToEbitda, 'x')} | EV/Revenue: ${fmt(d.evMultiples.evToRevenue, 'x')}${d.sectorMedians ? `
- Peer medians (${d.sectorMedians.peerCount} cos): P/E ${fmt(d.sectorMedians.pe, 'x', 1)} | EV/EBITDA ${fmt(d.sectorMedians.evToEbitda, 'x', 1)} | EV/Revenue ${fmt(d.sectorMedians.evToRevenue, 'x', 1)} | P/FCF ${fmt(d.sectorMedians.priceToFCF, 'x', 1)} | P/B ${fmt(d.sectorMedians.pb, 'x', 1)}` : ''}

### Profitability & Growth
- ROE: ${fmtPct(d.ratios.roe)} | ROA: ${fmtPct(d.ratios.roa)} | ROIC: ${fmtPct(f.roic)}
- Operating Margin: ${fmtPct(f.operatingMargin)} | Net Margin: ${fmtPct(f.netMargin)}
- Revenue: ${fmtBig(f.revenue)} (${fmtPct(f.revenueGrowth)} growth)
- Earnings Growth TTM: ${fmtPct(f.earningsGrowth)} | EPS Growth 3Y: ${fmtPct(f.epsGrowth3Y)}
- FCF: ${fmtBig(f.freeCashFlow)} | EBITDA: ${fmtBig(f.ebitda)}

### Balance Sheet & Liquidity
- Cash: ${fmtBig(f.totalCash)} | Total Debt: ${fmtBig(f.totalDebt)}
- Current Ratio: ${fmt(f.currentRatio, 'x')} | Quick Ratio: ${fmt(f.quickRatio, 'x')}
- Debt/Equity: ${fmt(f.debtToEquity, 'x')} | Interest Coverage: ${d.interestCoverage.ratio !== null ? `${d.interestCoverage.ratio.toFixed(1)}x (${d.interestCoverage.interpretation})` : d.interestCoverage.interpretation}

### Composite Intrinsic Value (headline anchor)
- Median fair value across ${d.composite.contributingModels.length} applicable models: ${d.composite.median !== null ? `$${d.composite.median.toFixed(2)} (${fmtPct(d.composite.marginOfSafety)} MoS)` : 'N/A'}
- IQR (25–75%): ${d.composite.p25 !== null && d.composite.p75 !== null ? `$${d.composite.p25.toFixed(2)} – $${d.composite.p75.toFixed(2)}` : 'N/A'}  |  Min/Max: ${d.composite.min !== null && d.composite.max !== null ? `$${d.composite.min.toFixed(2)} / $${d.composite.max.toFixed(2)}` : 'N/A'}
- Confidence: ${d.composite.confidence}/10 (based on coverage, IQR tightness, and Beneish status)
- ${d.composite.pctModelsUndervalued !== null ? `${(d.composite.pctModelsUndervalued * 100).toFixed(0)}% of models indicate undervaluation` : ''}
- Contributing: ${d.composite.contributingModels.map((c) => `${c.name} $${c.fairValue.toFixed(2)}`).join(' | ') || 'none'}
- Excluded: ${d.composite.excludedModels.map((e) => `${e.name} (${e.reason})`).join(' | ') || 'none'}

### Single-Equation Intrinsic Value Models
- DCF (2-Stage FCFF): ${d.dcf.fairValue !== null
  ? `$${d.dcf.fairValue.toFixed(2)}` +
    (d.dcf.fairValueBear !== null && d.dcf.fairValueBull !== null
      ? ` [bear $${d.dcf.fairValueBear.toFixed(2)} – bull $${d.dcf.fairValueBull.toFixed(2)}]`
      : '') +
    ` · r=${(d.dcf.discountRate * 100).toFixed(1)}% (CAPM, β=${fmt(d.dcf.beta)}) · g_stage1=${(d.dcf.stage1Growth * 100).toFixed(1)}% fading to ${(d.dcf.terminalGrowthRate * 100).toFixed(1)}%`
  : `N/A — ${d.dcf.assumptions}`}
- Reverse DCF: ${d.reverseDCF.isPossible && d.reverseDCF.impliedGrowthRate !== null ? `${(d.reverseDCF.impliedGrowthRate * 100).toFixed(1)}%/yr stage-1 FCF growth implied at r=${(d.reverseDCF.discountRate * 100).toFixed(1)}%` : 'N/A'}
- Graham Number: ${d.grahamNumber.grahamNumber ? `$${d.grahamNumber.grahamNumber.toFixed(2)} (${fmtPct(d.grahamNumber.marginOfSafety)} MoS)` : 'N/A'}
- Graham Revised (V*): ${d.grahamRevised.fairValue ? `$${d.grahamRevised.fairValue.toFixed(2)} (${fmtPct(d.grahamRevised.marginOfSafety)} MoS, AAA yield ${(d.grahamRevised.bondYield * 100).toFixed(2)}%)` : 'N/A'}
- Peter Lynch Fair Value: ${d.peterLynch.fairValue ? `$${d.peterLynch.fairValue.toFixed(2)}` : 'N/A'}
- EPV (Greenwald): ${d.epv.fairValue ? `$${d.epv.fairValue.toFixed(2)} (${fmtPct(d.epv.marginOfSafety)} MoS, r=${(d.epv.wacc * 100).toFixed(1)}%)` : 'N/A'}
- Residual Income (RIM): ${d.rim.isApplicable && d.rim.fairValue ? `$${d.rim.fairValue.toFixed(2)} (${fmtPct(d.rim.marginOfSafety)} MoS, ROE−r excess ${fmtPct(d.rim.excessReturn)})` : 'N/A — requires positive book value and ROE'}
- DDM: ${d.ddm.isApplicable && d.ddm.fairValue ? `$${d.ddm.fairValue.toFixed(2)}` : d.ddm.isApplicable ? 'Model constraint (g≥r)' : 'No dividend'}
- Peer Multiples (median fair price across ${d.peerMultiples.count} multiples): ${d.peerMultiples.medianFairPrice ? `$${d.peerMultiples.medianFairPrice.toFixed(2)} (${fmtPct(d.peerMultiples.marginOfSafety)} MoS)` : 'N/A — no peer-group data'}
- NCAV (Graham floor): ${d.ncav.isApplicable && d.ncav.ncavPerShare !== null && d.ncav.buyThreshold !== null ? `$${d.ncav.ncavPerShare.toFixed(2)}/sh, buy below $${d.ncav.buyThreshold.toFixed(2)}` : 'N/A — current assets ≤ total liabilities (typical for healthy firms)'}

### Quality Scores
- Piotroski F-Score: ${piotroskiLine}
- Altman Z-Score: ${altmanLine}
- Rule of 40: ${d.ruleOf40.score !== null ? `${d.ruleOf40.score.toFixed(1)} (${d.ruleOf40.passes ? 'PASSES ✓' : 'FAILS ✗'})` : 'N/A'}
- Sortino Ratio: ${d.sortino.ratio !== null ? `${d.sortino.ratio.toFixed(2)} (${d.sortino.interpretation}), annual return ${fmtPct(d.sortino.annualReturn)}, downside dev ${fmtPct(d.sortino.downsideDeviation)}` : 'N/A — insufficient price history'}
- Beneish M-Score: ${d.beneish.score !== null ? `${d.beneish.score.toFixed(2)} — ${d.beneish.probability} (${d.beneish.variablesComputed}/8 variables)` : 'N/A'}

${technicalsSection(d.marketSignals)}

${revisionsSection(d.marketSignals)}

${optionsSection(d.marketSignals)}

${macroSection(d.marketSignals)}

### Earnings Surprises (last ≤4 quarters)
${f.earningsSurprises.length > 0
  ? f.earningsSurprises.map((q) =>
      `- ${q.quarter}: estimate $${q.epsEstimate?.toFixed(2) ?? 'N/A'} → actual $${q.epsActual?.toFixed(2) ?? 'N/A'} (${q.surprisePct !== null ? (q.surprisePct >= 0 ? '+' : '') + (q.surprisePct * 100).toFixed(1) + '% surprise' : 'N/A'})`
    ).join('\n')
  : '- No earnings history available'}

### Forward Earnings Estimates (analyst consensus)
${f.earningsEstimates.length > 0
  ? f.earningsEstimates.map((e) => {
      const label: Record<string, string> = { '0q': 'Current Qtr', '+1q': 'Next Qtr', '0y': 'Current Year', '+1y': 'Next Year' };
      const period = (label[e.period] ?? e.period) + (e.endDate ? ` (ends ${e.endDate})` : '');
      const eps = e.epsEstimate !== null ? `EPS $${e.epsEstimate.toFixed(2)}` : 'EPS N/A';
      const range = e.epsLow !== null && e.epsHigh !== null ? ` [$${e.epsLow.toFixed(2)}–$${e.epsHigh.toFixed(2)}]` : '';
      const epsGrowth = e.epsGrowth !== null ? ` (${e.epsGrowth >= 0 ? '+' : ''}${(e.epsGrowth * 100).toFixed(1)}% YoY)` : '';
      const rev = e.revenueEstimate !== null ? `  Rev ${fmtBig(e.revenueEstimate)}` : '';
      const revGrowth = e.revenueGrowth !== null ? ` (${e.revenueGrowth >= 0 ? '+' : ''}${(e.revenueGrowth * 100).toFixed(1)}% YoY)` : '';
      const analysts = e.numberOfAnalysts !== null ? `  ${e.numberOfAnalysts} analysts` : '';
      return `- ${period}: ${eps}${range}${epsGrowth}${rev}${revGrowth}${analysts}`;
    }).join('\n')
  : '- No forward estimates available'}

### Short Interest & Ownership
- Short % of Float: ${f.shortPercentOfFloat !== null ? (f.shortPercentOfFloat * 100).toFixed(1) + '%' : 'N/A'}  |  Days to Cover: ${f.shortRatio !== null ? f.shortRatio.toFixed(1) + ' days' : 'N/A'}
- Institutional Ownership: ${f.institutionsPercentHeld !== null ? (f.institutionsPercentHeld * 100).toFixed(1) + '%' : 'N/A'}  |  Insider Ownership: ${f.insidersPercentHeld !== null ? (f.insidersPercentHeld * 100).toFixed(1) + '%' : 'N/A'}
- Insider Activity (6M): ${(f.insiderBuyCount ?? 0) > 0 || (f.insiderSellCount ?? 0) > 0
  ? `${f.insiderBuyCount ?? 0} buys (+${f.insiderBuyShares?.toLocaleString() ?? 0} shares), ${f.insiderSellCount ?? 0} sells (-${f.insiderSellShares?.toLocaleString() ?? 0} shares)`
  : 'no recent transactions'}

### Key Dates
- Next Earnings: ${f.nextEarningsDate ?? 'unknown'}
- Ex-Dividend: ${f.exDividendDate ?? 'N/A'}  |  Pay Date: ${f.dividendPayDate ?? 'N/A'}
${perplexity ? `
### Additional Context from Perplexity Sonar (web-sourced — use where relevant, not authoritative)

${perplexity.synthesis}
` : ''}
---
Provide a comprehensive investment analysis as valid JSON matching this schema:
- "bullCase":  array of EXACTLY 3 short bullet points (each ~15–25 words). Each bullet must cite a specific concrete data point from the analysis above (e.g. "FCF growth 34% YoY accelerating, 5x peer median").
- "bearCase":  array of EXACTLY 3 short bullet points, same format.
- "keyRisks":  array of EXACTLY 3 risks, same format.
- "thesis":    one sentence summarising the overall view.
- "score":     0–10.
- "recommendation": "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL".
- "fairValueEstimate": price range as string (e.g. "$120–$145").

Bullet writing rules — Alphaspread-style:
- Lead with the strongest single fact, not setup or hedging.
- Cite a number (margin, growth, ratio, target) in every bullet.
- No filler verbs like "appears", "may", "could potentially". Be direct.
- Each bullet is independent — no "first … second … finally" connectors.

Focus on: competitive moat, valuation vs. intrinsic value, growth quality, financial health, technical posture (trend, RSI/MACD, relative strength), earnings-revision momentum, and macro context (VIX regime, yield curve, HY spreads) when material.`;
}
