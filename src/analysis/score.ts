/**
 * The part of the verdict the code can defend.
 *
 * Score and recommendation used to be produced entirely by the LLM, from a
 * prompt that laid out nineteen valuation models, the technicals, the revisions
 * and two dossiers and then *asked* for a weighting in prose ("in descending
 * order of authority"). That is a request, not a rule. Two runs over the same
 * payload landed several tenths apart, the recorded `verdict.score` series
 * charted as much model noise as company, and the guard against bad data — "a
 * flagged payload does not support a STRONG BUY" — was a sentence the model was
 * free to skim.
 *
 * Everything that sentence asked for is arithmetic, and all of it was already
 * computed somewhere in this codebase. So it is done here instead: six pillars,
 * each a weighted mean of named criteria, each criterion a number this repo
 * already produces mapped onto 0–1 by an explicit ramp. The result is a score
 * that moves when the company moves and holds still when it doesn't.
 *
 * Three properties are worth stating because the rest of the file is built to
 * keep them true:
 *
 *   - **It decomposes exactly.** Every criterion's `impact` is its signed
 *     contribution in score points, and they sum to `raw − 5`. "Why 7.2" is
 *     answerable by listing rows, not by asking a model what it was thinking.
 *   - **Missing inputs cost coverage, not points.** A criterion with no data is
 *     dropped and its pillar's remaining weights renormalise. Nothing is scored
 *     5/10 for being unknown, because that quietly votes "average".
 *   - **Uncertainty shrinks the score toward neutral.** A payload the
 *     data-quality audit flagged, or one where half the pillars are blind, is
 *     pulled toward 5 rather than trusted at face value. Confident garbage was
 *     the failure mode this whole module exists to end.
 *
 * Ramps are linear and continuous on purpose. Step thresholds ("P/E under 15 =
 * cheap") put a cliff in the middle of the range every borderline company sits
 * on, and a stock oscillating around one would flap between BUY and HOLD on a
 * rounding error — the very randomness this replaces.
 */

import {
  AnalystRatingDelta, CompositeFairValueResult, EarningsRevisions, FactorScore,
  FinalScore, MarketSignals, PillarKey, Recommendation, ScoreCap, ScoreCriterion,
  ScoreFinding, ScorePillar, SectorMedians, StockFinancials, TechnicalSignals,
} from '../types.js';
import { ComputedMetrics } from './computeMetrics.js';
import { worstSeverity } from './data-quality.js';
import { fmt, fmtBig, fmtPct, fmtPrice, fmtSignedPct } from '../format.js';
import { toFiniteNumber } from '../utils/num.js';
import { verdictForScore } from '../verdict.js';

// ── Configuration ────────────────────────────────────────────────────────────
//
// The types live in `src/types.ts` with every other schema, because the metric
// catalogue derives its series from them and a schema reaching back into the
// analysis layer would close an import cycle. What stays in this file is the
// part that is genuinely scoring policy: the weights, the bands and the ramps
// below, plus the two blend constants, which sit with the blend itself at the
// bottom rather than here — they belong to the sentence that explains them.

/**
 * What each pillar is worth. Sums to 1.
 *
 * Valuation leads because the question the tool answers is "is this worth its
 * price", and consensus is weighted like a real second opinion rather than a
 * tiebreaker — it is the only input here not derived from our own arithmetic,
 * which is exactly what made an uncovered stock dangerous before.
 */
export const PILLAR_WEIGHTS: Record<PillarKey, number> = {
  valuation: 0.30,
  quality:   0.20,
  health:    0.15,
  consensus: 0.15,
  momentum:  0.10,
  revisions: 0.10,
};

export const PILLAR_LABELS: Record<PillarKey, string> = {
  valuation: 'Bewertung',
  quality:   'Qualität',
  health:    'Bilanz & Risiko',
  consensus: 'Analystenkonsens',
  momentum:  'Markt & Momentum',
  revisions: 'Erwartungen',
};

/** Below this confidence no STRONG label is available, whatever the score. */
const STRONG_MIN_CONFIDENCE = 0.45;

/** How many drivers and how many drags survive into `findings`. */
const FINDINGS_PER_SIDE = 4;

/** A criterion below this absolute impact is noise, not a finding. */
const FINDING_MIN_IMPACT = 0.12;

/** Pillar scores this far apart are a divergence worth naming. */
const DIVERGENCE_GAP = 3.5;

/**
 * How many pillar-pair divergences survive into the findings.
 *
 * Six pillars make fifteen pairs, and a stock whose valuation lags everything
 * else generates the same observation four times over with a different partner
 * each line. The widest pair carries the whole of that information; the rest is
 * the same fact repeated until the summariser treats it as four facts.
 */
const DIVERGENCES_KEPT = 2;

/** Piotroski needs this many computable signals before its ratio means anything. */
const PIOTROSKI_MIN_SIGNALS = 5;

// ── Ramps ────────────────────────────────────────────────────────────────────

/**
 * Linear 0→1 between `lo` and `hi`, clamped outside. `lo > hi` reads as a
 * falling ramp, which is how "smaller is better" is expressed — there is no
 * second function for it, so no chance of the two drifting apart.
 */
function ramp(v: number | null | undefined, lo: number, hi: number): number | null {
  const x = toFiniteNumber(v);
  if (x === null || lo === hi) return null;
  const t = (x - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t));
}

/** Points from a closed set of labels; unknown labels score nothing at all. */
function fromLabel<T extends string>(
  label: T | null | undefined, table: Partial<Record<T, number>>,
): number | null {
  if (!label) return null;
  const p = table[label];
  return p === undefined ? null : p;
}

/** Mean of the values that exist, or null when none do. */
function meanOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

/**
 * Own multiple against the peer median, as points.
 *
 * Expressed as a ratio rather than a difference so it works across multiples
 * with wildly different scales: 0.6× the peer median scores full marks, 1.6×
 * scores none. Non-positive values on either side are meaningless here (a
 * negative P/E is not "cheap"), so they read as missing.
 */
function relativeMultiple(own: number | null | undefined, median: number | null | undefined): number | null {
  const o = toFiniteNumber(own);
  const m = toFiniteNumber(median);
  if (o === null || m === null || o <= 0 || m <= 0) return null;
  return ramp(o / m, 1.6, 0.6);
}

// ── Analyst consensus, as a number ───────────────────────────────────────────

export interface AnalystConsensus {
  /** Number of rating analysts covering the listing. */
  total:       number;
  /** Weighted rating, −1 (all Strong Sell) to +1 (all Strong Buy). Null when uncovered. */
  score:       number | null;
  /** Directional label for the same number. */
  label:       'STRONG BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG BEARISH' | 'N/A';
  buySharePct:  number | null;
  sellSharePct: number | null;
  /** (mean target − price) / price. */
  upside:      number | null;
  /** True when there is neither a rating breakdown nor a price target. */
  uncovered:   boolean;
}

/**
 * The sell-side view reduced to two numbers.
 *
 * Lived inside the prompt builder as string interpolation, which meant the only
 * consumer of the consensus was a paragraph of English — the scorer could not
 * read it and the overview re-derived its own version. One definition now, three
 * readers.
 */
export function analystConsensus(f: StockFinancials): AnalystConsensus {
  const sb = f.analystStrongBuy  ?? 0;
  const b  = f.analystBuy        ?? 0;
  const h  = f.analystHold       ?? 0;
  const s  = f.analystSell       ?? 0;
  const ss = f.analystStrongSell ?? 0;
  const total = sb + b + h + s + ss;

  const score = total > 0 ? (sb * 2 + b - s - ss * 2) / (total * 2) : null;
  const label: AnalystConsensus['label'] =
    score === null       ? 'N/A'
    : score >=  0.6      ? 'STRONG BULLISH'
    : score >=  0.2      ? 'BULLISH'
    : score >= -0.2      ? 'NEUTRAL'
    : score >= -0.6      ? 'BEARISH'
    :                      'STRONG BEARISH';

  const target = toFiniteNumber(f.targetMeanPrice);
  const upside = target !== null && f.price > 0 ? (target - f.price) / f.price : null;

  return {
    total,
    score,
    label,
    buySharePct:  total > 0 ? ((sb + b) / total) * 100 : null,
    sellSharePct: total > 0 ? ((s + ss) / total) * 100 : null,
    upside,
    uncovered: total === 0 && target === null,
  };
}

/** Net upgrades minus net downgrades over the last month. */
function netRatingDelta(d: AnalystRatingDelta | null | undefined): number | null {
  if (!d) return null;
  return (d.strongBuy + d.buy) - (d.sell + d.strongSell);
}

// ── Pillars ──────────────────────────────────────────────────────────────────

/** Local builder so each pillar reads as a list of criteria and nothing else. */
function criterion(
  key: string, label: string, weight: number, points: number | null, note: string,
): ScoreCriterion {
  return { key, label, weight, points, note, impact: null };
}

function valuationPillar(
  f: StockFinancials, m: ComputedMetrics, peers: SectorMedians | null,
): ScoreCriterion[] {
  const c = f.tradingCurrency;
  const comp: CompositeFairValueResult = m.composite;

  const consMos = comp.conservative.marginOfSafety;

  // The composite zeroes its own confidence when fewer than two primary models
  // survived, and a median over one model is not a median. Left scored, that
  // single survivor is usually the analyst target — which on a pre-profit name
  // sits far above the price and read as a perfect 10/10 valuation on exactly
  // the stocks we know least about. Same rule as Piotroski's signal floor and
  // Beneish's variable floor: below the minimum the criterion abstains, the
  // pillar renormalises onto the lenses that do have data, and what is lost is
  // charged to coverage.
  const compositeUsable = comp.confidence > 0;
  const mos = compositeUsable ? comp.primary.marginOfSafety : null;
  const pct = compositeUsable ? comp.pctPrimaryUndervalued : null;
  const thinNote = `Composite aus ${comp.primary.models.length} Modell${comp.primary.models.length === 1 ? '' : 'en'} `
    + '— zu wenige für einen belastbaren Median, daher nicht bewertet';

  // Relative cheapness is a second lens, not a second helping of the first:
  // the composite asks "what is it worth", this asks "what do comparable firms
  // trade at". They disagree often enough to be worth keeping apart.
  const relParts = [
    relativeMultiple(m.ratios.pe,             peers?.pe),
    relativeMultiple(m.evMultiples.evToEbitda, peers?.evToEbitda),
    relativeMultiple(m.evMultiples.priceToSales, peers?.priceToSales),
    relativeMultiple(m.evMultiples.priceToFCF, peers?.priceToFCF),
  ];
  const rel = meanOf(relParts);
  const relCount = relParts.filter((p) => p !== null).length;

  return [
    criterion('composite-mos', 'Composite Margin of Safety', 0.45,
      ramp(mos, -0.30, 0.60),
      !compositeUsable ? thinNote
        : comp.primary.median !== null
          ? `Composite Fair Value ${fmtPrice(comp.primary.median, c)} vs. Kurs ${fmtPrice(f.price, c)} — MoS ${fmtSignedPct(mos)} über ${comp.primary.models.length} Modelle`
          : 'Kein Composite Fair Value — zu wenige anwendbare Modelle'),

    criterion('models-undervalued', 'Anteil unterbewertender Modelle', 0.20,
      pct,
      !compositeUsable ? thinNote
        : pct !== null
          ? `${(pct * 100).toFixed(0)} % der Primärmodelle sehen die Aktie unter Fair Value`
          : 'Kein Primärmodell lieferte einen Fair Value'),

    criterion('conservative-mos', 'Value-Lens (konservative Modelle)', 0.15,
      ramp(consMos, -0.50, 0.30),
      comp.conservative.median !== null
        ? `Konservativer Fair Value ${fmtPrice(comp.conservative.median, c)} — MoS ${fmtSignedPct(consMos)} (Graham, EPV, RIM, DDM)`
        : 'Keine konservativen Modelle anwendbar'),

    criterion('peer-multiples', 'Multiples gegen Sektormedian', 0.20,
      rel,
      rel !== null
        ? `${relCount} Multiples gegen ${peers?.peerCount ?? 0} Peers: P/E ${fmt(m.ratios.pe, 'x')} vs. ${fmt(peers?.pe, 'x')}, EV/EBITDA ${fmt(m.evMultiples.evToEbitda, 'x')} vs. ${fmt(peers?.evToEbitda, 'x')}`
        : 'Keine Peer-Mediane verfügbar — relative Bewertung nicht prüfbar'),
  ];
}

function qualityPillar(
  f: StockFinancials, m: ComputedMetrics, peers: SectorMedians | null,
): ScoreCriterion[] {
  const pio = m.piotroski;
  // Piotroski scores only the signals the data supports, so a company with no
  // prior-year statements can come back 0/1 — which is not a weak F-Score, it
  // is no F-Score. Below half the criteria the ratio says more about our
  // coverage than about the company, and the criterion abstains instead.
  const pioRatio = pio.maxScore >= PIOTROSKI_MIN_SIGNALS ? pio.score / pio.maxScore : null;

  // ROIC earns its keep only against the cost of that capital. The DCF's
  // discount rate is this codebase's WACC, so the comparison is free.
  const roic = toFiniteNumber(f.roic);
  const wacc = toFiniteNumber(m.dcf.discountRate);
  const excess = roic !== null && wacc !== null ? roic - wacc : null;

  const margin = toFiniteNumber(f.operatingMargin) ?? toFiniteNumber(f.netMargin);
  const peerMargin = peers?.operatingMargin ?? peers?.netMargin ?? null;
  // Against peers where we have them, against an absolute band where we don't.
  const marginPoints = peerMargin !== null && margin !== null
    ? ramp(margin - peerMargin, -0.10, 0.10)
    : ramp(margin, -0.05, 0.25);

  const growth = toFiniteNumber(f.revenueGrowth);
  const peerGrowth = peers?.revenueGrowthYoY ?? null;

  return [
    criterion('piotroski', 'Piotroski F-Score', 0.30,
      ramp(pioRatio, 0.35, 0.90),
      pio.maxScore >= PIOTROSKI_MIN_SIGNALS
        ? `F-Score ${pio.score}/${pio.maxScore} (${pio.interpretation})`
        : `F-Score nur aus ${pio.maxScore}/9 berechenbaren Signalen — nicht belastbar`),

    criterion('roic-spread', 'ROIC über Kapitalkosten', 0.25,
      ramp(excess, -0.05, 0.15),
      excess !== null
        ? `ROIC ${fmtPct(roic)} gegen WACC ${fmtPct(wacc)} — Spread ${fmtSignedPct(excess)}`
        : 'ROIC oder WACC nicht berechenbar'),

    criterion('margin', 'Operative Marge', 0.20,
      marginPoints,
      margin === null ? 'Keine Margendaten'
        : peerMargin !== null
          ? `Operative Marge ${fmtPct(margin)} gegen Sektormedian ${fmtPct(peerMargin)}`
          : `Operative Marge ${fmtPct(margin)} (kein Peer-Vergleich verfügbar)`),

    criterion('growth', 'Umsatzwachstum', 0.15,
      peerGrowth !== null && growth !== null
        ? ramp(growth - peerGrowth, -0.10, 0.15)
        : ramp(growth, -0.05, 0.25),
      growth === null ? 'Kein Umsatzwachstum ausgewiesen'
        : peerGrowth !== null
          ? `Umsatzwachstum ${fmtSignedPct(growth)} gegen Sektormedian ${fmtSignedPct(peerGrowth)}`
          : `Umsatzwachstum ${fmtSignedPct(growth)}`),

    criterion('rule-of-40', 'Rule of 40', 0.10,
      ramp(m.ruleOf40.score, 20, 60),
      m.ruleOf40.score !== null
        ? `Rule of 40: ${m.ruleOf40.score.toFixed(1)} (${m.ruleOf40.passes ? 'bestanden' : 'verfehlt'})`
        : 'Rule of 40 nicht berechenbar'),
  ];
}

function healthPillar(f: StockFinancials, m: ComputedMetrics): ScoreCriterion[] {
  const z = m.altmanZ;
  // Zone boundaries differ by model, so the ramp is built from the thresholds
  // the calculation itself used rather than from constants repeated here.
  const zPoints = z.score !== null
    ? ramp(z.score, z.thresholds.distress, z.thresholds.safe)
    : fromLabel(z.zone, { safe: 1, grey: 0.5, distress: 0 });

  const cash = toFiniteNumber(f.totalCash) ?? 0;
  const debt = toFiniteNumber(f.totalDebt);
  const ebitda = toFiniteNumber(f.ebitda);
  const netDebt = debt === null ? null : debt - cash;
  // Net cash is the best case and a negative ratio would otherwise land at the
  // wrong end of the ramp; state it as full marks explicitly.
  const leverage = netDebt === null ? null
    : netDebt <= 0 ? 1
    : ebitda !== null && ebitda > 0 ? ramp(netDebt / ebitda, 4, 1)
    : null;

  return [
    criterion('altman', 'Altman Z-Score', 0.30, zPoints,
      z.score !== null
        ? `Altman Z ${z.score.toFixed(2)} — ${z.zone}-Zone (${z.model}, Grenzen ${z.thresholds.distress}/${z.thresholds.safe})`
        : `Altman Z nicht berechenbar (Zone ${z.zone})`),

    criterion('interest-cover', 'Zinsdeckung', 0.25,
      m.interestCoverage.ratio !== null
        ? ramp(m.interestCoverage.ratio, 1, 8)
        : fromLabel(m.interestCoverage.interpretation, {
            excellent: 1, good: 0.75, fair: 0.5, poor: 0.25, critical: 0,
          }),
      m.interestCoverage.ratio !== null
        ? `EBIT deckt Zinsen ${m.interestCoverage.ratio.toFixed(1)}x (${m.interestCoverage.interpretation})`
        : `Zinsdeckung: ${m.interestCoverage.interpretation}`),

    criterion('leverage', 'Nettoverschuldung / EBITDA', 0.25, leverage,
      netDebt === null ? 'Keine Verschuldungsdaten'
        : netDebt <= 0 ? `Nettoliquidität ${fmtBig(-netDebt, f.tradingCurrency)} — keine Nettoverschuldung`
        : ebitda !== null && ebitda > 0
          ? `Nettoverschuldung ${fmt(netDebt / ebitda, 'x', 1)} EBITDA`
          : 'EBITDA nicht positiv — Verschuldungsgrad nicht aussagekräftig'),

    criterion('liquidity', 'Current Ratio', 0.10,
      ramp(f.currentRatio, 0.8, 2.0),
      f.currentRatio !== null ? `Current Ratio ${fmt(f.currentRatio, 'x')}` : 'Keine Liquiditätskennzahl'),

    criterion('beneish', 'Bilanzqualität (Beneish)', 0.10,
      m.beneish.variablesComputed >= 4
        ? fromLabel(m.beneish.probability, {
            'unlikely manipulator': 1, 'grey zone': 0.5, 'likely manipulator': 0,
          })
        : null,
      m.beneish.variablesComputed >= 4
        ? `Beneish M ${fmt(m.beneish.score)} — ${m.beneish.probability}`
        : `Beneish nur aus ${m.beneish.variablesComputed}/8 Variablen — nicht belastbar`),
  ];
}

function momentumPillar(signals: MarketSignals | null, tech: TechnicalSignals | null): ScoreCriterion[] {
  const t = signals?.technicals ?? null;

  return [
    criterion('technical-verdict', 'Technisches Gesamtbild', 0.40,
      tech ? (tech.overall.score + 1) / 2 : null,
      tech
        ? `Technik ${tech.overall.verdict} — ${tech.overall.buy} Kauf-, ${tech.overall.sell} Verkaufssignale (Score ${tech.overall.score.toFixed(2)})`
        : 'Keine Kurshistorie für technische Signale'),

    criterion('rs-market', 'Relative Stärke vs. Markt (3M)', 0.25,
      ramp(t?.rsVsSPY3M, -0.15, 0.15),
      t?.rsVsSPY3M != null ? `3M gegen SPY ${fmtSignedPct(t.rsVsSPY3M)}` : 'Keine Relative Stärke vs. Markt'),

    criterion('rs-sector', 'Relative Stärke vs. Sektor (3M)', 0.15,
      ramp(t?.rsVsSector3M, -0.15, 0.15),
      t?.rsVsSector3M != null ? `3M gegen Sektor-ETF ${fmtSignedPct(t.rsVsSector3M)}` : 'Kein Sektor-ETF zugeordnet'),

    criterion('range-position', '52-Wochen-Position', 0.20,
      ramp(t?.position52WPct, 0.15, 0.70),
      t?.position52WPct != null
        ? `${(t.position52WPct * 100).toFixed(0)} % der 52-Wochen-Spanne, Drawdown vom Hoch ${fmtSignedPct(t.drawdownFromHighPct)}`
        : 'Keine 52-Wochen-Spanne'),
  ];
}

function revisionsPillar(f: StockFinancials, signals: MarketSignals | null): ScoreCriterion[] {
  const r: EarningsRevisions | null = signals?.revisions ?? null;
  const periods = r?.perPeriod ?? [];
  const year = periods.find((p) => p.period === '0y') ?? periods.find((p) => p.period === '+1y');

  // Revision counts are summed across periods: a single quarter's flow is thin,
  // and the four periods move together often enough that the sum is the signal.
  const netValues = periods.map((p) => toFiniteNumber(p.netRevision30d)).filter((v): v is number => v !== null);
  const net = netValues.length > 0 ? netValues.reduce((s, v) => s + v, 0) : null;

  const surprises = f.earningsSurprises ?? [];
  const scored = surprises.filter((q) => toFiniteNumber(q.surprisePct) !== null);
  const beats = scored.filter((q) => (q.surprisePct as number) > 0).length;

  const ratingDelta = netRatingDelta(r?.analystRatingMoMDelta);

  return [
    criterion('eps-drift', 'EPS-Schätzungsdrift (30 Tage)', 0.35,
      ramp(year?.epsChange30dPct, -0.03, 0.03),
      year?.epsChange30dPct != null
        ? `Konsens-EPS ${year.period === '0y' ? 'laufendes Jahr' : 'Folgejahr'} ${fmtSignedPct(year.epsChange30dPct)} in 30 Tagen (${fmt(year.epsTrend.ago30d)} → ${fmt(year.epsTrend.current)})`
        : 'Keine Schätzungsdrift verfügbar'),

    criterion('net-revisions', 'Netto-Revisionen (30 Tage)', 0.30,
      ramp(net, -4, 4),
      net !== null
        ? `Netto ${net >= 0 ? '+' : ''}${net} Revisionen über ${periods.length} Perioden`
        : 'Keine Revisionszählungen verfügbar'),

    criterion('surprises', 'Ergebnisüberraschungen', 0.20,
      scored.length > 0 ? beats / scored.length : null,
      scored.length > 0
        ? `${beats} von ${scored.length} Quartalen über Konsens`
        : 'Keine Überraschungshistorie'),

    criterion('rating-drift', 'Rating-Veränderung (MoM)', 0.15,
      ramp(ratingDelta, -2, 2),
      ratingDelta !== null
        ? `Analystenratings netto ${ratingDelta >= 0 ? '+' : ''}${ratingDelta} gegenüber Vormonat`
        : 'Keine Rating-Veränderung gegenüber Vormonat'),
  ];
}

function consensusPillar(f: StockFinancials, cons: AnalystConsensus): ScoreCriterion[] {
  const c = f.tradingCurrency;
  return [
    criterion('rating', 'Gewichtetes Analystenrating', 0.55,
      cons.score !== null ? (cons.score + 1) / 2 : null,
      cons.score !== null
        ? `${cons.label} — ${cons.total} Analysten, ${cons.buySharePct?.toFixed(0)} % Kauf, gewichteter Score ${cons.score >= 0 ? '+' : ''}${cons.score.toFixed(2)}`
        : 'Keine Analystenabdeckung für dieses Listing'),

    criterion('target-upside', 'Kursziel-Potenzial', 0.45,
      ramp(cons.upside, -0.10, 0.35),
      cons.upside !== null
        ? `Mittleres Kursziel ${fmtPrice(f.targetMeanPrice, c)} — ${fmtSignedPct(cons.upside)} zum Kurs ${fmtPrice(f.price, c)}`
        : 'Kein Konsens-Kursziel'),
  ];
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Weighted mean of the criteria that scored, plus the coverage that produced it. */
function reducePillar(
  key: PillarKey, criteria: ScoreCriterion[],
): Omit<ScorePillar, 'effectiveWeight'> {
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  const scored = criteria.filter((c) => c.points !== null);
  const scoredWeight = scored.reduce((s, c) => s + c.weight, 0);

  const coverage = totalWeight > 0 ? scoredWeight / totalWeight : 0;
  const score = scoredWeight > 0
    ? (scored.reduce((s, c) => s + c.weight * (c.points as number), 0) / scoredWeight) * 10
    : null;

  return {
    key,
    label:    PILLAR_LABELS[key],
    // Unrounded, for the same reason `raw` is: the pillar scores are what the
    // criterion impacts are measured against. Rounding is the renderer's job.
    score,
    weight:   PILLAR_WEIGHTS[key],
    coverage: Math.round(coverage * 1000) / 1000,
    criteria,
  };
}

/** Apply the ceilings in order of severity; `hold-ceiling` subsumes `no-strong`. */
function capVerdict(verdict: Recommendation, caps: ScoreCap[]): Recommendation {
  let out: Recommendation = verdict;
  if (caps.some((c) => c.limit === 'no-strong' || c.limit === 'hold-ceiling')) {
    if (out === 'STRONG BUY')  out = 'BUY';
    if (out === 'STRONG SELL') out = 'SELL';
  }
  // A ceiling caps enthusiasm, not alarm: a distressed balance sheet is no
  // reason to upgrade a SELL.
  if (caps.some((c) => c.limit === 'hold-ceiling') && out === 'BUY') out = 'HOLD';
  return out;
}

export interface FactorScoreInput {
  financials:       StockFinancials;
  metrics:          ComputedMetrics;
  sectorMedians:    SectorMedians | null;
  marketSignals:    MarketSignals | null;
  technicalSignals: TechnicalSignals | null;
}

/**
 * The whole score, from inputs this repo already has in hand.
 *
 * Pure and synchronous: no IO, no clock, no randomness. The same payload scores
 * the same today and in the backfill that re-scores three months of stored
 * snapshots — which is the entire point of calling it deterministic.
 */
export function computeFactorScore(input: FactorScoreInput): FactorScore {
  const { financials: f, metrics: m, sectorMedians, marketSignals, technicalSignals } = input;
  const cons = analystConsensus(f);

  const built: Omit<ScorePillar, 'effectiveWeight'>[] = [
    reducePillar('valuation', valuationPillar(f, m, sectorMedians)),
    reducePillar('quality',   qualityPillar(f, m, sectorMedians)),
    reducePillar('health',    healthPillar(f, m)),
    reducePillar('consensus', consensusPillar(f, cons)),
    reducePillar('momentum',  momentumPillar(marketSignals, technicalSignals)),
    reducePillar('revisions', revisionsPillar(f, marketSignals)),
  ];

  // A pillar with nothing to say is dropped rather than scored 5/10, and the
  // rest renormalise over what is left. Coverage records what that cost.
  const scoredWeight = built.filter((p) => p.score !== null).reduce((s, p) => s + p.weight, 0);
  const coverage = scoredWeight;   // weights sum to 1, so this is already a share

  const pillars: ScorePillar[] = built.map((p) => ({
    ...p,
    effectiveWeight: p.score === null || scoredWeight === 0 ? 0 : p.weight / scoredWeight,
  }));

  // Nothing scorable is not a score of zero. A payload that produced no pillar
  // at all knows nothing about the company, and "knows nothing" is neutral —
  // without this guard an empty payload fell through to raw 0 and printed a
  // confident SELL.
  const raw = scoredWeight === 0
    ? 5
    : pillars.reduce((s, p) => s + p.effectiveWeight * (p.score ?? 0), 0);

  // Each criterion's signed contribution in score points. These sum to raw − 5
  // exactly, which is what makes the findings list an itemisation of the score
  // rather than a commentary on it.
  for (const p of pillars) {
    const scoredCritWeight = p.criteria
      .filter((c) => c.points !== null)
      .reduce((s, c) => s + c.weight, 0);
    for (const c of p.criteria) {
      c.impact = c.points === null || scoredCritWeight === 0
        ? null
        : (c.points - 0.5) * 10 * p.effectiveWeight * (c.weight / scoredCritWeight);
    }
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  const severity = worstSeverity(f.dataQualityWarnings ?? []);
  const qualityFactor = severity === 'error' ? 0.35 : severity === 'warn' ? 0.75 : 1;
  const freshnessFactor = f.fundamentalsStale ? 0.6 : 1;
  const compositeFactor = 0.55 + 0.45 * (m.composite.confidence / 10);
  const confidence = Math.max(0, Math.min(1,
    coverage * compositeFactor * qualityFactor * freshnessFactor));

  // Half-weight at zero confidence rather than a collapse to 5: a blind score
  // still has to rank, it just must not shout.
  const shrink = 0.4 + 0.6 * confidence;
  const score = Math.max(0, Math.min(10, 5 + (raw - 5) * shrink));

  // ── Caps ──────────────────────────────────────────────────────────────────
  const caps: ScoreCap[] = [];
  if (severity === 'error') {
    caps.push({ limit: 'no-strong', reason: 'Datenqualität: mindestens ein Feld ist nachweislich widersprüchlich' });
  }
  if (cons.uncovered) {
    caps.push({ limit: 'no-strong', reason: 'Keine Analystenabdeckung — den Modellen fehlt die unabhängige Gegenprobe' });
  }
  if (confidence < STRONG_MIN_CONFIDENCE) {
    caps.push({ limit: 'no-strong', reason: `Konfidenz ${(confidence * 100).toFixed(0)} % unter ${(STRONG_MIN_CONFIDENCE * 100).toFixed(0)} %` });
  }
  if (m.beneish.probability === 'likely manipulator' && m.beneish.variablesComputed >= 4) {
    caps.push({ limit: 'hold-ceiling', reason: 'Beneish M-Score stuft die Bilanz als "likely manipulator" ein' });
  }
  if (m.altmanZ.zone === 'distress') {
    caps.push({ limit: 'hold-ceiling', reason: 'Altman Z im Distress-Bereich' });
  }

  const uncappedVerdict = verdictForScore(score);

  return {
    score:      Math.round(score * 100) / 100,
    // The one field deliberately not rounded. Every criterion's impact is
    // measured against `raw`, and rounding it would turn "the impacts sum to
    // raw − 5" from an invariant worth testing into an approximation worth
    // arguing about. Readers format it; nothing downstream compares it to a
    // literal.
    raw,
    verdict:    capVerdict(uncappedVerdict, caps),
    uncappedVerdict,
    confidence: Math.round(confidence * 1000) / 1000,
    coverage:   Math.round(coverage * 1000) / 1000,
    shrink:     Math.round(shrink * 1000) / 1000,
    pillars,
    caps,
    findings:   collectFindings(pillars, caps, f, m, cons),
  };
}

/**
 * The rows a summariser is allowed to talk about.
 *
 * Drivers and drags come straight off the impact decomposition, so what the
 * summary leads with is what actually moved the number. Divergences are added
 * by hand because they are the one thing no single criterion can see: two
 * pillars can each be unremarkable and still disagree in a way that is the most
 * interesting fact about the stock.
 */
function collectFindings(
  pillars: ScorePillar[], caps: ScoreCap[],
  f: StockFinancials, m: ComputedMetrics, cons: AnalystConsensus,
): ScoreFinding[] {
  const scored = pillars.flatMap((p) =>
    p.criteria
      .filter((c) => c.impact !== null && Math.abs(c.impact) >= FINDING_MIN_IMPACT)
      .map((c) => ({ pillar: p.key, note: c.note, impact: c.impact as number })));

  const byImpact = [...scored].sort((a, b) => b.impact - a.impact);
  const drivers = byImpact.slice(0, FINDINGS_PER_SIDE).filter((r) => r.impact > 0);
  const drags = byImpact.slice(-FINDINGS_PER_SIDE).filter((r) => r.impact < 0).reverse();

  const findings: ScoreFinding[] = [
    ...drivers.map((r) => ({ kind: 'driver' as const, ...r })),
    ...drags.map((r) => ({ kind: 'drag' as const, ...r })),
  ];

  // Pillar-vs-pillar disagreement, widest first and only the widest few.
  const scoredPillars = pillars.filter((p) => p.score !== null);
  const pairs: { gap: number; high: ScorePillar; low: ScorePillar }[] = [];
  for (let i = 0; i < scoredPillars.length; i++) {
    for (let j = i + 1; j < scoredPillars.length; j++) {
      const a = scoredPillars[i], b = scoredPillars[j];
      const gap = Math.abs((a.score as number) - (b.score as number));
      if (gap < DIVERGENCE_GAP) continue;
      const [high, low] = (a.score as number) > (b.score as number) ? [a, b] : [b, a];
      pairs.push({ gap, high, low });
    }
  }
  for (const { high, low } of pairs.sort((x, y) => y.gap - x.gap).slice(0, DIVERGENCES_KEPT)) {
    findings.push({
      kind: 'divergence', pillar: null, impact: 0,
      note: `${high.label} ${(high.score as number).toFixed(1)}/10 gegen ${low.label} ${(low.score as number).toFixed(1)}/10 — die beiden Linsen widersprechen sich`,
    });
  }

  // Our own fair value against the market's. Both are in the composite, so
  // neither is "the" answer; the gap between them is the finding.
  const compMos = m.composite.primary.marginOfSafety;
  if (compMos !== null && cons.upside !== null && Math.abs(compMos - cons.upside) > 0.25) {
    findings.push({
      kind: 'divergence', pillar: null, impact: 0,
      note: `Composite sieht ${fmtSignedPct(compMos)} Potenzial, die Sell-Side ${fmtSignedPct(cons.upside)} — Differenz ${fmtSignedPct(compMos - cons.upside)}`,
    });
  }

  for (const cap of caps) {
    findings.push({ kind: 'cap', pillar: null, impact: 0, note: cap.reason });
  }

  // Data-quality findings travel as gaps: they are statements about the payload,
  // never about the company, and the summariser has to keep that distinction.
  for (const w of f.dataQualityWarnings ?? []) {
    findings.push({
      kind: 'gap', pillar: null, impact: 0,
      note: `${w.severity === 'error' ? 'Ungültig' : 'Einschränkung'} — ${w.code} (${w.fields.join(', ')}): ${w.message}`,
    });
  }

  // A pillar that could not be scored at all is itself worth knowing.
  for (const p of pillars) {
    if (p.score === null) {
      findings.push({
        kind: 'gap', pillar: p.key, impact: 0,
        note: `Säule "${p.label}" konnte nicht bewertet werden — keine verwertbaren Eingaben`,
      });
    }
  }

  return findings;
}

// ── Blending the two halves ──────────────────────────────────────────────────

/**
 * How much of the headline the qualitative read may ever carry.
 *
 * Not 0.5. The factor score is reproducible and its inputs are audited; the
 * narrative score is one model's reading of prose that nobody cross-checked. At
 * equal confidence the split lands near 69/31 in favour of the arithmetic, and
 * the prose only approaches parity when the numbers have lost their own
 * confidence — a flagged payload, a stale filing, half the pillars blind. That
 * is the intended behaviour: the two are not equally trustworthy, but neither
 * is trustworthy *alone*, and which one is failing is knowable.
 */
export const NARRATIVE_MAX_WEIGHT = 0.45;

/** Hard bound on the synthesis model's correction, in score points. */
export const ADJUSTMENT_LIMIT = 1;

export interface BlendInput {
  factor:              FactorScore;
  /** 0–10 from the prose-only summariser, or null when there was nothing to read. */
  narrativeScore:      number | null;
  /** 0–1, computed from how much material there was and how fresh it is. */
  narrativeConfidence: number;
  /** The synthesis model's correction, before clamping. */
  adjustment:          number;
  adjustmentReason:    string | null;
  narrativeMaxWeight?: number;
  adjustmentLimit?:    number;
}

/**
 * The one place the two scores meet.
 *
 * Both weights are confidences, so neither side argues its own case: bad data
 * hands weight to the prose automatically, a thin dossier hands it back, and a
 * run where both are weak produces a number near neutral rather than a
 * confident guess. The model's `adjustment` is applied last, clamped, and
 * recorded with its reason — it can move the headline by up to one point and no
 * further, which is at most one band.
 */
export function blendScores(input: BlendInput): FinalScore {
  const { factor } = input;
  const maxNarr = input.narrativeMaxWeight ?? NARRATIVE_MAX_WEIGHT;
  const limit   = input.adjustmentLimit ?? ADJUSTMENT_LIMIT;

  const hasNarrative = input.narrativeScore !== null && Number.isFinite(input.narrativeScore);
  const factorWeight = factor.confidence;
  const narrativeWeight = hasNarrative
    ? Math.max(0, Math.min(1, input.narrativeConfidence)) * maxNarr
    : 0;

  // Both confidences at zero is a real possibility (no coverage, no prose). The
  // arithmetic still ran, so its answer is the one on the table.
  const total = factorWeight + narrativeWeight;
  const blend = total > 0
    ? (factorWeight * factor.score + narrativeWeight * (input.narrativeScore as number)) / total
    : factor.score;

  const adjustment = Number.isFinite(input.adjustment)
    ? Math.max(-limit, Math.min(limit, input.adjustment))
    : 0;

  const score = Math.max(0, Math.min(10, blend + adjustment));

  // The caps were earned by the payload, not by the score, so they survive the
  // blend: a model cannot talk its way past a flagged balance sheet by writing
  // an enthusiastic paragraph.
  const verdict = capVerdict(verdictForScore(score), factor.caps);

  return {
    score:            Math.round(score * 100) / 100,
    verdict,
    blend:            Math.round(blend * 100) / 100,
    factorWeight:     Math.round((total > 0 ? factorWeight / total : 1) * 1000) / 1000,
    narrativeWeight:  Math.round((total > 0 ? narrativeWeight / total : 0) * 1000) / 1000,
    adjustment:       Math.round(adjustment * 100) / 100,
    adjustmentReason: adjustment === 0 ? null : input.adjustmentReason,
  };
}
