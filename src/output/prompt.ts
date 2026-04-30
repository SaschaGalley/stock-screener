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
  fmt,
  fmtPct,
  fmtBig,
} from '../analysis/metrics.js';
import { getNews } from '../data/finnhub.js';
import { SectorMedians, StockFinancials } from '../types.js';

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
  interestCoverage: ReturnType<typeof calculateInterestCoverage>;
  sortino: ReturnType<typeof calculateSortino>;
  beneish: ReturnType<typeof calculateBeneish>;
  sectorMedians: SectorMedians | null;
  news: Awaited<ReturnType<typeof getNews>>;
}

export function buildAnalysisPrompt(f: StockFinancials, d: PromptData): string {
  const newsBlock = d.news.length > 0
    ? d.news.slice(0, 5).map((n) => `- ${n.headline} (${n.source})`).join('\n')
    : 'No recent news available.';

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
- P/E: ${fmt(d.ratios.pe, 'x')} | Forward P/E: ${fmt(d.ratios.forwardPE, 'x')} | PEG: ${fmt(d.ratios.peg)}
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

### Intrinsic Value Models
- DCF Fair Value: $${d.dcf.fairValue.toFixed(2)} (range $${d.dcf.fairValueLow.toFixed(2)}–$${d.dcf.fairValueHigh.toFixed(2)})
- Reverse DCF: ${d.reverseDCF.isPossible && d.reverseDCF.impliedGrowthRate !== null ? `${(d.reverseDCF.impliedGrowthRate * 100).toFixed(1)}% FCF growth implied` : 'N/A'}
- Graham Number: ${d.grahamNumber.grahamNumber ? `$${d.grahamNumber.grahamNumber.toFixed(2)} (${fmtPct(d.grahamNumber.marginOfSafety)} MoS)` : 'N/A'}
- Graham Revised (V*): ${d.grahamRevised.fairValue ? `$${d.grahamRevised.fairValue.toFixed(2)} (${fmtPct(d.grahamRevised.marginOfSafety)} MoS)` : 'N/A'}
- Peter Lynch Fair Value: ${d.peterLynch.fairValue ? `$${d.peterLynch.fairValue.toFixed(2)}` : 'N/A'}
- EPV (Greenwald): ${d.epv.fairValue ? `$${d.epv.fairValue.toFixed(2)} (${fmtPct(d.epv.marginOfSafety)} MoS)` : 'N/A'}
- DDM: ${d.ddm.isApplicable && d.ddm.fairValue ? `$${d.ddm.fairValue.toFixed(2)}` : d.ddm.isApplicable ? 'Model constraint (g≥r)' : 'No dividend'}

### Quality Scores
- Piotroski F-Score: ${piotroskiLine}
- Altman Z-Score: ${altmanLine}
- Rule of 40: ${d.ruleOf40.score !== null ? `${d.ruleOf40.score.toFixed(1)} (${d.ruleOf40.passes ? 'PASSES ✓' : 'FAILS ✗'})` : 'N/A'}
- Sortino Ratio: ${d.sortino.ratio !== null ? `${d.sortino.ratio.toFixed(2)} (${d.sortino.interpretation}), annual return ${fmtPct(d.sortino.annualReturn)}, downside dev ${fmtPct(d.sortino.downsideDeviation)}` : 'N/A — insufficient price history'}
- Beneish M-Score: ${d.beneish.score !== null ? `${d.beneish.score.toFixed(2)} — ${d.beneish.probability} (${d.beneish.variablesComputed}/8 variables)` : 'N/A'}

### Recent News
${newsBlock}

---
Provide a comprehensive investment analysis as valid JSON.
Cite specific data points from the models above in your bull/bear cases.
Focus on: competitive moat, valuation vs. intrinsic value, growth quality, financial health.`;
}
