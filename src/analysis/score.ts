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
  FinalScore, MarketSignals, PILLAR_KEYS, PillarKey, Recommendation, ScoreCap, ScoreCriterion,
  ScoreFinding, ScorePillar, SectorMedians, StockFinancials, TechnicalSignals,
  NarrativeDimensions,
} from '../types.js';
import { ComputedMetrics } from './computeMetrics.js';
import { FITTED_WEIGHTS } from './weight-table.js';
import {
  ANALYST_CONSENSUS_MODEL, BeneishReading, FAIR_VALUE_BOUNDS, PEER_MULTIPLES_MODEL, aggregateFairValue, beneishReading,
  reliableMargin,
} from './metrics.js';
import { borrowsToLend, isBalanceSheetFinancial } from './dcf.js';
import { adjustedCurrentRatio } from './health.js';
import { calibrated } from './calibration.js';
import { valuationBasis } from './basis.js';
import { worstSeverity } from './data-quality.js';
import { netIssuance } from './payout.js';
// The notes are German sentences, so their numbers are German too: "0,1x", "12,5 %".
import {
  deNumber, fmtDe as fmt, fmtBigDe as fmtBig, fmtPctDe as fmtPct, fmtPriceDe as fmtPrice, fmtSignedPctDe as fmtSignedPct,
} from '../format.js';

// The metrics' readings are English enum values; a German note names them in German.
const ALTMAN_ZONE_DE = { safe: 'sichere Zone', grey: 'Grauzone', distress: 'Gefahrenzone', unknown: 'Zone unbekannt' } as const;
const BENEISH_DE = {
  'likely manipulator': 'auffällig', 'grey zone': 'Grauzone', 'unlikely manipulator': 'unauffällig', unknown: 'nicht bestimmbar',
} as const;
const PIOTROSKI_DE = { strong: 'stark', neutral: 'mittel', weak: 'schwach' } as const;
const COVERAGE_DE = {
  excellent: 'exzellent', good: 'gut', fair: 'ausreichend', poor: 'schwach', critical: 'kritisch', unknown: 'unbekannt',
} as const;
import { toFiniteNumber } from '../utils/num.js';
import { SCORE_BANDS, verdictForScore } from '../verdict.js';

// ── Configuration ────────────────────────────────────────────────────────────
//
// The types live in `src/types.ts` with every other schema, because the metric
// catalogue derives its series from them and a schema reaching back into the
// analysis layer would close an import cycle. What stays in this file is the
// part that is genuinely scoring policy: the weights, the bands and the ramps
// below, plus the two blend constants, which sit with the blend itself at the
// bottom rather than here — they belong to the sentence that explains them.

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

/** Everything the arithmetic weighs: the pillars, and the criteria inside each. */
export interface ScoreWeights {
  /** What each pillar is worth. Sums to 1. */
  pillars:  Readonly<Record<PillarKey, number>>;
  /** What each criterion is worth inside its pillar, by its `key`; renormalised over the ones that scored. */
  criteria: Readonly<Record<PillarKey, Readonly<Record<string, number>>>>;
}

/** Weights the backtest fitted, for the pillars and criteria it could measure (`weight-table.ts`). */
export interface FittedWeights {
  pillars:  Partial<Record<PillarKey, number>>;
  criteria: Partial<Record<PillarKey, Record<string, number>>>;
}

/** Where a committed fit came from: when, and over which month-ends. */
export interface WeightFitMeta {
  generatedAt: string;
  from:        string;
  to:          string;
  months:      number;
  companies:   number;
}

/**
 * The weights as judgment set them.
 *
 * Valuation leads because the question the tool answers is "is this worth its
 * price", and consensus is weighted like a real second opinion rather than a
 * tiebreaker — it is the only input here not derived from our own arithmetic,
 * which is exactly what made an uncovered stock dangerous before.
 *
 * These are the prior, not necessarily the weights in force. The backtest
 * measures how well each criterion ranked the month that followed, tilts these
 * weights by it, and checks the tilt on years the fit did not see
 * (`backtest/weights.ts`); a fit that held up is generated into
 * `weight-table.ts` and takes their place below. The fit always starts from
 * here, so running it again over the same months gives the same weights rather
 * than tilting them further.
 */
export const JUDGMENT_WEIGHTS: ScoreWeights = {
  pillars: {
    valuation: 0.30,
    quality:   0.20,
    health:    0.15,
    consensus: 0.15,
    momentum:  0.10,
    revisions: 0.10,
  },
  criteria: {
    valuation: { 'intrinsic': 0.35, 'peer-multiples': 0.20, 'market-implied': 0.25, 'value-lens': 0.20 },
    quality: {
      'piotroski': 0.20, 'roic-spread': 0.20, 'gross-profitability': 0.15, 'margin': 0.15,
      'growth': 0.10, 'accruals': 0.10, 'net-issuance': 0.05, 'rule-of-40': 0.05,
    },
    health:    { 'altman': 0.30, 'interest-cover': 0.25, 'leverage': 0.25, 'liquidity': 0.10, 'beneish': 0.10 },
    consensus: { 'rating': 1 - TARGET_UPSIDE_WEIGHT, 'target-upside': TARGET_UPSIDE_WEIGHT },
    momentum:  { 'momentum-12-1': 0.50, '52w-high': 0.30, 'rs-sector': 0.20 },
    revisions: { 'eps-drift': 0.35, 'revision-breadth': 0.30, 'surprises': 0.20, 'rating-drift': 0.15 },
  },
};

/** The judgment with a fit laid over it, pillar by pillar and criterion by criterion. */
export function withFitted(base: ScoreWeights, fitted: FittedWeights | null): ScoreWeights {
  if (!fitted) return base;
  return {
    pillars:  { ...base.pillars, ...fitted.pillars },
    criteria: Object.fromEntries(PILLAR_KEYS.map((p) => [p, { ...base.criteria[p], ...fitted.criteria[p] }])) as ScoreWeights['criteria'],
  };
}

/**
 * The weights in force: the judgment, with what the backtest fitted in its
 * place. What the backtest cannot measure keeps its judgment weight — the
 * estimate revisions and surprises, which have no history; the consensus it
 * rebuilds from the rating history.
 */
export const WEIGHTS: ScoreWeights = withFitted(JUDGMENT_WEIGHTS, FITTED_WEIGHTS);

/** What each pillar is worth, as in force. Sums to 1. */
export const PILLAR_WEIGHTS = WEIGHTS.pillars;

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
 * How far from neutral the lenses must sit, on average, before their agreement
 * earns the full stretch: the BUY band's distance from 5, read from the bands.
 *
 * Agreement counts directions, not distances. MercadoLibre's pillars ran from
 * 5.0 to 7.1 — a weighted mean distance of 1.18 points, against a watchlist
 * median near 2.5 — and still agreed perfectly and took the full 1.6×: six
 * mild leans multiplied as if they were six convictions. A lean smaller than
 * the distance to a BUY verdict is a weak vote for either direction, so below
 * it the stretch scales down in proportion. Above it — everything on the list
 * except MercadoLibre today — nothing changes.
 */
const CONVICTION_FULL_STRENGTH = (SCORE_BANDS.find((b) => b.verdict === 'BUY')?.min ?? 6.5) - 5;

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
 * with wildly different scales, and read in logs so it is neutral where it
 * should be: at the peer median, 5. The old ramp from 0.6× to 1.6× put the
 * neutral point at 1.1× — trading at the median read as slightly cheap. Now
 * 1/1.6 of the median scores full marks and 1.6× none. Non-positive values on
 * either side are meaningless here (a negative P/E is not "cheap"), so they
 * read as missing.
 */
function relativeMultiple(own: number | null | undefined, median: number | null | undefined): number | null {
  const o = toFiniteNumber(own);
  const m = toFiniteNumber(median);
  if (o === null || m === null || o <= 0 || m <= 0) return null;
  return ramp(Math.log(o / m), RELATIVE_MULTIPLE_RANGE, -RELATIVE_MULTIPLE_RANGE);
}

/** How far from the peer median, in logs, a multiple reads 0 or 10: 1.6× and 1/1.6. */
const RELATIVE_MULTIPLE_RANGE = Math.log(1.6);

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
 * With two or three models a wild one is held to the bounds and medianed with
 * its neighbours. With one there is nothing to correct it, and the ramp tops
 * out at +60 % margin of safety — so a model saying a stock is worth five times
 * its price scored exactly what a solidly cheap one does. Rubrik's lone DCF put
 * fair value at $522.81 against a $102.23 price and took the top of the ranking
 * with it; Fresenius Medical's lone Peter Lynch said $101.04 against $23.84.
 *
 * Inside the bounds an uncorroborated model is making a claim worth weighing.
 * Outside them it is extrapolating, and the criterion abstains rather than
 * awarding full marks for an arithmetic accident. The bounds are the ones every
 * model is held to before aggregation (`FAIR_VALUE_BOUNDS`).
 */
export function intrinsicValue(
  f: StockFinancials, comp: CompositeFairValueResult, opts: { absoluteOnly?: boolean } = {},
): {
  models: CompositeFairValueResult['primary']['models'];
  fair:   number | null;
  mos:    number | null;
  pct:    number | null;
} {
  // The peer multiple is its own criterion in the valuation pillar; counting it
  // again inside the intrinsic value would give the relative lens two votes.
  const models = comp.primary.models.filter((m) => m.name !== ANALYST_CONSENSUS_MODEL
    && !(opts.absoluteOnly && m.name === PEER_MULTIPLES_MODEL));
  if (models.length === 0 || !(f.price > 0)) {
    return { models, fair: null, mos: null, pct: null };
  }
  // Corroboration is what makes an outlier survivable; one model has none.
  if (models.length === 1) {
    const ratio = models[0].fairValue / f.price;
    if (ratio < FAIR_VALUE_BOUNDS.low || ratio > FAIR_VALUE_BOUNDS.high) return { models, fair: null, mos: null, pct: null };
  }
  // Each model held to the bounds, then the weighted mean of their logs: a
  // median over two numbers is their mean, and Berkshire's pair of a broken
  // peer multiple and an uncapped Lynch value came to +442 %.
  const fair = aggregateFairValue(f.price, models, FAIR_VALUE_BOUNDS);
  if (fair === null) return { models, fair: null, mos: null, pct: null };

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
  if (values.length === 0) return '—';
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
  | 'out-of-sample'   // a utility: a population no Z-Score variant was fitted on
  | 'unknown';

/**
 * Sectors no Z-Score variant was estimated on.
 *
 * Altman's samples were manufacturers (Z) and non-manufacturing industrials
 * (Z′, Z″); utilities were left out of all of them, as financials were. Their
 * shape defeats the terms on sight: asset turnover (X5) is structurally low for
 * a fleet of power plants, working capital (X1) runs negative by design, and
 * retained earnings (X2) say more about accounting history than solvency. Vistra
 * prints X2 ≈ 0 — it emerged from the Energy Future Holdings bankruptcy under
 * fresh-start accounting in 2016 and has distributed since — and X5 = 0.46, and
 * lands at Z = 1.33 "distress" while issuing $1.5 B of notes into a market that
 * took them. The zone was costing it 30 % of the health pillar and capping the
 * verdict at HOLD; interest coverage and leverage, which the pillar reads
 * directly, are the figures that actually measure a utility's solvency.
 */
export const ALTMAN_EXCLUDED_SECTORS = ['Utilities'];

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
    ? `Altman Z ${deNumber(z.score, 2)} (${z.model}-Modell, Grenzen ${z.thresholds.distress}/${z.thresholds.safe})`
    : 'Altman Z nicht berechenbar';

  if (f.sector && ALTMAN_EXCLUDED_SECTORS.includes(f.sector) && z.score !== null) {
    return {
      reading: 'out-of-sample',
      note: `${base} — nicht gewertet: kein Z-Score-Modell wurde auf Versorgern geschätzt `
        + `(niedriger Kapitalumschlag ${fmt(z.x5)} und negatives Working Capital sind dort Normalfall). `
        + 'Solvenz lesen hier Zinsdeckung und Verschuldung direkt.',
    };
  }

  if (z.zone !== 'distress') {
    return {
      reading: z.zone === 'unknown' ? 'unknown' : z.zone,
      note: z.score !== null ? `${base} — ${ALTMAN_ZONE_DE[z.zone]}` : base,
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
      note: `${base} — aber das EBIT deckt die Zinsen ${fmt(m.interestCoverage.ratio, 'x', 1)}. `
        + 'Die vorhandenen Schulden werden bequem bedient.',
    };
  }

  return { reading: 'distress', note: `${base} — Gefahrenzone` };
}

// ── Reading the M-Score ──────────────────────────────────────────────────────

export type { BeneishReading } from './metrics.js';

export function readBeneish(
  f: StockFinancials, b: ComputedMetrics['beneish'],
): { reading: BeneishReading; note: string } {
  const reading = beneishReading(f, b);
  const sgi  = toFiniteNumber(b.sgi);
  const tata = toFiniteNumber(b.tata);
  switch (reading) {
    // For a lender the model's own inputs are the business. DSRI asks whether
    // receivables grew faster than sales; at a credit company that is the loan
    // book growing, which is what the company is for.
    case 'not-applicable':
      return {
        reading,
        note: 'Beneish ist auf Kreditgeber nicht anwendbar — Forderungen sind hier das Produkt, '
          + 'nicht ein Nebenprodukt des Verkaufs, und der M-Score misst damit das Geschäftsmodell statt einer Auffälligkeit',
      };
    case 'unavailable':
      return { reading, note: `Beneish nur aus ${b.variablesComputed}/8 Variablen — nicht belastbar` };
    case 'clean':
    case 'grey':
      return { reading, note: `Beneish M ${fmt(b.score)} — ${BENEISH_DE[b.probability]}` };
    case 'extrapolated':
      return {
        reading,
        note: `Beneish M ${fmt(b.score)}, aber der Umsatzindex SGI steht bei ${fmt(sgi, '', 1)} — `
          + 'weit außerhalb des Bereichs, auf dem das Modell geschätzt wurde. Das Ergebnis ist '
          + 'Extrapolation eines linearen Modells, kein Befund.',
      };
    case 'growth-explained':
      return {
        reading,
        note: `Beneish M ${fmt(b.score)}, getragen vom Umsatzwachstum (SGI ${fmt(sgi)}). `
          + `Die Accruals widersprechen: TATA ${fmt(tata)} — der operative Cashflow deckt den Gewinn.`,
      };
    case 'flagged':
      return {
        reading,
        note: `Beneish M ${fmt(b.score)} — ${BENEISH_DE[b.probability]}`
          + (tata !== null ? `, Accruals TATA ${deNumber(tata, 2)} stützen das` : ''),
      };
  }
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

/** A criterion as its pillar reads it; what it is worth comes from the weights (`assembleScore`). */
type Draft = Omit<ScoreCriterion, 'weight' | 'impact'>;

/** Local builder so each pillar reads as a list of criteria and nothing else. */
function criterion(
  key: string, label: string, points: number | null, note: string, value: number | null = null,
): Draft {
  return { key, label, points, note, value: value !== null && Number.isFinite(value) ? value : null };
}

/**
 * What the price requires, against what the business can plausibly earn.
 *
 * Every other valuation criterion asks "what is it worth" from our own
 * assumptions — a growth rate, a discount rate, a multiple. This one inverts
 * the question: take the consensus revenue path as given and solve for the
 * steady margin at which today's enterprise value is fair (the reverse SVR in
 * `calculateImpliedMargin`). That is the lens a growth investor actually uses,
 * and it is the one the conservative models cannot supply.
 *
 * Margin rather than the reverse DCF's implied FCF growth, deliberately. The
 * reverse DCF solves for *free-cash-flow* growth and the only forward figure to
 * hold it against is *revenue* growth; the two agree only while margins are
 * stable. Intel "required 64 % growth against 13 % consensus" because its free
 * cash flow was depressed, not because its price was absurd. Solving for the
 * margin on the consensus revenue path compares like with like.
 *
 * The yardstick is the best margin the business has *already shown* — after-tax
 * operating margin or free-cash-flow margin, whichever is higher — or the peer
 * median after tax where a real peer group exists. Operating margin alone
 * punished exactly the firms the lens is for: UiPath earns 3 % GAAP but 31 %
 * free cash flow, and the requirement (19 %) is itself a free-cash-flow margin,
 * so the second is the like-for-like comparison. Peers only from five up: the
 * medians of thin groups ran from −53 % to 1.5 % for companies nobody would
 * call loss-making. Generous by design — the conservative lens is already three
 * criteria strong — and abstaining where no positive margin exists to hold the
 * requirement against.
 */
export interface MarketImplied {
  required:  number;
  benchmark: number;
  /** required ÷ benchmark: 1 is priced for exactly the achievable margin. */
  ratio:     number;
  basis:     'current' | 'history' | 'peers';
}

const IMPLIED_BASIS_LABEL: Record<MarketImplied['basis'], string> = {
  current: 'heutige operative Marge',
  history: 'Durchschnitt der letzten Geschäftsjahre',
  peers:   'Peer-Median',
};

/** Ratio at which the criterion reads 0 (and its inverse, 10) — log-symmetric around 1. */
export const IMPLIED_MARGIN_RATIO_LIMIT = 2;

export function marketImplied(
  _f: StockFinancials, m: ComputedMetrics, _peers: SectorMedians | null,
): MarketImplied | null {
  const im = m.reverseDCF.impliedMargin;
  const benchmark = toFiniteNumber(im?.achievableMargin);
  if (!im || benchmark === null || benchmark <= 0 || im.achievableBasis === null) return null;
  return {
    required:  im.requiredMargin,
    benchmark,
    ratio:     Math.max(im.requiredMargin, 0) / benchmark,
    basis:     im.achievableBasis,
  };
}

/** Fewest conservative models whose median counts as the value lens. */
export const CONSERVATIVE_MIN_MODELS = 2;

/**
 * The reference group a lender's value lens is read in, as a sector would be.
 *
 * For a bank, insurer or lender the lens comes down to Graham's number and V*
 * — EPV has no free cash flow to the firm to work on, and the excess return
 * model is its headline value — and both are rules on its P/E and its P/B,
 * which leverage keeps low. Against every stock nearly all of them sat at the
 * top: 8.3 of 10 in dollars, 8.2 in euros, against 4.9 for the rest, and the
 * backtest found nothing in that tilt (the lens ranks the month at 0.010,
 * t 1.0, across the market and 0.006 within sectors). Among themselves the same
 * figures still say which one is cheap for a lender. Not their whole sector:
 * card networks, exchanges and asset managers would then sit beside the banks
 * and read as dear for not borrowing.
 */
export const LENDER_REFERENCE = 'lenders';

function valuationPillar(
  f: StockFinancials, m: ComputedMetrics, peers: SectorMedians | null,
): Draft[] {
  const c = f.tradingCurrency;
  const P = (x: number | null | undefined) => fmtPrice(x ?? null, c);
  const comp: CompositeFairValueResult = m.composite;

  // ── 1. What it is worth, with the uncertainty of that ──────────────────────
  // The DCF answers with 512 scenarios, and the share of them above the price
  // is the figure read: a wide distribution lands near the middle instead of
  // claiming a margin of safety it cannot support. It is read against where the
  // reference stocks land, not against one half: the model fades growth faster
  // than the market's own implied premium assumes, so it finds most large caps
  // dear, and that is a property of the model, not information about any one
  // stock. Where there is no DCF (a lender, a firm with no margin to converge
  // to), the remaining models of our own — the excess return model, Lynch's
  // rule — are read in logs against the price.
  const dist = m.dcf.distribution;
  let intrinsic: { points: number | null; note: string; value: number | null };
  if (dist) {
    intrinsic = {
      points: calibrated('valuation.intrinsic', dist.probabilityAbovePrice, 1, (v) => v),
      value:  dist.probabilityAbovePrice,
      note:   `DCF: ${deNumber(dist.probabilityAbovePrice * 100, 0)} % der ${dist.draws} Szenarien über dem Kurs — `
        + `Median ${P(dist.p50)}, 80 %-Spanne ${P(dist.p10)}–${P(dist.p90)} gegen ${P(f.price)}`,
    };
  } else {
    const iv = intrinsicValue(f, comp, { absoluteOnly: true });
    const x = iv.fair !== null ? Math.log(iv.fair / f.price) : null;
    intrinsic = x !== null
      ? {
          points: calibrated('valuation.intrinsic-models', x, 1, (v) => ramp(v, -Math.LN2, Math.LN2)),
          value:  x,
          note:   `Eigener Wert ${P(iv.fair)} gegen ${P(f.price)} (${fmtSignedPct(iv.mos)}) aus `
            + `${iv.models.map((x) => x.name).join(', ')} — kein DCF: ${m.dcf.assumptions}`,
        }
      : {
          points: null,
          value:  null,
          note:   iv.models.length === 1
            ? `Einziges eigenes Modell (${iv.models[0].name}) setzt den Wert auf ${P(iv.models[0].fairValue)} gegen `
              + `${P(f.price)} — zu weit auseinander, um von einem unbestätigten Modell geglaubt zu werden`
            : `Kein eigenes Bewertungsmodell anwendbar — ${m.dcf.assumptions}`,
        };
  }

  // ── 2. What comparable firms trade at ───────────────────────────────────────
  const relParts = [
    relativeMultiple(m.ratios.pe,                peers?.pe),
    relativeMultiple(m.evMultiples.evToEbitda,   peers?.evToEbitda),
    relativeMultiple(m.evMultiples.priceToSales, peers?.priceToSales),
    relativeMultiple(m.evMultiples.priceToFCF,   peers?.priceToFCF),
  ];
  const rel = meanOf(relParts);
  const relCount = relParts.filter((p) => p !== null).length;

  // ── 3. What the price requires ──────────────────────────────────────────────
  const implied = marketImplied(f, m, peers);
  const lim = Math.log(IMPLIED_MARGIN_RATIO_LIMIT);
  const impliedGrowth = m.reverseDCF.impliedMargin?.revenueGrowth;

  // ── 4. The value lens ───────────────────────────────────────────────────────
  // One surviving model is not a lens: Berkshire's conservative tier came down
  // to Graham's V* alone and scored 10/10 on it. Two or more, or nothing. The
  // conservative models sit below the price for almost every growing firm by
  // design, so their neutral point is where the reference stocks sit, not 0.
  const consModels = comp.conservative.models.length;
  const consMedian = consModels >= CONSERVATIVE_MIN_MODELS ? comp.conservative.median : null;
  const consLog = consMedian !== null && consMedian > 0 ? Math.log(consMedian / f.price) : null;
  const lender = borrowsToLend(f);

  return [
    criterion('intrinsic', 'Innerer Wert (DCF-Szenarien)', intrinsic.points, intrinsic.note, intrinsic.value),

    criterion('peer-multiples', 'Multiples gegen Peer-Median',
      rel,
      rel !== null
        ? `${relCount} Multiples gegen ${peers?.peerCount ?? 0} Peers: P/E ${fmt(m.ratios.pe, 'x')} vs. ${fmt(peers?.pe, 'x')}, `
          + `EV/EBITDA ${fmt(m.evMultiples.evToEbitda, 'x')} vs. ${fmt(peers?.evToEbitda, 'x')}`
        : 'Keine Peer-Mediane verfügbar — relative Bewertung nicht prüfbar',
      rel),

    criterion('market-implied', 'Was der Kurs verlangt',
      implied
        ? calibrated('valuation.market-implied', Math.log(Math.max(implied.ratio, 1e-6)), -1, (v) => ramp(v, lim, -lim))
        : null,
      implied
        ? `Der Kurs ist fair bei einer operativen Zielmarge von ${fmtPct(implied.required)} auf dem Umsatzpfad `
          + `(${fmtPct(impliedGrowth ?? null)} Wachstum, auslaufend) — gezeigt wurden ${fmtPct(implied.benchmark)} `
          + `(${IMPLIED_BASIS_LABEL[implied.basis]}), verlangt also das ${deNumber(implied.ratio, 1)}-fache`
        : 'Keine positive Marge, an der sich die vom Kurs verlangte messen ließe',
      implied ? Math.log(Math.max(implied.ratio, 1e-6)) : null),

    criterion('value-lens', 'Value-Lens (konservative Modelle)',
      calibrated('valuation.value-lens', consLog, 1, (v) => ramp(v, Math.log(0.5), Math.log(1.3)),
        { sector: lender ? LENDER_REFERENCE : null }),
      comp.conservative.median !== null
        ? consMedian !== null
          ? `Konservativer Wert ${P(consMedian)} gegen ${P(f.price)} (${fmtSignedPct(consMedian / f.price - 1)}) `
            + `aus ${comp.conservative.models.map((x) => x.name).join(', ')}`
            + (lender ? ' — gelesen gegen andere Banken, Versicherer und Kreditgeber' : '')
          : `Nur ein konservatives Modell anwendbar (${comp.conservative.models[0].name}) — keine Linse, nicht gewertet`
        : 'Keine konservativen Modelle anwendbar',
      consLog),
  ];
}

function qualityPillar(
  f: StockFinancials, m: ComputedMetrics, peers: SectorMedians | null,
): Draft[] {
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

  // The audited margin, not the flagged one — see `reliableMargin`. Operating
  // against operating and net against net: the peer fallback used to put a
  // company's operating margin beside its peers' net one.
  const op = reliableMargin(f, 'operatingMargin');
  const net = reliableMargin(f, 'netMargin');
  const pair = op.value !== null && peers?.operatingMargin != null
    ? { own: op, peer: peers.operatingMargin, kind: 'Operative' }
    : net.value !== null && peers?.netMargin != null
      ? { own: net, peer: peers.netMargin, kind: 'Netto-' }
      : { own: op.value !== null ? op : net, peer: null as number | null, kind: op.value !== null ? 'Operative' : 'Netto-' };
  const margin = pair.own.value;
  const fromStatement = pair.own.source === 'statement'
    ? ' (Jahresabschluss — die gemeldete Trailing-Marge widerspricht ihm und ist geflaggt)'
    : '';
  const marginGap = margin !== null && pair.peer !== null ? margin - pair.peer : null;

  // Four quarters against four on both sides now; Yahoo's figure was one
  // quarter against its year-ago quarter, compared with the peers' twelve months.
  const growth = valuationBasis(f).revenueGrowth;
  const peerGrowth = toFiniteNumber(peers?.revenueGrowthYoY);
  const growthGap = growth !== null && peerGrowth !== null ? growth - peerGrowth : null;

  // Read within the sector wherever a sector is deep enough: a utility's
  // margins and a software company's are not one scale (`calibrated`).
  const inSector = { sector: f.sector };

  // Three figures the research keeps finding and the pillar did not read. For
  // a lender none of them means anything: its gross profit is its interest
  // margin and its cash flow from operations is its loan book moving.
  const lender = isBalanceSheetFinancial(f) || borrowsToLend(f);
  const assets = toFiniteNumber(f.totalAssets);
  const priorAssets = toFiniteNumber(f.prevYear?.totalAssets);
  const avgAssets = assets !== null && assets > 0
    ? (priorAssets !== null && priorAssets > 0 ? (assets + priorAssets) / 2 : assets) : null;
  const gp = toFiniteNumber(f.grossProfit);
  const grossProfitability = !lender && gp !== null && assets !== null && assets > 0 ? gp / assets : null;
  const ni = toFiniteNumber(f.netIncome);
  const ocf = toFiniteNumber(f.operatingCashFlow);
  const accruals = !lender && ni !== null && ocf !== null && avgAssets !== null ? (ni - ocf) / avgAssets : null;
  const issuance = netIssuance(f);

  return [
    criterion('piotroski', 'Piotroski F-Score',
      calibrated('quality.piotroski', pioRatio, 1, (v) => ramp(v, 0.35, 0.90)),
      pio.maxScore >= PIOTROSKI_MIN_SIGNALS
        ? `F-Score ${pio.score}/${pio.maxScore} (${PIOTROSKI_DE[pio.interpretation]})`
        : `F-Score nur aus ${pio.maxScore}/9 berechenbaren Signalen — nicht belastbar`,
      pioRatio),

    criterion('roic-spread', 'ROIC über Kapitalkosten',
      calibrated('quality.roic-spread', excess, 1, (v) => ramp(v, -0.05, 0.15), inSector),
      excess !== null
        ? `ROIC ${fmtPct(roic)} gegen WACC ${fmtPct(wacc)} — Spread ${fmtSignedPct(excess)}`
        : 'ROIC oder WACC nicht berechenbar',
      excess),

    // Novy-Marx (2013): gross profit over assets ranks future returns about as
    // well as book-to-market does, and in the opposite stocks. It is measured
    // before the lines a business can shape — marketing, research, one-offs.
    criterion('gross-profitability', 'Bruttogewinn / Bilanzsumme',
      calibrated('quality.gross-profitability', grossProfitability, 1, (v) => ramp(v, 0, 0.6), inSector),
      grossProfitability !== null
        ? `Bruttogewinn ${fmtPct(grossProfitability)} der Bilanzsumme (vier Quartale)`
        : lender ? 'Für Kreditgeber nicht aussagekräftig' : 'Kein Bruttogewinn ausgewiesen',
      grossProfitability),

    criterion('margin', 'Marge',
      marginGap !== null ? calibrated('quality.margin-vs-peers', marginGap, 1, (v) => ramp(v, -0.10, 0.10))
        : calibrated('quality.margin', margin, 1, (v) => ramp(v, -0.05, 0.25), inSector),
      margin === null ? 'Keine Margendaten'
        : pair.peer !== null
          ? `${pair.kind}marge ${fmtPct(margin)}${fromStatement} gegen Peer-Median ${fmtPct(pair.peer)}`
          : `${pair.kind}marge ${fmtPct(margin)}${fromStatement} (kein Peer-Vergleich verfügbar)`,
      marginGap ?? margin),

    criterion('growth', 'Umsatzwachstum',
      growthGap !== null ? calibrated('quality.growth-vs-peers', growthGap, 1, (v) => ramp(v, -0.125, 0.125))
        : calibrated('quality.growth', growth, 1, (v) => ramp(v, -0.05, 0.25), inSector),
      growth === null ? 'Kein Umsatzwachstum ausgewiesen'
        : peerGrowth !== null
          ? `Umsatzwachstum ${fmtSignedPct(growth)} (vier Quartale) gegen Peer-Median ${fmtSignedPct(peerGrowth)}`
          : `Umsatzwachstum ${fmtSignedPct(growth)} (vier Quartale)`,
      growthGap ?? growth),

    // Sloan (1996): earnings well ahead of the cash behind them tend not to
    // last, and the market is slow to notice. Less is better.
    criterion('accruals', 'Accruals (Gewinn über Cashflow)',
      calibrated('quality.accruals', accruals, -1, (v) => ramp(v, 0.08, -0.08), inSector),
      accruals !== null
        ? `Gewinn minus operativer Cashflow ${fmtSignedPct(accruals)} der Bilanzsumme (vier Quartale)`
        : lender ? 'Für Kreditgeber nicht aussagekräftig' : 'Gewinn oder operativer Cashflow fehlt',
      accruals),

    // Pontiff and Woodgate (2008): companies that issue shares go on to trail,
    // companies that buy them back to lead. Split-adjusted, diluted where both
    // years report it — the same count Piotroski's F7 reads.
    criterion('net-issuance', 'Netto-Aktienausgabe',
      calibrated('quality.net-issuance', issuance, -1, (v) => ramp(v, 0.05, -0.03), inSector),
      issuance !== null
        ? `Aktienzahl ${fmtSignedPct(issuance)} gegenüber dem Vorjahr (${issuance > 0 ? 'Verwässerung' : issuance < 0 ? 'Rückkäufe' : 'unverändert'})`
        : 'Keine Aktienzahlen für zwei Geschäftsjahre',
      issuance),

    criterion('rule-of-40', 'Rule of 40',
      calibrated('quality.rule-of-40', m.ruleOf40.score, 1, (v) => ramp(v, 20, 60), inSector),
      m.ruleOf40.score !== null
        ? `Rule of 40: ${deNumber(m.ruleOf40.score, 1)} (${m.ruleOf40.passes ? 'bestanden' : 'verfehlt'})`
        : 'Rule of 40 nicht berechenbar',
      m.ruleOf40.score),
  ];
}

// `adjustedCurrentRatio` lives with the balance-sheet checklist in `health.ts`,
// which asks the same question of the same figure; re-exported for the tests.
export { adjustedCurrentRatio, DEFERRED_REVENUE_MIN_SHARE } from './health.js';

/**
 * Interest coverage a debt-free, profitable firm is read at: nothing to cover
 * is better than any ratio a borrower reports.
 */
const DEBT_FREE_COVERAGE = 1000;

function healthPillar(f: StockFinancials, m: ComputedMetrics): Draft[] {
  const z = m.altmanZ;
  const liquidity = adjustedCurrentRatio(f);
  const beneish = readBeneish(f, m.beneish);
  // Zone boundaries differ by model, so the Z-Score is read as its position
  // between the model's own distress and safe thresholds — 0 at distress, 1 at
  // safe — which puts Z and Z″ on one scale. A reading the model cannot
  // support abstains, and the pillar renormalises onto interest coverage,
  // leverage and liquidity.
  const altman = readAltman(f, m);
  const zPosition = (altman.reading === 'safe' || altman.reading === 'grey' || altman.reading === 'distress') && z.score !== null
    ? (z.score - z.thresholds.distress) / (z.thresholds.safe - z.thresholds.distress)
    : null;

  const cash = toFiniteNumber(f.totalCash) ?? 0;
  const debt = toFiniteNumber(f.totalDebt);
  const ebitda = toFiniteNumber(f.ebitda);
  const netDebt = debt === null ? null : debt - cash;
  // Net cash is the best case; its ratio to EBITDA is negative and ranks at the
  // top of the scale, which is where it belongs.
  const leverage = netDebt === null ? null
    : ebitda !== null && ebitda > 0 ? netDebt / ebitda
    : netDebt <= 0 ? -1
    : null;

  const ic = m.interestCoverage;
  const coverage = ic.ratio !== null ? ic.ratio
    : ic.interpretation === 'excellent' ? DEBT_FREE_COVERAGE
    : ic.interpretation === 'critical' ? 0
    : null;

  const beneishValue = fromLabel(beneish.reading, { clean: 1, grey: 0.5, flagged: 0 });

  // Within the sector: leverage that is a utility's business model is a
  // software company's warning sign. Beneish reads manipulation, which is not
  // a sector's habit, and stays against the market.
  const inSector = { sector: f.sector };

  return [
    criterion('altman', 'Altman Z-Score',
      calibrated('health.altman', zPosition, 1, (v) => ramp(v, 0, 1), inSector),
      altman.note, zPosition),

    criterion('interest-cover', 'Zinsdeckung',
      calibrated('health.interest-cover', coverage, 1, (v) => ramp(v, 1, 8), inSector),
      ic.ratio !== null
        ? `Operatives Ergebnis deckt Zinsen ${deNumber(ic.ratio, 1)}x (${COVERAGE_DE[ic.interpretation]})`
        : ic.interpretation === 'unknown' && (debt ?? 0) > 0
          ? 'Schulden vorhanden, aber kein Zinsaufwand ausgewiesen — Zinsdeckung nicht lesbar'
          : `Zinsdeckung: ${ic.interpretation}`,
      coverage),

    criterion('leverage', 'Nettoverschuldung / EBITDA',
      calibrated('health.leverage', leverage, -1, (v) => (v <= 0 ? 1 : ramp(v, 4, 1)), inSector),
      netDebt === null ? 'Keine Verschuldungsdaten'
        : netDebt <= 0 ? `Nettoliquidität ${fmtBig(-netDebt, f.tradingCurrency)} — keine Nettoverschuldung`
        : ebitda !== null && ebitda > 0
          ? `Nettoverschuldung ${fmt(netDebt / ebitda, 'x', 1)} EBITDA`
          : 'EBITDA nicht positiv — Verschuldungsgrad nicht aussagekräftig',
      leverage),

    criterion('liquidity', 'Current Ratio',
      calibrated('health.liquidity', liquidity.ratio, 1, (v) => ramp(v, 0.8, 2.0), inSector),
      liquidity.ratio === null ? 'Keine Liquiditätskennzahl'
        : liquidity.deferredShare === null ? `Current Ratio ${fmt(f.currentRatio, 'x')}`
        : `Current Ratio ${fmt(f.currentRatio, 'x')} — ohne vorausbezahlte Umsätze `
          + `(${fmtPct(liquidity.deferredShare, 0)} der kurzfristigen Verbindlichkeiten) ${fmt(liquidity.ratio, 'x')}`,
      liquidity.ratio),

    criterion('beneish', 'Bilanzqualität (Beneish)',
      // A reading the model cannot support scores nothing rather than zero.
      calibrated('health.beneish', beneishValue, 1, (v) => v),
      beneish.note, beneishValue),
  ];
}

/**
 * The market's own verdict, as the research measures it.
 *
 * This pillar used to lean 40 % on the TradingView-style vote — twelve moving
 * averages saying "trend" and seven oscillators saying "oversold is a buy",
 * the two halves betting on opposite things in one number. What the evidence
 * supports is simpler: the return over the last twelve months skipping the
 * most recent one (Jegadeesh and Titman — the skipped month is where
 * short-term reversal lives), and how close the price is to its 52-week high
 * (George and Hwang, 2004). The gauge stays on the page; it no longer votes.
 */
function momentumPillar(signals: MarketSignals | null): Draft[] {
  const t = signals?.technicals ?? null;
  const y1 = toFiniteNumber(t?.returns?.y1);
  const m1 = toFiniteNumber(t?.returns?.m1);
  const mom = y1 !== null && m1 !== null && 1 + m1 > 0 ? (1 + y1) / (1 + m1) - 1 : null;
  const drawdown = toFiniteNumber(t?.drawdownFromHighPct);
  const nearHigh = drawdown !== null ? 1 + drawdown : null;
  const rsSector = toFiniteNumber(t?.rsVsSector3M);

  return [
    criterion('momentum-12-1', 'Momentum 12–1 Monate',
      calibrated('momentum.12-1', mom, 1, (v) => ramp(v, -0.30, 0.50)),
      mom !== null
        ? `Rendite der letzten zwölf Monate ohne den jüngsten: ${fmtSignedPct(mom)} (1M ${fmtSignedPct(m1)})`
        : 'Keine zwölfmonatige Kurshistorie',
      mom),

    criterion('52w-high', 'Nähe zum 52-Wochen-Hoch',
      calibrated('momentum.52w-high', nearHigh, 1, (v) => ramp(v, 0.60, 1.0)),
      nearHigh !== null
        ? `Kurs bei ${deNumber(nearHigh * 100, 0)} % des 52-Wochen-Hochs`
        : 'Keine 52-Wochen-Spanne',
      nearHigh),

    criterion('rs-sector', 'Relative Stärke vs. Sektor (3M)',
      calibrated('momentum.rs-sector', rsSector, 1, (v) => ramp(v, -0.15, 0.15)),
      rsSector !== null ? `3M gegen Sektor-ETF ${fmtSignedPct(rsSector)}` : 'Kein Sektor-ETF zugeordnet',
      rsSector),
  ];
}

/**
 * Estimate revisions, as a share of the analysts who could have revised.
 *
 * Revision counts used to be summed over four overlapping periods — one
 * analyst lowering a quarter and the year counted up to four times — and read
 * on a fixed ±4 scale whether one analyst covered the stock or sixty. Breadth
 * is the net count over the analysts publishing an estimate, for the current
 * and the next fiscal year. Like every criterion it is read against where the
 * typical stock sits: in an upgrade cycle most stocks are revised up, and the
 * median S&P 500 member had net upward revisions from a sixth of its analysts.
 */
function revisionsPillar(f: StockFinancials, signals: MarketSignals | null, cons: AnalystConsensus): Draft[] {
  const r: EarningsRevisions | null = signals?.revisions ?? null;
  const periods = r?.perPeriod ?? [];
  const year = periods.find((p) => p.period === '0y') ?? periods.find((p) => p.period === '+1y');

  const analystsFor = (period: string) =>
    toFiniteNumber((f.earningsEstimates ?? []).find((e) => e.period === period)?.numberOfAnalysts);
  let net = 0, analysts = 0;
  for (const period of ['0y', '+1y']) {
    const n = toFiniteNumber(periods.find((p) => p.period === period)?.netRevision30d);
    const a = analystsFor(period);
    if (n === null || a === null || a <= 0) continue;
    net += n;
    analysts += a;
  }
  const breadth = analysts > 0 ? net / analysts : null;

  const surprises = f.earningsSurprises ?? [];
  const scored = surprises.filter((q) => toFiniteNumber(q.surprisePct) !== null);
  const beats = scored.filter((q) => (q.surprisePct as number) > 0).length;
  const beatShare = scored.length > 0 ? beats / scored.length : null;

  const delta = netRatingDelta(r?.analystRatingMoMDelta);
  const ratingDrift = delta !== null && cons.total > 0 ? delta / cons.total : null;

  return [
    criterion('eps-drift', 'EPS-Schätzungsdrift (30 Tage)',
      calibrated('revisions.eps-drift', toFiniteNumber(year?.epsChange30dPct), 1, (v) => ramp(v, -0.03, 0.03)),
      year?.epsChange30dPct != null
        ? `Konsens-EPS ${year.period === '0y' ? 'laufendes Jahr' : 'Folgejahr'} ${fmtSignedPct(year.epsChange30dPct)} in 30 Tagen (${fmt(year.epsTrend?.ago30d)} → ${fmt(year.epsTrend?.current)})`
        : 'Keine Schätzungsdrift verfügbar',
      toFiniteNumber(year?.epsChange30dPct)),

    criterion('revision-breadth', 'Revisionsbreite (30 Tage)',
      calibrated('revisions.breadth', breadth, 1, (v) => ramp(v, -0.30, 0.30)),
      breadth !== null
        ? `Netto ${net >= 0 ? '+' : ''}${net} Revisionen bei ${analysts} Schätzungen (lfd. und nächstes Jahr) — ${fmtSignedPct(breadth)}`
        : 'Keine Revisionszählungen verfügbar',
      breadth),

    // Three quarters of all quarters beat the consensus; beating it is the norm,
    // and only its frequency against that norm is information.
    criterion('surprises', 'Ergebnisüberraschungen',
      calibrated('revisions.surprises', beatShare, 1, (v) => ramp(v, 0.5, 1.0)),
      beatShare !== null
        ? `${beats} von ${scored.length} Quartalen über Konsens`
        : 'Keine Überraschungshistorie',
      beatShare),

    criterion('rating-drift', 'Rating-Veränderung (MoM)',
      calibrated('revisions.rating-drift', ratingDrift, 1, (v) => ramp(v, -0.10, 0.10)),
      delta !== null
        ? `Analystenratings netto ${delta >= 0 ? '+' : ''}${delta} gegenüber Vormonat bei ${cons.total} Analysten`
        : 'Keine Rating-Veränderung gegenüber Vormonat',
      ratingDrift),
  ];
}

function consensusPillar(
  f: StockFinancials, cons: AnalystConsensus, signals: MarketSignals | null,
): Draft[] {
  const c = f.tradingCurrency;
  const drawdown = toFiniteNumber(signals?.technicals?.drawdownFromHighPct);
  // Said out loud where it is large, because a reader looking at "+80 % to the
  // mean target" deserves to know the stock is 75 % off its high.
  const stale = drawdown !== null && drawdown < -0.25 && (cons.upside ?? 0) > 0.25
    ? ` — Vorsicht: die Aktie steht ${fmtSignedPct(drawdown)} unter ihrem Jahreshoch, ein Teil dieses `
      + 'Potenzials ist der Kursrückgang und nicht die Einschätzung'
    : '';

  // Sell-side ratings lean buy — the watchlist averaged +0.43 on −1…+1 — so the
  // neutral point is the typical rating, not an even split of buys and sells.
  return [
    criterion('rating', 'Gewichtetes Analystenrating',
      calibrated('consensus.rating', cons.score, 1, (v) => (v + 1) / 2),
      cons.score !== null
        ? `${cons.label} — ${cons.total} Analysten, ${fmt(cons.buySharePct, '', 0)} % Kauf, gewichteter Score ${cons.score >= 0 ? '+' : ''}${deNumber(cons.score, 2)}`
        : 'Keine Analystenabdeckung für dieses Listing',
      cons.score),

    criterion('target-upside', 'Kursziel-Potenzial',
      calibrated('consensus.target-upside', cons.upside, 1, (v) => ramp(v, -0.10, 0.35)),
      cons.upside !== null
        ? `Mittleres Kursziel ${fmtPrice(f.targetMeanPrice, c)} — ${fmtSignedPct(cons.upside)} zum Kurs ${fmtPrice(f.price, c)}${stale}`
        : 'Kein Konsens-Kursziel',
      cons.upside),
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
export function convictionFor(pillars: readonly Pick<ScorePillar, 'score' | 'effectiveWeight'>[]): { agreement: number; conviction: number } {
  const scored = pillars.filter((p) => p.score !== null);
  const net = scored.reduce((s, p) => s + p.effectiveWeight * ((p.score as number) - 5), 0);
  const gross = scored.reduce((s, p) => s + p.effectiveWeight * Math.abs((p.score as number) - 5), 0);
  const weight = scored.reduce((s, p) => s + p.effectiveWeight, 0);
  const agreement = gross === 0 ? 0 : Math.abs(net) / gross;
  // Agreement is a ratio and blind to scale: six lenses a hair above neutral
  // agree as perfectly as six at 9. See CONVICTION_FULL_STRENGTH.
  const meanDistance = weight > 0 ? gross / weight : 0;
  const strength = Math.min(1, meanDistance / CONVICTION_FULL_STRENGTH);

  return {
    agreement,
    conviction: scored.length >= CONVICTION_MIN_PILLARS
      ? 1 + (MAX_CONVICTION - 1) * agreement * strength
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
/**
 * Where the conviction stretch stops being linear: the STRONG BUY band's
 * distance from neutral, read from the bands rather than repeated here.
 */
const SATURATION_KNEE = (SCORE_BANDS.find((b) => b.verdict === 'STRONG BUY')?.min ?? 8) - 5;

/**
 * The stretched deviation from neutral, bent so it approaches the end of the
 * scale instead of running off it.
 *
 * `(raw − 5) × trust × conviction` is linear with no ceiling, and a unanimous,
 * well-covered case overshoots: Alphabet's 8.56 raw × 0.92 × 1.6 came to
 * 10.24 and was clipped to 10.0 — a perfect score, and one it would share with
 * anything else past the edge, so the ranking stopped at the top. Inside the
 * knee (±3, the STRONG bands) nothing changes; beyond it the curve is
 * `knee + (5 − knee) · tanh((|d| − knee) / (5 − knee))`, which meets the line
 * with the same slope, keeps every order, and reaches 10 only in the limit.
 * No label moves: everything beyond the knee was already STRONG.
 */
export function saturate(deviation: number): number {
  const d = Math.abs(deviation);
  if (d <= SATURATION_KNEE) return deviation;
  const room = 5 - SATURATION_KNEE;
  return Math.sign(deviation) * (SATURATION_KNEE + room * Math.tanh((d - SATURATION_KNEE) / room));
}

/** Inverse of `saturate`: the linear deviation a published one came from. */
export function unsaturate(deviation: number): number {
  const d = Math.abs(deviation);
  if (d <= SATURATION_KNEE) return deviation;
  const room = 5 - SATURATION_KNEE;
  // The published scale ends at 0 and 10, where the inverse runs off to
  // infinity; a blend sitting exactly on the end is held a hair inside it.
  const t = Math.min((d - SATURATION_KNEE) / room, 1 - 1e-9);
  return Math.sign(deviation) * (SATURATION_KNEE + room * Math.atanh(t));
}

function published(score: number): number {
  return Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
}

/** What the arithmetic needs of a criterion: which one it is, and what it scored. */
export interface CriterionPoints {
  key:    string;
  points: number | null;
}

/** A criterion once weighed: its own fields, the weight it was given and its signed contribution. */
type Weighed<C extends CriterionPoints> = C & { weight: number; impact: number | null };

/** A pillar as assembled from its criteria. */
export type AssembledPillar<C extends CriterionPoints> = Omit<ScorePillar, 'criteria'> & { criteria: Weighed<C>[] };

function reducePillar<C extends CriterionPoints>(
  key: PillarKey, drafts: readonly C[], weights: ScoreWeights,
): Omit<AssembledPillar<C>, 'effectiveWeight'> {
  const table = weights.criteria[key];
  const criteria = drafts.map((d): Weighed<C> => {
    const weight = table[d.key];
    // A criterion without a weight is a criterion added to a pillar and not to
    // the table — scoring it at some default would hide exactly that.
    if (weight === undefined) throw new Error(`No weight for criterion ${key}.${d.key}`);
    return { ...d, weight, impact: null };
  });
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
    weight:   weights.pillars[key],
    coverage: Math.round(coverage * 1000) / 1000,
    criteria,
  };
}

/** Apply the ceilings in order of severity; `hold-ceiling` subsumes `no-strong`. */
export function capVerdict(verdict: Recommendation, caps: ScoreCap[]): Recommendation {
  let out: Recommendation = verdict;
  // Uncertainty tempers both extremes: a payload we cannot trust supports no
  // strong call in either direction.
  if (caps.some((c) => c.limit === 'no-strong')) {
    if (out === 'STRONG BUY')  out = 'BUY';
    if (out === 'STRONG SELL') out = 'SELL';
  }
  // A ceiling is a warning — distress, a supported manipulation flag — so it
  // caps enthusiasm and never softens alarm. It used to share the branch above
  // and turned Vistra's STRONG SELL into SELL on the strength of the very
  // "distress" reading that made it bearish.
  if (caps.some((c) => c.limit === 'hold-ceiling') && (out === 'STRONG BUY' || out === 'BUY')) out = 'HOLD';
  return out;
}

export interface FactorScoreInput {
  financials:       StockFinancials;
  metrics:          ComputedMetrics;
  sectorMedians:    SectorMedians | null;
  marketSignals:    MarketSignals | null;
  technicalSignals: TechnicalSignals | null;
  /**
   * The weights to score with; the ones in force when left out. Tests pin the
   * judgment's, as they pin the explicit ramps: a refit is data, and must not
   * rewrite their expectations.
   */
  weights?:         ScoreWeights;
}

/**
 * How far the payload can be trusted before counting how much of it scored:
 * the composite's own confidence, the data-quality audit and freshness.
 * Coverage multiplies in later (`assembleScore`), because coverage depends on
 * the weights and this does not.
 */
export function trustOf(f: StockFinancials, m: ComputedMetrics): number {
  const severity = worstSeverity(f.dataQualityWarnings ?? []);
  const qualityFactor = severity === 'error' ? 0.35 : severity === 'warn' ? 0.75 : 1;
  const freshnessFactor = f.fundamentalsStale ? 0.6 : 1;
  const compositeFactor = 0.55 + 0.45 * (m.composite.confidence / 10);
  return compositeFactor * qualityFactor * freshnessFactor;
}

export interface Assembly<C extends CriterionPoints> {
  pillars:    AssembledPillar<C>[];
  /** The weighted mean of the pillars, unrounded. */
  raw:        number;
  coverage:   number;
  confidence: number;
  shrink:     number;
  agreement:  number;
  conviction: number;
  /** Published: rounded to the tenth everything bands on. */
  score:      number;
}

/**
 * Criteria to a score: the pillars, their mean, the trust and conviction
 * multipliers, and the published figure.
 *
 * Apart from `computeFactorScore` so that the backtest can weigh the same
 * criteria more than once — as judgment set the weights and as a fit would
 * set them — without reading every payload again.
 */
export function assembleScore<C extends CriterionPoints>(
  criteria: Readonly<Record<PillarKey, readonly C[]>>, trust: number, weights: ScoreWeights = WEIGHTS,
  /**
   * How much of the conviction stretch to apply: 1 as published, 0 none. For
   * the backtest's variants (`backtest/variants.ts`); the live score never
   * passes it.
   */
  stretch = 1,
): Assembly<C> {
  const built = PILLAR_KEYS.map((key) => reducePillar(key, criteria[key], weights));

  // A pillar with nothing to say is dropped rather than scored 5/10, and the
  // rest renormalise over what is left. Coverage records what that cost.
  const scoredWeight = built.filter((p) => p.score !== null).reduce((s, p) => s + p.weight, 0);
  const coverage = scoredWeight;   // weights sum to 1, so this is already a share

  const pillars: AssembledPillar<C>[] = built.map((p) => ({
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

  const confidence = Math.max(0, Math.min(1, coverage * trust));
  const { agreement, conviction: full } = convictionFor(pillars);
  const conviction = 1 + (full - 1) * stretch;

  // Two multipliers on the same deviation, answering two different questions:
  // shrink asks how much of this we can trust, conviction how much of it the
  // lenses actually corroborate. Half-weight at zero confidence rather than a
  // collapse to 5: a blind score still has to rank, it just must not shout.
  const shrink = 0.4 + 0.6 * confidence;
  const score = published(5 + saturate((raw - 5) * shrink * conviction));

  return { pillars, raw, coverage, confidence, shrink, agreement, conviction, score };
}

/**
 * The whole score, from inputs this repo already has in hand.
 *
 * Pure and synchronous: no IO, no clock, no randomness. The same payload scores
 * the same today and in the backfill that re-scores three months of stored
 * snapshots — which is the entire point of calling it deterministic.
 */
export function computeFactorScore(input: FactorScoreInput): FactorScore {
  const { financials: f, metrics: m, sectorMedians, marketSignals } = input;
  const cons = analystConsensus(f);

  const { pillars, raw, coverage, confidence, shrink, agreement, conviction, score } = assembleScore({
    valuation: valuationPillar(f, m, sectorMedians),
    quality:   qualityPillar(f, m, sectorMedians),
    health:    healthPillar(f, m),
    consensus: consensusPillar(f, cons, marketSignals),
    momentum:  momentumPillar(marketSignals),
    revisions: revisionsPillar(f, marketSignals, cons),
  }, trustOf(f, m), input.weights);

  // ── Caps ──────────────────────────────────────────────────────────────────
  const severity = worstSeverity(f.dataQualityWarnings ?? []);
  const caps: ScoreCap[] = [];
  if (severity === 'error') {
    caps.push({ limit: 'no-strong', reason: 'Datenqualität: mindestens ein Feld ist nachweislich widersprüchlich' });
  }
  if (cons.uncovered) {
    caps.push({ limit: 'no-strong', reason: 'Keine Analystenabdeckung — den Modellen fehlt die unabhängige Gegenprobe' });
  }
  if (confidence < STRONG_MIN_CONFIDENCE) {
    caps.push({ limit: 'no-strong', reason: `Konfidenz ${deNumber(confidence * 100, 0)} % unter ${deNumber(STRONG_MIN_CONFIDENCE * 100, 0)} %` });
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
      note: `${high.label} ${deNumber(high.score as number, 1)}/10 gegen ${low.label} ${deNumber(low.score as number, 1)}/10 — die beiden Linsen widersprechen sich`,
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

/**
 * Rated dimensions a narrative score needs; fewer is the sources not covering
 * the business, and the read abstains.
 */
export const NARRATIVE_MIN_DIMENSIONS = 2;

/**
 * The narrative score, computed from the per-dimension ratings.
 *
 * The model used to answer with one number, and one number is where a single
 * headline swings the whole read: the rubric's "0 — several independent sources
 * describe a deterioration" matched Apple's regulatory news one to one, and a
 * business growing 16 % came back 0.0 and pulled the headline to SELL. The
 * forensic brief is built to find bear evidence, so a rubric that counts bear
 * evidence is satisfied for every stock. Rated one dimension at a time, a bad
 * week in one of them costs what one dimension is worth, and the extremes need
 * every dimension to agree. `5 + 2.5 × mean`, so all at −2 is 0 and all at +2 is
 * 10; the model never chooses the number itself.
 */
export function narrativeScoreFrom(dimensions: NarrativeDimensions | null | undefined): number | null {
  const rated = Object.values(dimensions ?? {})
    .map((d) => d?.rating)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
    .map((r) => Math.max(-2, Math.min(2, r)));
  if (rated.length < NARRATIVE_MIN_DIMENSIONS) return null;
  const mean = rated.reduce((a, b) => a + b, 0) / rated.length;
  return Math.round((5 + 2.5 * mean) * 10) / 10;
}

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

  // Saying something: `agreement` is 0 when the pillars cancel, and a score
  // that is 5.0 because its evidence nets off is not an opinion the blend should
  // defend at full strength. Not weighted by confidence again — the factor score
  // has already been pulled towards neutral by it (`shrink`), and weighting the
  // shrunk score by the same confidence counted a thin payload's doubt twice:
  // its influence fell with the square of its confidence.
  const factorWeight = FACTOR_WEIGHT_FLOOR + (1 - FACTOR_WEIGHT_FLOOR) * factor.agreement;
  const narrativeWeight = hasNarrative
    ? Math.max(0, Math.min(1, input.narrativeConfidence)) * maxNarr
    : 0;

  // Both confidences at zero is a real possibility (no coverage, no prose). The
  // arithmetic still ran, so its answer is the one on the table.
  const total = factorWeight + narrativeWeight;
  const blend = total > 0
    ? (factorWeight * factor.score + narrativeWeight * (input.narrativeScore as number)) / total
    : factor.score;

  const requested = Number.isFinite(input.adjustment)
    ? Math.max(-limit, Math.min(limit, input.adjustment))
    : 0;

  // The correction is added where the score is still linear and bent back
  // afterwards. Added on the published scale it did two wrong things near the
  // ends: a +1 on a 9.4 blend came to 10.4, was clipped to a perfect 10.0 and
  // still recorded as "+1.0" although 0.6 had been applied; and a point up
  // there skipped the whole compressed zone that `saturate` had built, weighing
  // more than a point in the middle. Inside the STRONG bands both paths agree
  // exactly, so an ordinary correction is still exactly what the model asked.
  const corrected = 5 + saturate(unsaturate(blend - 5) + requested);
  const score = published(corrected);
  const adjustment = corrected - blend;

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
    adjustment:          Math.round(adjustment * 100) / 100,
    adjustmentRequested: Math.round(requested * 100) / 100,
    adjustmentReason:    requested === 0 ? null : input.adjustmentReason,
  };
}
