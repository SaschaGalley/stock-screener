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
import { currencyPrefix, fmtPrice } from '../format.js';
import { MarketSignals, SectorMedians, StockFinancials } from '../types.js';
import { PerplexityContext } from '../data/perplexity.js';
import { DistillBundle, DistillDossierBlock, DistillInsight } from '../data/distill.js';

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

/**
 * Push an embedded document's headings below the heading that introduces it.
 *
 * The analysis prompt is one markdown document whose top level is
 * `## Stock Analysis: …`. A Distill briefing is its own document and rightly
 * heads its sections with `##` — but pasted in verbatim, `## Risks & Concerns`
 * becomes a *sibling of the whole analysis*, so the briefing's risks read as the
 * analysis's risks. Demoting keeps the briefing's internal structure intact and
 * subordinate, which is what the surrounding text ("weight this below the
 * quantitative models") depends on being true structurally as well as in prose.
 *
 * Fenced blocks are skipped: `#` inside one is content, not a heading.
 */
/**
 * How many raw insights a block is allowed to spend on the prompt.
 *
 * A company's own are worth the room. Its sector's are backdrop, there can be
 * two of them, and thirty days of raw industry chatter would outweigh the
 * company's entire dossier — so they are capped, newest kept.
 */
const INSIGHTS_IN_PROMPT: Record<DistillDossierBlock['kind'], number> = {
  company: 25,
  sector:  8,
};

/** `2026-08-27 · wired.com — Title: statement` */
function insightLine(i: DistillInsight): string {
  const when   = i.at ? i.at.slice(0, 10) : 'undated';
  const source = [i.sourceName, i.documentTitle].filter(Boolean).join(' — ');
  const body   = i.content.replace(/\s+/g, ' ').trim();
  return `- ${when}${source ? ` · ${source}` : ''}: ${body}`;
}

/**
 * The raw material a dossier does not reproduce.
 *
 * Two things the reader has to know and cannot infer. These are *unsynthesised*
 * — single statements that passed no editorial fold — so they do not carry the
 * weight the dossier prose does. And they are not simply "today": Distill
 * excludes by provenance, not by date, so a document that arrived late and
 * never made it into the window's text shows up here with its original date.
 * That is the same class of item that marks a dossier stale.
 */
function distillInsights(block: DistillDossierBlock): string {
  const all = block.insights?.items ?? [];
  if (all.length === 0) return '';

  const cap  = INSIGHTS_IN_PROMPT[block.kind];
  const kept = all.length > cap ? all.slice(-cap) : all;
  const more = block.insights?.truncated || kept.length < all.length;

  const heading = block.content?.trim()
    ? 'Raw source statements the dossier above does NOT reproduce'
    : 'No dossier has been built for this entity yet — the following raw source statements are all there is';

  return `
**${heading}** (${kept.length}, oldest first, dated by when the news is from rather than
when Distill saw it). Unsynthesised and unfiltered: weigh a single one as a single
source.${more ? ' More exist than are shown — absence here is not evidence of absence.' : ''}

${kept.map(insightLine).join('\n')}`;
}

/** One dossier block, headed by what it is *about* — see `distillDossierSection`. */
function distillBlock(block: DistillDossierBlock, symbol: string): string {
  const window = block.periodStart && block.periodEnd
    ? `Window ${block.periodStart.slice(0, 10)} to ${block.periodEnd.slice(0, 10)} (end exclusive)`
    : 'Window unknown';
  const built = block.builtAt ? ` · built ${block.builtAt.slice(0, 10)}` : '';

  const scope = block.kind === 'sector'
    ? `**Scope: the ${block.displayName} sector as a whole — NOT ${symbol}.** `
      + 'Use it as the backdrop the company is read against: what is true of the sector is not '
      + 'thereby true of this company, and a sector-level claim never becomes a company-level '
      + 'finding. Where the company diverges from its sector, that divergence is the signal.'
    : `**Scope: ${symbol} itself.**`;

  const prose = block.content?.trim()
    ? `\n${window}${built}${block.stale ? ' · marked stale upstream (a late document landed in a built tile; the window above still holds)' : ''}\n\n${demoteHeadings(block.content.trim(), 3)}`
    : '';

  return `#### ${block.kind === 'sector' ? 'Sector' : 'Company'} — ${block.displayName} (\`${block.ref}\`)

${scope}${prose}
${distillInsights(block)}`.trimEnd();
}

/**
 * Everything Distill has to say, as blocks that cannot be mistaken for each
 * other.
 *
 * The labelling is not decoration. A sector dossier read as company-specific is
 * the observed failure mode of this integration, so every block states its
 * scope before its prose, and the sector blocks say plainly that a sector-level
 * claim is not a company-level finding.
 *
 * The dossier window closes at the start of today by construction, so nothing
 * here covers the current day. The briefing block, when present, is the one
 * that does.
 */
export function distillDossierSection(symbol: string, distill?: DistillBundle): string {
  if (!distill) return '';

  // A block with no dossier text but with insights still carries material —
  // that is exactly the just-switched-on entity the paid briefing used to cover.
  const blocks = [distill.company, ...(distill.sectors ?? [])]
    .filter((b): b is DistillDossierBlock =>
      !!b && (!!b.content?.trim() || (b.insights?.items.length ?? 0) > 0));
  const briefing = distill.briefing;
  if (blocks.length === 0 && !briefing) return '';

  const briefingBlock = briefing
    ? `
#### Briefing — ${briefing.briefingTypeName} (${briefing.createdAt.slice(0, 10)}, ${briefing.insightCount} insights)

**Scope: ${symbol} itself.** Unlike the dossiers above this one *does* include today.

${demoteHeadings(briefing.body.trim(), 3)}`
    : '';

  return `
### Distill Dossiers (curated, multi-source — weight HIGHER than Perplexity / search)

Synthesised by Distill from a curated set of sources (vetted RSS, earnings
transcripts, sell-side research, expert commentary). Because the editorial
filtering happens upstream, treat these as your **strongest qualitative
signal** — stronger than raw search or Perplexity, second only to the
quantitative valuation models and analyst consensus. Where a dossier
contradicts the calculated models or the analyst consensus, surface the
divergence explicitly in the bull or bear case.

Each block states its scope. **Company and sector blocks are not
interchangeable**: a sector dossier describes the industry backdrop, and
nothing in it is a fact about ${symbol} unless a company block says so.

Each block carries two kinds of thing, and they do not weigh the same. The
**dossier** is Distill's synthesised 30-day picture and is the strong signal. The
**raw source statements** beneath it are single unsynthesised items the dossier
does not reproduce — that includes today, which no dossier window covers, but
also older material that arrived late. Treat one raw statement as one source.
${blocks.map((b) => `\n${distillBlock(b, symbol)}\n`).join('')}${briefingBlock}
`;
}


export function demoteHeadings(md: string, by: number): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (_, hashes: string) =>
        '#'.repeat(Math.min(6, hashes.length + by)));
    })
    .join('\n');
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

/**
 * Contradictions found in the payload, stated before any of the numbers they
 * affect.
 *
 * Placed first in the prompt on purpose. The failure this exists to prevent was
 * a model reading a stale P/E of 107.88x, a stale negative FCF and a stale 2.07%
 * operating margin as three independent bear arguments and writing a confident
 * SELL — each figure was plausible on its own, and nothing in the prompt said
 * they all came from a data block three years out of date.
 */
function dataQualitySection(f: StockFinancials): string {
  const warnings = f.dataQualityWarnings ?? [];
  if (warnings.length === 0) return '';

  const errors = warnings.filter((w) => w.severity === 'error');
  const notes  = warnings.filter((w) => w.severity === 'warn');
  const line = (w: typeof warnings[number]) => `- **${w.code}** (${w.fields.join(', ')}): ${w.message}`;

  return `### ⚠ Data Quality — READ BEFORE USING THE NUMBERS BELOW

Automated cross-checks found ${warnings.length} problem${warnings.length === 1 ? '' : 's'} in this payload${
  errors.length > 0 ? `, ${errors.length} of them invalidating` : ''
}. These are contradictions *between* fields, so the individual figures below still look plausible — that is exactly why they need flagging.

${errors.length > 0 ? `**Invalidating — do not build a conclusion on the listed fields:**
${errors.map(line).join('\n')}
` : ''}${notes.length > 0 ? `**Qualifying — usable, but temper the conclusion:**
${notes.map(line).join('\n')}
` : ''}
How to handle this:
- Any model whose inputs appear in an invalidating finding is **out of evidence**, however precise its output looks. Say so explicitly in the bear or bull case instead of quoting the number.
- Prefer the annual statement series (revenue/EPS/FCF history) over trailing figures wherever they conflict.
- Reduce conviction: a flagged payload does not support a STRONG BUY or STRONG SELL. Widen the fair-value range to reflect what you cannot verify.
- Never present a flagged figure as a finding of fact about the company. "Reported FCF is negative" is a statement about the data, not about the business.
`;
}

/**
 * Wall Street consensus distilled to a single directional verdict + score.
 * Designed to be hard for the LLM to ignore: a one-line verdict label, the
 * weighted score (Strong Buy = +2 down to Strong Sell = −2, normalized to
 * [−1, +1]), and the upside vs the mean target. Sits as its own section
 * rather than buried in Market Overview, so the model treats it as a
 * first-class signal alongside DCF/Composite — not an afterthought.
 */
function analystConsensusSection(f: StockFinancials): string {
  const P = (n: number | null | undefined) => fmtPrice(n, f.tradingCurrency);
  const sb = f.analystStrongBuy  ?? 0;
  const b  = f.analystBuy        ?? 0;
  const h  = f.analystHold       ?? 0;
  const s  = f.analystSell       ?? 0;
  const ss = f.analystStrongSell ?? 0;
  const total = sb + b + h + s + ss;

  // No coverage is not a neutral absence — it removes the only input that is
  // independent of our own arithmetic. Left as a bare "N/A" the weighting
  // guidance below silently hands the models 100% of the vote, which is how a
  // stale-data SELL got written with no counterweight. Spell out the cap.
  if (total === 0 && f.targetMeanPrice === null) {
    return `### Analyst Consensus (Wall Street view — independent signal)
- **No analyst coverage on this listing** — no ratings, no price target, no forward estimates.

This removes the independent cross-check on the calculated models, so the models below are
**unvalidated, not confirmed**. They agree with each other because they share inputs, not
because two independent methods converged.

Required handling:
- Treat the computed fair values as one hypothesis, not as consensus. Agreement among models
  that share an EPS or FCF input is not corroboration.
- Cap conviction at BUY / HOLD / SELL. A **STRONG** rating requires either sell-side
  confirmation or a Distill/Perplexity briefing that independently supports it.
- Widen \`fairValueEstimate\` relative to a covered name to reflect the missing validation.
- Weight management guidance, order book, segment disclosure and the annual statement series
  higher than usual — with no consensus, the company's own reported trajectory is the best
  independent evidence available.
- If the absence looks like a listing artefact (a thin secondary line of a covered company),
  name that in the bear case as an information gap rather than treating the company as uncovered.`;
  }

  // Weighted score: Strong Buy = +2, Buy = +1, Hold = 0, Sell = −1, Strong Sell = −2.
  // Normalize by (total × 2) so range is [−1, +1].
  const score = total > 0
    ? (sb * 2 + b * 1 + h * 0 + s * -1 + ss * -2) / (total * 2)
    : null;

  const verdict = score === null ? 'N/A'
    : score >=  0.6 ? 'STRONG BULLISH'
    : score >=  0.2 ? 'BULLISH'
    : score >= -0.2 ? 'NEUTRAL'
    : score >= -0.6 ? 'BEARISH'
    :                 'STRONG BEARISH';

  // Buy-side share = (StrongBuy + Buy) / total.
  const buySharePct = total > 0 ? ((sb + b) / total) * 100 : null;
  const sellSharePct = total > 0 ? ((s + ss) / total) * 100 : null;

  // Upside vs current price.
  const upside = f.targetMeanPrice !== null && f.price > 0
    ? (f.targetMeanPrice - f.price) / f.price
    : null;

  const breakdown = [
    sb ? `${sb} Strong Buy`   : '',
    b  ? `${b} Buy`            : '',
    h  ? `${h} Hold`           : '',
    s  ? `${s} Sell`           : '',
    ss ? `${ss} Strong Sell`   : '',
  ].filter(Boolean).join(' + ');

  const targetLine = f.targetMeanPrice !== null
    ? `${P(f.targetMeanPrice)} mean${upside !== null ? ` (${signedPct(upside)} vs current ${P(f.price)})` : ''}${
        f.analystTargetLow !== null && f.analystTargetHigh !== null
          ? ` · range ${P(f.analystTargetLow)}–${P(f.analystTargetHigh)}`
          : ''
      }`
    : 'no consensus target';

  const scoreLine = score !== null
    ? `${score >= 0 ? '+' : ''}${score.toFixed(2)} (range −1 to +1)`
    : 'N/A';

  const shareLine = buySharePct !== null && sellSharePct !== null
    ? `${buySharePct.toFixed(0)}% buy-rated · ${sellSharePct.toFixed(0)}% sell-rated`
    : 'no breakdown';

  return `### Analyst Consensus (Wall Street view — independent signal)
- Verdict: **${verdict}** — weighted score ${scoreLine}
- Coverage: ${total} analysts → ${breakdown || 'no rating breakdown'}
- ${shareLine}
- Mean price target: ${targetLine}
- Note: this is the aggregated view of sell-side equity research — independent from our DCF/Composite/multiples. Triangulate against them; don't ignore a strong directional consensus just because intrinsic models disagree.`;
}

function macroSection(s: MarketSignals): string {
  const m = s.macro;
  return `### Macro Context
- VIX: ${fmt(m.vix, '', 1)} (${m.vixRegime})  |  SPY 3M: ${signedPct(m.spy3MReturn)}
- Yield curve 10Y-2Y: ${bps(m.yieldCurve2Y10Y)}  |  HY spread: ${bps(m.hySpreadBps)}
- DXY: ${fmt(m.dxyLevel, '', 1)} (3M ${signedPct(m.dxyChange3MPct)})
- Sector ETF: ${m.sectorEtfSymbol ?? 'unmapped'} 3M ${signedPct(m.sectorEtfReturn3M)}`;
}

export function buildAnalysisPrompt(
  f: StockFinancials,
  d: PromptData,
  perplexity?: PerplexityContext,
  distill?: DistillBundle,
): string {
  // Every price and currency amount in this prompt is denominated in the stock's
  // trading currency. It used to be printed with a hardcoded `$`, so a German
  // research note about an Austrian company quoted dollar figures throughout.
  const cur = f.tradingCurrency;
  const sym = currencyPrefix(cur);
  const P = (n: number | null | undefined) => fmtPrice(n, cur);

  // Empty string for a clean payload, so the section disappears entirely.
  const dataQuality = dataQualitySection(f);

  const piotroskiLine = `${d.piotroski.score}/${d.piotroski.maxScore} (${d.piotroski.interpretation})`;
  const altmanLine = d.altmanZ.score !== null
    ? `${d.altmanZ.score.toFixed(2)} — ${d.altmanZ.zone} zone (${d.altmanZ.model} model)`
    : 'N/A';

  // Distill: the rolling dossier prose for the company and for each sector it
  // sits in, with the briefing kept as the fallback for what has no dossier yet.
  const distillSection = distillDossierSection(f.symbol, distill);

  return `## Stock Analysis: ${f.symbol} — ${f.companyName}
${dataQuality ? `\n${dataQuality}` : ''}
### Market Overview
- Price: ${P(f.price)} | Market Cap: ${fmtBig(f.marketCap, cur)}
- Sector: ${f.sector ?? 'N/A'} / ${f.industry ?? 'N/A'}
- 52W Range: ${P(f.fiftyTwoWeekLow)} – ${P(f.fiftyTwoWeekHigh)}
- Beta: ${fmt(f.beta)}
  (Wall Street consensus — see dedicated section below.)

### Traditional Valuation
- P/E: ${fmt(d.ratios.pe, 'x')} | Forward P/E: ${fmt(d.ratios.forwardPE, 'x')} | Avg P/E 5Y: ${fmt(f.avgPE5Y, 'x')} | PEG: ${fmt(d.ratios.peg)}
- P/B: ${fmt(d.ratios.pb, 'x')} | P/S: ${fmt(d.evMultiples.priceToSales, 'x')} | P/FCF: ${fmt(d.evMultiples.priceToFCF, 'x')}
- EV/EBITDA: ${fmt(d.evMultiples.evToEbitda, 'x')} | EV/Revenue: ${fmt(d.evMultiples.evToRevenue, 'x')}${d.sectorMedians ? `
- Peer medians (${d.sectorMedians.peerCount} cos): P/E ${fmt(d.sectorMedians.pe, 'x', 1)} | EV/EBITDA ${fmt(d.sectorMedians.evToEbitda, 'x', 1)} | EV/Revenue ${fmt(d.sectorMedians.evToRevenue, 'x', 1)} | P/FCF ${fmt(d.sectorMedians.priceToFCF, 'x', 1)} | P/B ${fmt(d.sectorMedians.pb, 'x', 1)}` : ''}

### Profitability & Growth
- ROE: ${fmtPct(d.ratios.roe)} | ROA: ${fmtPct(d.ratios.roa)} | ROIC: ${fmtPct(f.roic)}
- Operating Margin: ${fmtPct(f.operatingMargin)} | Net Margin: ${fmtPct(f.netMargin)}
- Revenue: ${fmtBig(f.revenue, cur)} (${fmtPct(f.revenueGrowth)} growth)
- Earnings Growth TTM: ${fmtPct(f.earningsGrowth)} | EPS Growth 3Y: ${fmtPct(f.epsGrowth3Y)}
- FCF: ${fmtBig(f.freeCashFlow, cur)} | EBITDA: ${fmtBig(f.ebitda, cur)}

### Balance Sheet & Liquidity
- Cash: ${fmtBig(f.totalCash, cur)} | Total Debt: ${fmtBig(f.totalDebt, cur)}
- Current Ratio: ${fmt(f.currentRatio, 'x')} | Quick Ratio: ${fmt(f.quickRatio, 'x')}
- Debt/Equity: ${fmt(f.debtToEquity, 'x')} | Interest Coverage: ${d.interestCoverage.ratio !== null ? `${d.interestCoverage.ratio.toFixed(1)}x (${d.interestCoverage.interpretation})` : d.interestCoverage.interpretation}

### Composite Intrinsic Value (headline anchor)
- Median fair value across ${d.composite.contributingModels.length} applicable models: ${d.composite.median !== null ? `${P(d.composite.median)} (${fmtPct(d.composite.marginOfSafety)} MoS)` : 'N/A'}
- IQR (25–75%): ${d.composite.p25 !== null && d.composite.p75 !== null ? `${P(d.composite.p25)} – ${P(d.composite.p75)}` : 'N/A'}  |  Min/Max: ${d.composite.min !== null && d.composite.max !== null ? `${P(d.composite.min)} / ${P(d.composite.max)}` : 'N/A'}
- Confidence: ${d.composite.confidence}/10 (based on coverage, IQR tightness, and Beneish status)
- ${d.composite.pctModelsUndervalued !== null ? `${(d.composite.pctModelsUndervalued * 100).toFixed(0)}% of models indicate undervaluation` : ''}
- Contributing: ${d.composite.contributingModels.map((c) => `${c.name} ${P(c.fairValue)}`).join(' | ') || 'none'}
- Excluded: ${d.composite.excludedModels.map((e) => `${e.name} (${e.reason})`).join(' | ') || 'none'}

${analystConsensusSection(f)}

### Single-Equation Intrinsic Value Models
- DCF (2-Stage FCFF): ${d.dcf.fairValue !== null
  ? `${P(d.dcf.fairValue)}` +
    (d.dcf.fairValueBear !== null && d.dcf.fairValueBull !== null
      ? ` [bear ${P(d.dcf.fairValueBear)} – bull ${P(d.dcf.fairValueBull)}]`
      : '') +
    ` · r=${(d.dcf.discountRate * 100).toFixed(1)}% (CAPM, β=${fmt(d.dcf.beta)}) · g_stage1=${(d.dcf.stage1Growth * 100).toFixed(1)}% fading to ${(d.dcf.terminalGrowthRate * 100).toFixed(1)}%`
  : `N/A — ${d.dcf.assumptions}`}
- Reverse DCF: ${d.reverseDCF.isPossible && d.reverseDCF.impliedGrowthRate !== null ? `${(d.reverseDCF.impliedGrowthRate * 100).toFixed(1)}%/yr stage-1 FCF growth implied at r=${(d.reverseDCF.discountRate * 100).toFixed(1)}%` : 'N/A'}
- Graham Number: ${d.grahamNumber.grahamNumber ? `${P(d.grahamNumber.grahamNumber)} (${fmtPct(d.grahamNumber.marginOfSafety)} MoS)` : 'N/A'}
- Graham Revised (V*): ${d.grahamRevised.fairValue ? `${P(d.grahamRevised.fairValue)} (${fmtPct(d.grahamRevised.marginOfSafety)} MoS, AAA yield ${(d.grahamRevised.bondYield * 100).toFixed(2)}%)` : 'N/A'}
- Peter Lynch Fair Value: ${d.peterLynch.fairValue ? `${P(d.peterLynch.fairValue)}` : 'N/A'}
- EPV (Greenwald): ${d.epv.fairValue ? `${P(d.epv.fairValue)} (${fmtPct(d.epv.marginOfSafety)} MoS, r=${(d.epv.wacc * 100).toFixed(1)}%)` : 'N/A'}
- Residual Income (RIM): ${d.rim.isApplicable && d.rim.fairValue ? `${P(d.rim.fairValue)} (${fmtPct(d.rim.marginOfSafety)} MoS, ROE−r excess ${fmtPct(d.rim.excessReturn)})` : 'N/A — requires positive book value and ROE'}
- DDM: ${d.ddm.isApplicable && d.ddm.fairValue ? `${P(d.ddm.fairValue)}` : d.ddm.isApplicable ? 'Model constraint (g≥r)' : 'No dividend'}
- Peer Multiples (median fair price across ${d.peerMultiples.count} multiples): ${d.peerMultiples.medianFairPrice ? `${P(d.peerMultiples.medianFairPrice)} (${fmtPct(d.peerMultiples.marginOfSafety)} MoS)` : 'N/A — no peer-group data'}
- NCAV (Graham floor): ${d.ncav.isApplicable && d.ncav.ncavPerShare !== null && d.ncav.buyThreshold !== null ? `${P(d.ncav.ncavPerShare)}/sh, buy below ${P(d.ncav.buyThreshold)}` : 'N/A — current assets ≤ total liabilities (typical for healthy firms)'}

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
      `- ${q.quarter}: estimate ${P(q.epsEstimate)} → actual ${P(q.epsActual)} (${q.surprisePct !== null ? (q.surprisePct >= 0 ? '+' : '') + (q.surprisePct * 100).toFixed(1) + '% surprise' : 'N/A'})`
    ).join('\n')
  : '- No earnings history available'}

### Forward Earnings Estimates (analyst consensus)
${f.earningsEstimates.length > 0
  ? f.earningsEstimates.map((e) => {
      const label: Record<string, string> = { '0q': 'Current Qtr', '+1q': 'Next Qtr', '0y': 'Current Year', '+1y': 'Next Year' };
      const period = (label[e.period] ?? e.period) + (e.endDate ? ` (ends ${e.endDate})` : '');
      const eps = e.epsEstimate !== null ? `EPS ${P(e.epsEstimate)}` : 'EPS N/A';
      const range = e.epsLow !== null && e.epsHigh !== null ? ` [${P(e.epsLow)}–${P(e.epsHigh)}]` : '';
      const epsGrowth = e.epsGrowth !== null ? ` (${e.epsGrowth >= 0 ? '+' : ''}${(e.epsGrowth * 100).toFixed(1)}% YoY)` : '';
      const rev = e.revenueEstimate !== null ? `  Rev ${fmtBig(e.revenueEstimate, cur)}` : '';
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
${distillSection}${perplexity ? `
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
- "fairValueEstimate": price range as string, in the trading currency used above — ${cur ?? 'USD'} (e.g. "${sym}120–${sym}145").

Bullet writing rules — Alphaspread-style:
- Lead with the strongest single fact, not setup or hedging.
- Cite a number (margin, growth, ratio, target) in every bullet.
- No filler verbs like "appears", "may", "could potentially". Be direct.
- Each bullet is independent — no "first … second … finally" connectors.

Focus on: competitive moat, valuation vs. intrinsic value (Composite + single-equation models), **Wall Street analyst consensus and price target as an independent triangulation signal — do not let it be drowned out by the calculated models**, growth quality, financial health, technical posture (trend, RSI/MACD, relative strength), earnings-revision momentum, and macro context (VIX regime, yield curve, HY spreads) when material.

Weighting guidance for the recommendation (in descending order of authority):
0. **Data Quality findings** (when the section is present) — these outrank everything below, because they say which of the inputs below are not evidence. A model built on a flagged field does not get a vote no matter where it sits in this list.
1. **Composite + single-equation valuation models** — your quantitative anchor (intrinsic-value lens).
2. **Analyst Consensus** — market-aligned sell-side lens; independent of the calculated models.
3. **Distill company dossier / briefing** (when present) — curated multi-source qualitative narrative about *this company*, already past an editorial filter. Strongest qualitative input.
3b. **Distill sector dossiers** (when present) — the industry backdrop. Context for reading the company, never evidence about it: a sector-wide headwind is a reason to check whether this company shares it, not a finding that it does. Where the company's own numbers diverge from its sector's narrative, say so — that divergence is worth more than either block alone.
4. **Perplexity Sonar** (when present) — substantive web-sourced synthesis. Weight below Distill (Distill has tighter source curation) but above raw search results.
5. **Web Search Results** (when present) — raw snippets, useful for fact-checking and recency only. The user opted into these explicitly; treat as colour, not as decision input.

A strong divergence between any two of these classes is itself a signal — flag it in the bull or bear case.

Don't override a STRONG BULLISH or STRONG BEARISH analyst consensus on the basis of intrinsic-value disagreement alone unless you have a concrete reason (e.g. Beneish "likely manipulator", interest-coverage failure, terminal growth assumption broken). A Distill **company** dossier flagging the same concern qualifies as a concrete reason; a sector dossier does not, on its own.

When there is **no** analyst consensus, that guard does not become permission to lean harder on the models — it means the models lost their only independent check. Follow the caps stated in the Analyst Consensus section: no STRONG rating, a wider fair-value range, and the company's own reported trajectory weighted above the computed fair values.

Composite confidence is a first-class input, not a footnote: below 4/10 the composite median is an average of models that disagree, and quoting it as a single fair value overstates what is known. Say the models diverge and give a range instead.

---

**Output language — German.** All free-text fields (\`bullCase\`, \`bearCase\`, \`keyRisks\`, \`thesis\`) must be written in **natural, professional German** — the register of a sell-side equity research note. Apply the Alphaspread-style bullet writing rules above to the German text: lead with the strongest single fact, cite a number in every bullet, no hedging verbs ("könnte", "möglicherweise"), no narrative connectors ("erstens … schließlich").

Keep these unchanged regardless of language:
- The \`recommendation\` enum: \`"STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL"\` (used as UI tokens — not translated).
- The \`fairValueEstimate\` format: \`"${sym}120–${sym}145"\` style (price range in the stock's trading currency ${cur ?? 'USD'}, with an en-dash). Never convert it to another currency.
- Established finance terminology in the body text: *Free Cash Flow*, *EBITDA*, *DCF*, *ROE*, *Margin of Safety*, *Forward P/E*, *Piotroski*, *Altman Z*, *Beneish*, ticker symbols, company names. Don't germanise these.

Numbers, ratios, and currency amounts keep their English-style formatting ("${sym}1.2B", "23.4%", "1.8x"). Use German for the surrounding prose only ("Bewertung mit 23% Abschlag zum Composite Fair Value" — not "Valuation with 23% discount …").`;
}
