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
import { ANALYST_CONSENSUS_MODEL, borrowsToLend, reliableMargin } from './metrics.js';
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

/**
 * How far unanimity may carry the score from neutral.
 *
 * A weighted mean of six differentiated signals is necessarily less
 * differentiated than its inputs, and on a real watchlist the effect is severe:
 * the pillars of one company routinely span 6.6 points while the scores they
 * produce span barely 4, so three quarters of a list lands in one band. Nothing
 * is wrong with the arithmetic — the mean of a strong buy case and a strong
 * sell case *is* the middle.
 *
 * But two very different situations were arriving at the same number. Apple's
 * pillars read 0.2 on valuation against 8.2 on quality and 8.6 on the balance
 * sheet, and average to 4.9: a genuine standoff between lenses that disagree
 * violently. Nu Holdings scores 7.5 with every lens pointing the same way.
 * Corroboration is evidence, the mean throws it away, and the reader could not
 * tell the two apart.
 *
 * So the deviation from neutral is multiplied by how much the pillars agree.
 * Unanimity earns conviction; a standoff keeps the compromise it deserves. This
 * reorders the list, and deliberately: a corroborated 6.2 is a better case than
 * a contested 6.5, and saying so is the whole point.
 */
const MAX_CONVICTION = 1.6;

/**
 * Pillars needed before agreement means anything.
 *
 * With one scored pillar agreement is trivially perfect — there is nothing for
 * it to agree with. Confidence already shrinks a thin payload, but it must not
 * then be amplified back out by a unanimity of one.
 */
const CONVICTION_MIN_PILLARS = 3;

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

/** Median of a non-empty list; null for an empty one. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
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

// ── Intrinsic value, without the borrowed opinion ────────────────────────────

/**
 * The composite's primary tier with the sell-side target taken back out.
 *
 * The target belongs in a published fair value — it is a real third opinion and
 * the composite is right to triangulate against it. It does not belong in a
 * *pillar* that sits next to a consensus pillar reading the same source:
 * measured on a real watchlist it was in the tier for 37 of 37 stocks and made
 * up 46 % of it, so a consensus configured at 15 % actually carried 21 %.
 *
 * One model is enough here, where one was not enough with the target included.
 * The distinction is what the lone survivor would be. A single DCF or a single
 * peer-multiple is a method applied to this company's own figures; the analyst
 * target is a price forecast, and on a pre-profit name it sits far above the
 * price and scored a perfect ten on exactly the stocks we know least about.
 * Requiring two without it would blind the pillar on 16 of 37 stocks, which is
 * a worse error than reading one model and saying so.
 */
/**
 * How far a *lone* model may sit from the price and still be a valuation.
 *
 * With two or three models a wild one is medianed down by its neighbours. With
 * one there is nothing to correct it, and the ramp tops out at +60 % margin of
 * safety — so a model saying a stock is worth five times its price scores
 * exactly what a solidly cheap one does. Rubrik's lone DCF put fair value at
 * $522.81 against a $102.23 price and took the top of the ranking with it;
 * Fresenius Medical's lone Peter Lynch said $101.04 against $23.84.
 *
 * Between 0.4× and 2.5× of the price an uncorroborated model is making a claim
 * worth weighing. Outside it, it is extrapolating, and the criterion abstains
 * rather than awarding full marks for an arithmetic accident.
 */
const LONE_MODEL_BOUNDS = { low: 0.4, high: 2.5 } as const;

export function intrinsicValue(f: StockFinancials, comp: CompositeFairValueResult): {
  models: CompositeFairValueResult['primary']['models'];
  fair:   number | null;
  mos:    number | null;
  pct:    number | null;
} {
  const models = comp.primary.models.filter((m) => m.name !== ANALYST_CONSENSUS_MODEL);
  if (models.length === 0 || !(f.price > 0)) {
    return { models, fair: null, mos: null, pct: null };
  }
  const fair = median(models.map((m) => m.fairValue));
  if (fair === null) return { models, fair: null, mos: null, pct: null };

  // Corroboration is what makes an outlier survivable; one model has none.
  const ratio = fair / f.price;
  if (models.length === 1 && (ratio < LONE_MODEL_BOUNDS.low || ratio > LONE_MODEL_BOUNDS.high)) {
    return { models, fair: null, mos: null, pct: null };
  }

  return {
    models,
    fair,
    mos: (fair - f.price) / f.price,
    pct: models.filter((m) => m.fairValue > f.price).length / models.length,
  };
}

/**
 * The fair-value range, spanned by the models that produced it.
 *
 * The last number the synthesis model was still inventing, and the first live
 * run showed why that was a mistake: asked for a range, it took the lowest
 * figure on the card — a Graham/EPV floor of €74 for a growth industrial — and
 * the highest, and printed "€74–€173" beside a €208 price and a HOLD. Neither
 * end was wrong on its own; the pairing was, and nothing in the prompt could
 * have told it which figures belong together.
 *
 * The span of our own models is the honest answer, and its *width* is
 * information the invented range hid: Microsoft's models disagree from $349 to
 * $738, and a reader should see that rather than a confident bracket.
 */
export function fairValueRange(f: StockFinancials, comp: CompositeFairValueResult): string {
  const iv = intrinsicValue(f, comp);
  const values = iv.models.map((m) => m.fairValue).sort((a, b) => a - b);
  if (values.length === 0) return 'N/A';
  const P = (n: number) => fmtPrice(n, f.tradingCurrency);
  if (values.length === 1) return P(values[0]);

  // The median leads and the span follows. A bare min–max hands both ends to
  // whichever model strays furthest: ServiceNow's three models printed
  // "$39.22–$222.76", which says only that they disagree by a factor of 5.7.
  // The median is the figure the valuation pillar actually scores, and it is
  // not hostage to the outlier; the span stays beside it because the
  // disagreement is itself worth knowing.
  const mid = iv.fair ?? median(values);
  return `${P(mid as number)} (${values.length} Modelle: ${P(values[0])}–${P(values[values.length - 1])})`;
}

// ── Reading the Z-Score ──────────────────────────────────────────────────────

export type AltmanReading =
  | 'safe'
  | 'grey'
  | 'distress'        // in the distress zone, with debt it does not comfortably serve
  | 'deficit-driven'  // in the zone on net cash: an accumulated deficit, not insolvency
  | 'serviced'        // in the zone, but interest is covered many times over
  | 'unknown';

/**
 * What the Z-Score is actually saying about this company.
 *
 * Altman fitted the original Z on manufacturers and the modified Z′ on other
 * public firms. Neither sample contained a cash-rich, debt-free software company
 * carrying a decade of venture-funded losses, and two of its five terms punish
 * exactly that shape: X2 is retained earnings over assets and X3 is EBIT over
 * assets. Rubrik prints X2 = −1.15 — an accumulated deficit larger than its
 * entire balance sheet — and lands at Z = −2.52 while holding $603M in *net
 * cash*. Zeta is the same shape. Neither can default on debt it does not have,
 * and both were being held at HOLD from a BUY band for it.
 *
 * Distress means being unable to service debt, so that is what the reading
 * checks. Net cash says there is nothing to default on; interest covered at the
 * "excellent" mark says the debt that exists is comfortably served. Neither
 * makes the company healthy — it is still loss-making, and the pillar's own
 * interest-coverage and leverage criteria say so directly, on figures rather
 * than through a model estimated on a different population.
 *
 * One reading, consumed by the criterion and the cap, for the same reason
 * `readBeneish` is: the two must not disagree about whether a number is
 * evidence.
 */
export function readAltman(
  f: StockFinancials, m: ComputedMetrics,
): { reading: AltmanReading; note: string } {
  const z = m.altmanZ;
  const base = z.score !== null
    ? `Altman Z ${z.score.toFixed(2)} (${z.model}-Modell, Grenzen ${z.thresholds.distress}/${z.thresholds.safe})`
    : 'Altman Z nicht berechenbar';

  if (z.zone !== 'distress') {
    return {
      reading: z.zone === 'unknown' ? 'unknown' : z.zone,
      note: z.score !== null ? `${base} — ${z.zone}-Zone` : base,
    };
  }

  const cash = toFiniteNumber(f.totalCash) ?? 0;
  const debt = toFiniteNumber(f.totalDebt);
  const netDebt = debt === null ? null : debt - cash;

  if (netDebt !== null && netDebt <= 0) {
    return {
      reading: 'deficit-driven',
      note: `${base} — aber mit Nettoliquidität ${fmtBig(-netDebt, f.tradingCurrency)}. `
        + `Der Wert kommt aus dem kumulierten Verlustvortrag (Gewinnrücklagen/Bilanzsumme ${fmt(z.x2)}) `
        + 'und nicht aus Zahlungsunfähigkeit — ohne Nettoschulden gibt es nichts auszufallen.',
    };
  }

  if (m.interestCoverage.interpretation === 'excellent') {
    return {
      reading: 'serviced',
      note: `${base} — aber das EBIT deckt die Zinsen ${m.interestCoverage.ratio?.toFixed(1)}x. `
        + 'Die vorhandenen Schulden werden bequem bedient.',
    };
  }

  return { reading: 'distress', note: `${base} — Distress-Zone` };
}

// ── Reading the M-Score ──────────────────────────────────────────────────────

/**
 * Sales growth beyond what the M-Score was fitted on.
 *
 * Beneish estimated the model on Compustat filers whose manipulator sample
 * averaged an SGI near 1.6; the coefficient on SGI is +0.892 and the function is
 * linear, so a company growing revenue thirteenfold contributes +21 to its own
 * score on the growth term alone. Ondas prints 16.97 against a threshold of
 * −1.78. That is not a measurement, it is a linear model evaluated two orders of
 * magnitude outside its estimation range, and it should not be allowed to cap a
 * verdict.
 */
const BENEISH_SGI_OUT_OF_SAMPLE = 3.0;

/** Growth at which the SGI term starts to dominate the score. */
const BENEISH_SGI_GROWTH = 1.3;

export type BeneishReading =
  | 'not-applicable'    // a lender: receivables are the product, not a by-product
  | 'unavailable'       // too few variables to compute
  | 'clean'
  | 'grey'
  | 'flagged'           // elevated, and the accruals back it up
  | 'growth-explained'  // elevated, but earnings are cash-backed and sales grew
  | 'extrapolated';     // elevated, but the model was evaluated out of sample

/**
 * What the M-Score is actually saying about this company.
 *
 * One reading, consumed by both the balance-sheet criterion and the conviction
 * cap, because the two must not disagree about whether the same number is
 * evidence. Before this, a hypergrowth company scored 0/10 on accounting
 * quality *and* had its verdict held at HOLD, twice for the same reason, and
 * that reason was mostly its revenue growth.
 *
 * The variable that separates the two cases is TATA — total accruals over total
 * assets, `(net income − operating cash flow) / assets`. It is the one term in
 * the model that is about earnings being cash-backed rather than about growth.
 * Ondas and CoreWeave print −0.08 and −0.09: cash *exceeds* earnings, which is
 * the opposite of the pattern the score exists to find. Nvidia prints +0.08,
 * and that is a real observation about earnings quality, so its cap stays.
 */
export function readBeneish(
  f: StockFinancials, b: ComputedMetrics['beneish'],
): { reading: BeneishReading; note: string } {
  // For a lender the model's own inputs are the business. DSRI asks whether
  // receivables grew faster than sales; at a credit company that is the loan
  // book growing, which is what the company is for. SoFi came out "likely
  // manipulator" on it and had its verdict capped for running its business.
  if (borrowsToLend(f)) {
    return {
      reading: 'not-applicable',
      note: 'Beneish ist auf Kreditgeber nicht anwendbar — Forderungen sind hier das Produkt, '
        + 'nicht ein Nebenprodukt des Verkaufs, und der M-Score misst damit das Geschäftsmodell statt einer Auffälligkeit',
    };
  }
  if (b.variablesComputed < 4) {
    return {
      reading: 'unavailable',
      note: `Beneish nur aus ${b.variablesComputed}/8 Variablen — nicht belastbar`,
    };
  }
  if (b.probability === 'unlikely manipulator') {
    return { reading: 'clean', note: `Beneish M ${fmt(b.score)} — ${b.probability}` };
  }
  if (b.probability !== 'likely manipulator') {
    return { reading: 'grey', note: `Beneish M ${fmt(b.score)} — ${b.probability}` };
  }

  const sgi  = toFiniteNumber(b.sgi);
  const tata = toFiniteNumber(b.tata);

  if (sgi !== null && sgi > BENEISH_SGI_OUT_OF_SAMPLE) {
    return {
      reading: 'extrapolated',
      note: `Beneish M ${fmt(b.score)}, aber der Umsatzindex SGI steht bei ${sgi.toFixed(1)} — `
        + 'weit außerhalb des Bereichs, auf dem das Modell geschätzt wurde. Das Ergebnis ist '
        + 'Extrapolation eines linearen Modells, kein Befund.',
    };
  }

  // Cash at or above earnings is the opposite of the accrual pattern the score
  // is looking for; with sales growing fast, what is left is the growth term.
  if (sgi !== null && sgi > BENEISH_SGI_GROWTH && tata !== null && tata <= 0) {
    return {
      reading: 'growth-explained',
      note: `Beneish M ${fmt(b.score)}, getragen vom Umsatzwachstum (SGI ${sgi.toFixed(2)}). `
        + `Die Accruals widersprechen: TATA ${tata.toFixed(2)} — der operative Cashflow deckt den Gewinn.`,
    };
  }

  return {
    reading: 'flagged',
    note: `Beneish M ${fmt(b.score)} — ${b.probability}`
      + (tata !== null ? `, Accruals TATA ${tata.toFixed(2)} stützen das` : ''),
  };
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
  const iv = intrinsicValue(f, comp);

  // Intrinsic value only. The sell-side target belongs in the primary tier of a
  // *fair value* — it is a genuine third opinion — but this scorer also reads
  // the consensus as a pillar in its own right, and leaving the target in both
  // places counts it twice. Measured: the target sat in the tier for 37 of 37
  // stocks and made up 46 % of it, so a consensus configured at 15 % was
  // actually carrying 21 %. The published composite is untouched; the pillar
  // simply takes the one contributor that is not our arithmetic back out.
  const { models: intrinsic, fair, mos, pct } = iv;
  const compositeUsable = fair !== null;
  const thinNote = intrinsic.length === 1
    ? `Einziges eigenes Modell (${intrinsic[0].name}) setzt den Fair Value auf `
      + `${fmtPrice(intrinsic[0].fairValue, c)} gegen einen Kurs von ${fmtPrice(f.price, c)} — `
      + 'das liegt zu weit auseinander, um von einem unbestätigten Modell geglaubt zu werden, '
      + 'und wird daher nicht bewertet'
    : 'Kein eigenes Bewertungsmodell anwendbar (ohne das Analystenziel, '
      + 'das als eigene Säule zählt) — die Bewertung ist hier nicht prüfbar';

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
        : `Eigener Fair Value ${fmtPrice(fair, c)} vs. Kurs ${fmtPrice(f.price, c)} — MoS ${fmtSignedPct(mos)} `
          + `über ${intrinsic.length} Modelle (${intrinsic.map((x) => x.name).join(', ')})`),

    criterion('models-undervalued', 'Anteil unterbewertender Modelle', 0.20,
      pct,
      !compositeUsable ? thinNote
        : `${((pct ?? 0) * 100).toFixed(0)} % der eigenen Modelle sehen die Aktie unter Fair Value`),

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

  // The audited margin, not the flagged one — see `reliableMargin`.
  const op = reliableMargin(f, 'operatingMargin');
  const net = reliableMargin(f, 'netMargin');
  const marginRead = op.value !== null ? op : net;
  const margin = marginRead.value;
  const fromStatement = marginRead.source === 'statement'
    ? ' (Jahresabschluss — die gemeldete Trailing-Marge widerspricht ihm und ist geflaggt)'
    : '';
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
          ? `Operative Marge ${fmtPct(margin)}${fromStatement} gegen Sektormedian ${fmtPct(peerMargin)}`
          : `Operative Marge ${fmtPct(margin)}${fromStatement} (kein Peer-Vergleich verfügbar)`),

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
  const beneish = readBeneish(f, m.beneish);
  // Zone boundaries differ by model, so the ramp is built from the thresholds
  // the calculation itself used rather than from constants repeated here.
  const altman = readAltman(f, m);
  // A reading the model cannot support abstains, and the pillar renormalises
  // onto interest coverage, leverage and liquidity — which measure solvency
  // directly rather than through a model fitted on a different population.
  const zPoints = altman.reading === 'safe' || altman.reading === 'grey' || altman.reading === 'distress'
    ? (z.score !== null
        ? ramp(z.score, z.thresholds.distress, z.thresholds.safe)
        : fromLabel(altman.reading, { safe: 1, grey: 0.5, distress: 0 }))
    : null;

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
    criterion('altman', 'Altman Z-Score', 0.30, zPoints, altman.note),

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
      // A reading the model cannot support scores nothing rather than zero —
      // the same rule the F-Score and the composite already follow.
      fromLabel(beneish.reading, { clean: 1, grey: 0.5, flagged: 0 }),
      beneish.note),
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

/**
 * Weight the target keeps after the part of it that is really a drawdown.
 *
 * Measured across the watchlist, the gap between price and mean target
 * correlates −0.66 with the drawdown from the one-year high: analysts cut
 * targets far more slowly than prices fall, so "upside" is mostly a record of
 * how far a stock has dropped. The five largest upsides belonged to stocks down
 * 24 % to 75 % from their highs; the five smallest to stocks sitting within
 * three percent of theirs.
 *
 * That makes it a momentum term with the wrong sign, inside the pillar that is
 * supposed to be the one opinion independent of our own arithmetic — and it was
 * carrying 45 % of it, which is what drove the consensus pillar to a −0.43
 * correlation against momentum.
 *
 * The retained share is derived rather than picked: r² = 0.44 of the
 * criterion's variance is explained by drawdown, so it keeps the 0.56 that is
 * not. 0.45 × 0.56 ≈ 0.25. The analyst *rating* — a judgement, not a price
 * subtraction — takes the rest.
 */
const TARGET_UPSIDE_WEIGHT = 0.25;

function consensusPillar(
  f: StockFinancials, cons: AnalystConsensus, signals: MarketSignals | null,
): ScoreCriterion[] {
  const c = f.tradingCurrency;
  const drawdown = toFiniteNumber(signals?.technicals?.drawdownFromHighPct);
  // Said out loud where it is large, because a reader looking at "+80 % to the
  // mean target" deserves to know the stock is 75 % off its high.
  const stale = drawdown !== null && drawdown < -0.25 && (cons.upside ?? 0) > 0.25
    ? ` — Vorsicht: die Aktie steht ${fmtSignedPct(drawdown)} unter ihrem Jahreshoch, ein Teil dieses `
      + 'Potenzials ist der Kursrückgang und nicht die Einschätzung'
    : '';

  return [
    criterion('rating', 'Gewichtetes Analystenrating', 0.75,
      cons.score !== null ? (cons.score + 1) / 2 : null,
      cons.score !== null
        ? `${cons.label} — ${cons.total} Analysten, ${cons.buySharePct?.toFixed(0)} % Kauf, gewichteter Score ${cons.score >= 0 ? '+' : ''}${cons.score.toFixed(2)}`
        : 'Keine Analystenabdeckung für dieses Listing'),

    criterion('target-upside', 'Kursziel-Potenzial', TARGET_UPSIDE_WEIGHT,
      ramp(cons.upside, -0.10, 0.35),
      cons.upside !== null
        ? `Mittleres Kursziel ${fmtPrice(f.targetMeanPrice, c)} — ${fmtSignedPct(cons.upside)} zum Kurs ${fmtPrice(f.price, c)}${stale}`
        : 'Kein Konsens-Kursziel'),
  ];
}

/**
 * How much the pillars corroborate each other, and what that earns.
 *
 * `agreement` is |Σ w·dev| / Σ w·|dev|: the share of the evidence that survived
 * the averaging instead of being netted off against its opposite. It is
 * direction-blind — six pillars unanimously bearish agree exactly as much as
 * six unanimously bullish ones, and both deserve to be believed.
 *
 * Exported because it is the part of the score most worth arguing with, and an
 * argument needs something it can call with numbers it chose.
 */
export function convictionFor(pillars: ScorePillar[]): { agreement: number; conviction: number } {
  const scored = pillars.filter((p) => p.score !== null);
  const net = scored.reduce((s, p) => s + p.effectiveWeight * ((p.score as number) - 5), 0);
  const gross = scored.reduce((s, p) => s + p.effectiveWeight * Math.abs((p.score as number) - 5), 0);
  const agreement = gross === 0 ? 0 : Math.abs(net) / gross;

  return {
    agreement,
    conviction: scored.length >= CONVICTION_MIN_PILLARS
      ? 1 + (MAX_CONVICTION - 1) * agreement
      : 1,
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Weighted mean of the criteria that scored, plus the coverage that produced it. */
/**
 * The published resolution of a score, and the only value anything bands on.
 *
 * One decimal, because that is what every reader sees: the table, the card and
 * the badge all print `toFixed(1)`. Banding on a more precise number than the
 * one on screen puts a SELL next to a 4.5 while its neighbour at the same 4.5
 * says HOLD — the label is right about a digit nobody was shown. Ten points at
 * a tenth each is ample resolution for a ranking, and rounding here means the
 * stored value, the printed value and the banded value are one number.
 */
function published(score: number): number {
  return Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
}

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
    reducePillar('consensus', consensusPillar(f, cons, marketSignals)),
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

  const { agreement, conviction } = convictionFor(pillars);

  // Two multipliers on the same deviation, answering two different questions:
  // shrink asks how much of this we can trust, conviction how much of it the
  // lenses actually corroborate. Half-weight at zero confidence rather than a
  // collapse to 5: a blind score still has to rank, it just must not shout.
  const shrink = 0.4 + 0.6 * confidence;
  const score = published(5 + (raw - 5) * shrink * conviction);

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
  const beneish = readBeneish(f, m.beneish);
  if (beneish.reading === 'flagged') {
    caps.push({ limit: 'hold-ceiling', reason: beneish.note });
  } else if (beneish.reading === 'growth-explained' || beneish.reading === 'extrapolated') {
    // Still a ceiling, just a lower one: the flag is explained, not dismissed,
    // and an explained flag is no basis for a STRONG rating either.
    caps.push({ limit: 'no-strong', reason: beneish.note });
  }
  const altman = readAltman(f, m);
  if (altman.reading === 'distress') {
    caps.push({ limit: 'hold-ceiling', reason: altman.note });
  }

  const uncappedVerdict = verdictForScore(score);

  return {
    score,
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
    agreement:  Math.round(agreement * 1000) / 1000,
    conviction: Math.round(conviction * 1000) / 1000,
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

  // Our own fair value against the market's — and now genuinely two answers.
  // This used to compare a tier that still contained the analyst target against
  // that same target, which quietly halved every divergence it reported. Across
  // the watchlist the honest gap is wide: our models run a median 14 % below
  // price where the sell-side runs 23 % above it.
  const compMos = intrinsicValue(f, m.composite).mos;
  if (compMos !== null && cons.upside !== null && Math.abs(compMos - cons.upside) > 0.25) {
    findings.push({
      kind: 'divergence', pillar: null, impact: 0,
      note: `Die eigenen Modelle sehen ${fmtSignedPct(compMos)} Potenzial, die Sell-Side ${fmtSignedPct(cons.upside)} — Differenz ${fmtSignedPct(compMos - cons.upside)}`,
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

// ── Reading the prose more than once ─────────────────────────────────────────

/**
 * How many independent reads of the same prose the narrative score is taken from.
 *
 * Five identical runs over ServiceNow's material came back 5, 5, 5, 6, 7: mostly
 * one answer, with the occasional outlier. At up to 45 % of the headline an
 * outlier of two points moves it by most of one — enough to cross a band. The
 * median of three is the cheapest estimator that ignores a single outlier
 * outright, and the reads run in parallel, so it costs tokens (a cent or so per
 * stock on the summary model) and no wall-clock time.
 */
export const NARRATIVE_SAMPLES = 3;

/**
 * Spread between reads, in score points, at which the narrative loses all the
 * confidence a disagreement can cost it.
 *
 * Three reads of the *same* text disagreeing by three points is the text not
 * determining the answer — the model is filling in. The confidence is scaled by
 * `1 − spread / (2 × this)`, so full disagreement halves it and never removes it:
 * the median is still the best single read available.
 */
export const NARRATIVE_SPREAD_LIMIT = 3;

export interface NarrativeRead {
  summary: string;
  events:  string[];
  score:   number | null;
}

export interface CombinedNarrative<R extends NarrativeRead> {
  /** The read whose score is the median — its prose is the one kept, so text and number agree. */
  read:              R;
  score:             number | null;
  /** Highest minus lowest scoring read; null below two scoring reads. */
  spread:            number | null;
  runs:              number;
  /** Multiplier for the material confidence, from the spread. */
  confidenceFactor:  number;
}

/**
 * The median of several reads of one body of prose.
 *
 * Abstention is a vote: when most reads decline to score, the combined read
 * abstains too, rather than letting the one that did guess decide alone. Among
 * the scoring reads the kept one is the lower middle on an even count, the
 * conservative side of a tie.
 */
export function combineNarrativeReads<R extends NarrativeRead>(reads: R[]): CombinedNarrative<R> | null {
  if (reads.length === 0) return null;
  const scoring = reads
    .filter((r): r is R & { score: number } => r.score !== null && Number.isFinite(r.score))
    .sort((a, b) => a.score - b.score);

  if (scoring.length * 2 <= reads.length && scoring.length < reads.length) {
    const abstaining = reads.find((r) => r.score === null) ?? reads[0];
    return { read: abstaining, score: null, spread: null, runs: reads.length, confidenceFactor: 1 };
  }

  const median = scoring[Math.floor((scoring.length - 1) / 2)];
  const spread = scoring.length >= 2 ? scoring[scoring.length - 1].score - scoring[0].score : null;
  const confidenceFactor = spread === null
    ? 1
    : 1 - Math.min(spread, NARRATIVE_SPREAD_LIMIT) / (2 * NARRATIVE_SPREAD_LIMIT);
  return { read: median, score: median.score, spread, runs: reads.length, confidenceFactor };
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

/**
 * The share of its weight the factor half keeps when its pillars cancel.
 *
 * Confidence answers "can this payload be trusted". It does not answer "does it
 * say anything", and those come apart: Apple's data is impeccable — confidence
 * 0.86 — and its pillars read 0.2 on valuation against 8.2 on quality, netting
 * to a 4.9 that is a standoff rather than a verdict. Weighted by confidence
 * alone, that non-statement outvoted the prose three to one.
 *
 * So the factor half is weighted by both: trusted *and* saying something. Where
 * the lenses cancel it keeps half its weight and the qualitative read gets room
 * — which is exactly where a qualitative read is worth most, because the numbers
 * have already declared a draw.
 */
export const FACTOR_WEIGHT_FLOOR = 0.5;

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

  // Trusted *and* saying something. `agreement` is 0 when the pillars cancel,
  // and a score that is 5.0 because its evidence nets off is not an opinion the
  // blend should defend at full strength.
  const factorWeight = factor.confidence
    * (FACTOR_WEIGHT_FLOOR + (1 - FACTOR_WEIGHT_FLOOR) * factor.agreement);
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

  const score = published(blend + adjustment);

  // The caps were earned by the payload, not by the score, so they survive the
  // blend: a model cannot talk its way past a flagged balance sheet by writing
  // an enthusiastic paragraph.
  const verdict = capVerdict(verdictForScore(score), factor.caps);

  return {
    score,
    verdict,
    blend:            Math.round(blend * 100) / 100,
    factorWeight:     Math.round((total > 0 ? factorWeight / total : 1) * 1000) / 1000,
    narrativeWeight:  Math.round((total > 0 ? narrativeWeight / total : 0) * 1000) / 1000,
    adjustment:       Math.round(adjustment * 100) / 100,
    adjustmentReason: adjustment === 0 ? null : input.adjustmentReason,
  };
}
