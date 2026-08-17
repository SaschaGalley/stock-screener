/**
 * Cross-checks on a parsed `StockFinancials` payload — the guard that was
 * missing when a FACC analysis came out as SELL on 2023 numbers.
 *
 * Yahoo serves a stock's figures from several modules that do not age at the
 * same rate. `quote` and `financialData` carry the TTM market view; the
 * statement series come from `fundamentalsTimeSeries`. For a primary listing
 * they agree. For a thinly-traded secondary line (FACC's London IOB quote,
 * `0QW9.IL`) Yahoo keeps serving a `financialData` block frozen at Q2 2023
 * while the statement series stay current — so the payload ends up internally
 * impossible: an EBITDA below EBIT, an enterprise value below market cap on a
 * net-debt-positive balance sheet, a P/E built from an EPS three years stale.
 *
 * None of that is detectable one field at a time; every value is individually
 * plausible. It is only detectable as a *contradiction between* fields, which
 * is what this module checks. Findings travel with the financials into the
 * prompt, so the model is told which of its inputs are unreliable instead of
 * reasoning confidently over stale ones.
 *
 * Tolerances are deliberately loose. The goal is catching a payload that is
 * wrong by a factor, not auditing rounding: Yahoo's TTM window and the annual
 * statement legitimately differ by a few percent, and a false positive on 30
 * healthy tickers would train everyone to ignore the warnings.
 */

import { DataQualityWarning, StockFinancials } from '../types.js';
import { toFiniteNumber } from '../utils/num.js';

/**
 * How old the newest reported quarter may be before the market-side modules
 * are presumed stale. Late filers plus Yahoo's own lag put a legitimately
 * current small cap at 4–5 months (FACC.VI sat at 5 when this was written), so
 * the threshold has to clear that with room to spare. The pathological case it
 * exists to catch was 38 months out.
 */
const STALE_QUARTER_MONTHS = 9;

const MONTH_MS = 2_629_800_000;

/**
 * Tolerances per check, as fractions.
 *
 * `revenueBelowAnnual` guards a comparison between a *trailing* figure and an
 * *annual* one, and that pairing is asymmetric in a way worth stating plainly,
 * because getting it wrong is what a first cut of this module did:
 *
 *   - A growing company legitimately has TTM above its last full year. CoreWeave
 *     ran +48% and Alphabet's trailing net income sat 85% above FY2025 — real
 *     growth, not bad data. A two-sided check flags a third of a healthy
 *     watchlist and teaches everyone to ignore it.
 *   - A *stale* trailing figure sits materially **below** the current annual one,
 *     because it is a snapshot of a smaller past. FACC's London line reported
 *     TTM revenue 30% under the fiscal year already on file.
 *
 * So the trailing-vs-annual check is deliberately one-sided: below is a finding,
 * above is growth. The margin check instead compares annual against
 * annual, where both sides share a basis, and only fires on factor-level gaps.
 */
const TOL = {
  /** How far *below* the annual statement trailing revenue may sit. */
  revenueBelowAnnual: 0.30,
  /** Annual-basis margin vs. the reported one. Wide: only factor-level gaps. */
  margin: 0.60,
  /** EV vs. market cap + net debt. Both are point-in-time, so this is tight. */
  enterpriseValue: 0.15,
} as const;

function relDiff(a: number, b: number): number | null {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? null : Math.abs(a - b) / base;
}

/** Newest value of a `{year, value}` series, or null when empty. */
function latest(series: { year: number; value: number }[] | undefined): number | null {
  if (!series || series.length === 0) return null;
  return toFiniteNumber(series[series.length - 1]?.value);
}

/**
 * Age of the newest reported quarter in months, or null when Yahoo did not say.
 *
 * `now` is injected so the check is testable and so a batch run cannot have
 * two symbols disagree about the current time.
 */
export function quarterAgeMonths(mostRecentQuarter: string | null | undefined, now: number): number | null {
  if (!mostRecentQuarter) return null;
  const t = new Date(mostRecentQuarter).getTime();
  if (!Number.isFinite(t)) return null;
  return (now - t) / MONTH_MS;
}

/** Are the market-side modules (`quote`, `financialData`) presumed stale? */
export function isFundamentalsStale(mostRecentQuarter: string | null | undefined, now: number): boolean {
  const age = quarterAgeMonths(mostRecentQuarter, now);
  return age !== null && age > STALE_QUARTER_MONTHS;
}

/**
 * Audit a parsed payload for internal contradictions.
 *
 * Ordered most- to least-severe so the prompt's warning block leads with the
 * finding that should most change how the model reads the rest.
 */
export function auditFinancials(f: StockFinancials, now: number = Date.now()): DataQualityWarning[] {
  const out: DataQualityWarning[] = [];
  const warn = (w: DataQualityWarning) => out.push(w);

  // ── 1. Stale market-side modules ──────────────────────────────────────────
  // The root cause the other checks only see symptoms of. Reported as `error`
  // because every TTM ratio in the payload inherits it.
  const age = quarterAgeMonths(f.mostRecentQuarter, now);
  if (age !== null && age > STALE_QUARTER_MONTHS) {
    warn({
      code: 'stale-fundamentals',
      severity: 'error',
      fields: ['mostRecentQuarter'],
      message: `Yahoo's newest reported quarter for this listing is ${f.mostRecentQuarter} — ${age.toFixed(0)} months old. `
        + `TTM figures (P/E, margins, ROE, FCF, EV) sourced from the market-side modules are unreliable; `
        + `prefer the annual statement series and treat every trailing ratio as indicative only.`,
    });
  }

  // ── 2. EBITDA below EBIT ──────────────────────────────────────────────────
  // Arithmetically impossible: EBITDA = EBIT + D&A, and D&A is non-negative.
  // Fires when EBIT comes from a current statement and EBITDA from a stale
  // `financialData`.
  const ebit = toFiniteNumber(f.ebit);
  const ebitda = toFiniteNumber(f.ebitda);
  if (ebit !== null && ebitda !== null && ebit > 0 && ebitda < ebit) {
    const da = toFiniteNumber(f.depreciation);
    warn({
      code: 'ebitda-below-ebit',
      severity: 'error',
      fields: ['ebitda', 'ebit'],
      message: `EBITDA (${ebitda.toLocaleString()}) is below EBIT (${ebit.toLocaleString()}), which cannot be true`
        + `${da !== null ? ` — with D&A of ${da.toLocaleString()}, EBITDA should be ≈ ${(ebit + da).toLocaleString()}` : ''}. `
        + `The two figures come from different Yahoo modules; at least one is stale. EV/EBITDA is not usable.`,
    });
  }

  // ── 3. Enterprise value vs. the net-debt identity ─────────────────────────
  // EV = market cap + debt − cash. Skipped when the currencies differ, because
  // there Yahoo's own EV mixes bases and `yfinance.ts` already recomputes it.
  const mcap = toFiniteNumber(f.marketCap);
  const debt = toFiniteNumber(f.totalDebt);
  const cash = toFiniteNumber(f.totalCash);
  const ev = toFiniteNumber(f.enterpriseValue);
  const sameCurrency = !f.tradingCurrency || !f.financialCurrency || f.tradingCurrency === f.financialCurrency;
  if (sameCurrency && ev !== null && mcap !== null && debt !== null && cash !== null && mcap > 0) {
    const expected = mcap + debt - cash;
    const diff = relDiff(ev, expected);
    if (diff !== null && diff > TOL.enterpriseValue) {
      warn({
        code: 'enterprise-value-mismatch',
        severity: 'error',
        fields: ['enterpriseValue'],
        message: `Enterprise value (${ev.toLocaleString()}) contradicts market cap + net debt (${expected.toLocaleString()}, `
          + `off by ${(diff * 100).toFixed(0)}%). Every EV multiple below is affected.`,
      });
    }
  }

  // ── 4. Trailing revenue below the annual statement ────────────────────────
  //
  // Deliberately revenue and not EPS, though a stale EPS is the more damaging
  // field. Per-share figures are not comparable across a payload: the quote's
  // trailing EPS is per *traded unit* while the statement series is per
  // *ordinary share*, and for an ADR those differ by the deposit ratio. Sanofi
  // reports 1.87 per ADR against 3.70 per share — indistinguishable from a
  // stale figure by any threshold, and deriving EPS from net income does not
  // help, because Yahoo's share count is on the ordinary basis too.
  //
  // Revenue has no per-share unit, so the same comparison is safe. It detects
  // the same pathology (a trailing block reporting an older, smaller year), and
  // when Yahoo does report a quarter date, check 1 catches the root cause more
  // directly anyway.
  const revenue = toFiniteNumber(f.revenue);
  const statementRevenue = latest(f.fundamentalsHistory?.revenue);
  if (revenue !== null && statementRevenue !== null && revenue > 0 && statementRevenue > 0
      && revenue < statementRevenue * (1 - TOL.revenueBelowAnnual)) {
    warn({
      code: 'revenue-below-annual',
      severity: 'warn',
      fields: ['revenue', 'revenueGrowth'],
      message: `Headline revenue (${revenue.toLocaleString()}) is `
        + `${((1 - revenue / statementRevenue) * 100).toFixed(0)}% below the newest annual statement `
        + `(${statementRevenue.toLocaleString()}). Prefer the statement series for growth and margins.`,
    });
  }

  // ── 5. Reported margins vs. the same margins on an annual basis ───────────
  // Annual numerator over annual revenue, so both sides share a period. A
  // trailing-vs-annual comparison here would just re-measure growth.
  const annualRevenue = statementRevenue;
  if (annualRevenue !== null && annualRevenue > 0) {
    const checks: { field: 'netMargin' | 'operatingMargin'; reported: number | null; numerator: number | null; label: string }[] = [
      { field: 'netMargin', reported: toFiniteNumber(f.netMargin), numerator: latest(f.fundamentalsHistory?.netIncome), label: 'net income' },
      { field: 'operatingMargin', reported: toFiniteNumber(f.operatingMargin), numerator: latest(f.fundamentalsHistory?.operatingIncome), label: 'operating income' },
    ];
    for (const c of checks) {
      if (c.reported === null || c.numerator === null) continue;
      const derived = c.numerator / annualRevenue;
      // A sign flip is always a finding; otherwise require a factor-level gap.
      const signFlip = Math.sign(c.reported) !== Math.sign(derived) && c.reported !== 0 && derived !== 0;
      const diff = relDiff(c.reported, derived);
      if (signFlip || (diff !== null && diff > TOL.margin)) {
        warn({
          code: 'margin-mismatch',
          severity: 'warn',
          fields: [c.field],
          message: `${c.field} of ${(c.reported * 100).toFixed(2)}% disagrees with ${c.label} / revenue on an annual `
            + `basis (${(derived * 100).toFixed(2)}%)${signFlip ? ' — and the two have opposite signs' : ''}. `
            + `Treat the margin level as unsettled.`,
        });
      }
    }
  }

  // ── 6. Trailing FCF negative against a positive annual statement ──────────
  // Downgraded to a note on purpose: for a current listing this is real
  // information (working capital or capex genuinely turned cash flow negative
  // this year), and only stale data makes it an error — which check 1 already
  // reports. Either way the DCF is suppressed, so it needs saying.
  const fcf = toFiniteNumber(f.freeCashFlow);
  const statementFcf = latest(f.fundamentalsHistory?.freeCashFlow);
  if (fcf !== null && statementFcf !== null && fcf < 0 && statementFcf > 0) {
    warn({
      code: 'fcf-sign-conflict',
      severity: 'warn',
      fields: ['freeCashFlow'],
      message: `Trailing free cash flow is negative (${fcf.toLocaleString()}) while the newest annual statement shows `
        + `${statementFcf.toLocaleString()}. This suppresses the DCF and turns every P/FCF multiple negative, so the `
        + `absence of those models is a data artefact, not a verdict on the business.`,
    });
  }

  // ── 7. Capex missing, so the FCF series is really operating cash flow ─────
  // Yahoo omits `capitalExpenditure` on some listings. `freeCashFlow` then
  // mirrors operating cash flow exactly, overstating FCF by the whole capex
  // line — material for a manufacturer.
  if (f.capex === null || f.capex === undefined) {
    const fcfSeries = f.fundamentalsHistory?.freeCashFlow ?? [];
    const ocfSeries = f.fundamentalsHistory?.operatingCashFlow ?? [];
    const mirrored = fcfSeries.length > 0
      && fcfSeries.length === ocfSeries.length
      && fcfSeries.every((p, i) => p.value === ocfSeries[i]?.value);
    if (mirrored) {
      warn({
        code: 'capex-missing',
        severity: 'warn',
        fields: ['capex', 'freeCashFlow'],
        message: `No capex reported for this listing, and the free-cash-flow series is identical to operating cash flow — `
          + `it is OCF, not FCF, and overstates cash generation by the full capex line.`,
      });
    }
  }

  // ── 8. No sell-side coverage ──────────────────────────────────────────────
  // Not a data error: a genuine small cap may simply be uncovered. It matters
  // because it removes the one input that is independent of the computed
  // models, so the prompt has to widen its uncertainty rather than lean harder
  // on the arithmetic.
  const ratings = (f.analystStrongBuy ?? 0) + (f.analystBuy ?? 0) + (f.analystHold ?? 0)
    + (f.analystSell ?? 0) + (f.analystStrongSell ?? 0);
  // Count *valuation-relevant* estimates, not array length. Two traps here:
  // Yahoo returns the four period rows ("0q", "+1q", "0y", "+1y") for uncovered
  // stocks too with every field null; and a secondary listing can carry a
  // revenue consensus while having no ratings, no target and no EPS estimates
  // (Air Liquide's Frankfurt line). A revenue forecast does not validate a fair
  // value — only earnings estimates and price targets do — so it does not count
  // as the independent check the models are missing.
  const epsEstimates = f.earningsEstimates.filter(
    (e) => e.epsEstimate !== null || (e.numberOfAnalysts ?? 0) > 0,
  ).length;
  if (ratings === 0 && f.targetMeanPrice === null && epsEstimates === 0) {
    warn({
      code: 'no-analyst-coverage',
      severity: 'warn',
      fields: ['analystCount', 'targetMeanPrice', 'earningsEstimates'],
      message: `No valuation-relevant sell-side coverage on this listing: no ratings, no price target, no EPS estimates. `
        + `Often an artefact of a secondary listing rather than a genuinely uncovered company — the primary line may be covered.`,
    });
  }

  return out;
}

/** Highest severity present, or null for a clean payload. */
export function worstSeverity(warnings: DataQualityWarning[]): 'error' | 'warn' | null {
  if (warnings.some((w) => w.severity === 'error')) return 'error';
  if (warnings.length > 0) return 'warn';
  return null;
}
