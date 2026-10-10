/**
 * Whether today's investment is tomorrow's depreciation.
 *
 * Capital spent on a data centre or a plant is not an expense in the year it is
 * spent: it goes on the balance sheet and reaches the income statement a slice
 * a year, over the asset's life. A company spending three times what it writes
 * off has its depreciation still ahead of it — in Microsoft's case the
 * argument against the stock in autumn 2026: free cash flow already shows the
 * spending, earnings do not yet. Neither the margins nor free cash flow say
 * this; the two lines side by side do.
 *
 * So: capital spending against depreciation and amortisation, year by year,
 * and from the gap between them a rough size of what is coming. The sizing
 * assumes straight-line depreciation over the life the balance sheet implies
 * (gross PP&E over the year's depreciation): if spending stays where it is,
 * depreciation climbs by the gap over that life, a life's share of it each
 * year. It is an order of magnitude, not a forecast — the new assets earn
 * something too, and that is the question the card leaves to the reader.
 *
 * The literature asks the same of returns: firms that invest heavily, against
 * their own past (Titman, Wei and Xie 2004) or by the growth of their balance
 * sheet (Cooper, Gulen and Schill 2008), went on to do worse. Both are measured
 * as backtest candidates, under the rule the payout candidates passed through
 * (`payout.ts`), before anyone proposes a weight for them.
 *
 * Pure and dependency-free: the web app imports it.
 */

import type { StockFinancials } from '../types.js';

export interface YearValue { year: number; value: number }

/** The annual series this reads — a structural subset of `fundamentalsHistory`. */
export interface InvestmentHistory {
  revenue:         YearValue[];
  operatingIncome: YearValue[];
  totalAssets:     YearValue[];
  capex?:          YearValue[];
  depreciation?:   YearValue[];
  grossPPE?:       YearValue[];
}

export interface InvestmentYear {
  year:         number;
  capex:        number;
  depreciation: number;
  revenue:      number | null;
}

export interface DepreciationOutlook {
  /** Years with both lines, oldest first. */
  years:  InvestmentYear[];
  latest: InvestmentYear;
  /** Capital spending over depreciation in the latest year. */
  ratio:      number;
  /** The same in the first year shown, where it is a different year. */
  firstRatio: number | null;
  /** Capital spending over revenue in the latest year, and the median of the years before it. */
  intensity:       number | null;
  intensityBefore: number | null;
  /** Annual growth of depreciation, and of operating income, over the years shown. */
  depreciationGrowth:    number | null;
  operatingIncomeGrowth: number | null;
  /** Years the assets are written off over: gross PP&E over the year's depreciation. */
  life: number | null;
  /** Spending less depreciation: how far depreciation climbs if spending stays where it is. */
  gap: number;
  /** A life's share of the gap: what each year on the way adds. */
  perYear: number | null;
  /** Operating income of the latest year, and the gap and the yearly step against it. */
  operatingIncome: number | null;
  gapShare:        number | null;
  perYearShare:    number | null;
  /** `wave`: spending at least twice depreciation; `some`: above it; `none`: about level, or too small to matter. */
  level: 'wave' | 'some' | 'none';
}

/** Spending below this multiple of depreciation is upkeep: the assets are replaced, not added to. */
export const LEVEL_RATIO = 1.3;
/** At this multiple and above, depreciation has a long way to climb. */
const WAVE_RATIO = 2;
/** A gap under this share of operating income does not move earnings, whatever the ratio. */
const MATERIAL_SHARE = 0.1;
/** The lives the balance sheet can imply that are believable; outside them it is a data artefact. */
const LIFE_BOUNDS = [3, 40] as const;

const at = (s: YearValue[] | undefined, year: number) => s?.find((p) => p.year === year)?.value ?? null;

function cagr(first: number | null, last: number | null, years: number): number | null {
  if (first === null || last === null || first <= 0 || last <= 0 || years < 1) return null;
  return (last / first) ** (1 / years) - 1;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Spending and depreciation by year, where both are reported and positive. */
export function investmentYears(h: InvestmentHistory): InvestmentYear[] {
  return (h.capex ?? [])
    .flatMap((c) => {
      const d = at(h.depreciation, c.year);
      return d !== null && d > 0 && c.value >= 0
        ? [{ year: c.year, capex: c.value, depreciation: d, revenue: at(h.revenue, c.year) }]
        : [];
    })
    .sort((a, b) => a.year - b.year);
}

/** What the card answers: is depreciation set to climb, and by how much against earnings. Null without the two lines. */
export function depreciationOutlook(h: InvestmentHistory): DepreciationOutlook | null {
  const years = investmentYears(h);
  if (years.length === 0) return null;
  const latest = years[years.length - 1];
  const first = years[0];
  const ratio = latest.capex / latest.depreciation;

  const intensityOf = (y: InvestmentYear) => (y.revenue !== null && y.revenue > 0 ? y.capex / y.revenue : null);
  const before = years.slice(0, -1).map(intensityOf).filter((x): x is number => x !== null);

  const gross = at(h.grossPPE, latest.year);
  const rawLife = gross !== null && gross > 0 ? gross / latest.depreciation : null;
  const life = rawLife !== null && rawLife >= LIFE_BOUNDS[0] && rawLife <= LIFE_BOUNDS[1] ? rawLife : null;

  const gap = latest.capex - latest.depreciation;
  const perYear = life !== null && gap > 0 ? gap / life : null;
  const oi = at(h.operatingIncome, latest.year);
  const share = (v: number | null) => (v !== null && oi !== null && oi > 0 ? v / oi : null);
  const gapShare = share(gap);

  const span = latest.year - first.year;
  const level = ratio < LEVEL_RATIO || (gapShare !== null && gapShare < MATERIAL_SHARE) ? 'none'
    : ratio >= WAVE_RATIO ? 'wave' : 'some';

  return {
    years, latest, ratio,
    firstRatio: span > 0 ? first.capex / first.depreciation : null,
    intensity: intensityOf(latest),
    intensityBefore: median(before),
    depreciationGrowth: cagr(first.depreciation, latest.depreciation, span),
    operatingIncomeGrowth: cagr(at(h.operatingIncome, first.year), oi, span),
    life, gap, perYear,
    operatingIncome: oi,
    gapShare, perYearShare: share(perYear),
    level,
  };
}

// ── Backtest candidates ─────────────────────────────────────────────────────

/** Capital spending over depreciation, newest year. */
function capexToDepreciation(h: InvestmentHistory): number | null {
  const years = investmentYears(h);
  const latest = years[years.length - 1];
  return latest ? latest.capex / latest.depreciation : null;
}

/**
 * Titman, Wei and Xie's abnormal capital investment: spending over revenue in
 * the newest year against its mean over the three years before, less one.
 */
function abnormalCapex(h: InvestmentHistory): number | null {
  const intensity = (h.capex ?? [])
    .flatMap((c) => {
      const r = at(h.revenue, c.year);
      return r !== null && r > 0 ? [{ year: c.year, value: c.value / r }] : [];
    })
    .sort((a, b) => a.year - b.year);
  if (intensity.length < 4) return null;
  const [y3, y2, y1, y0] = intensity.slice(-4);
  if (y0.year - y3.year !== 3) return null;   // four consecutive fiscal years, or nothing
  const mean = (y1.value + y2.value + y3.value) / 3;
  return mean > 0 ? y0.value / mean - 1 : null;
}

/** Cooper, Gulen and Schill's asset growth: total assets over the year before's, less one. */
function assetGrowth(h: InvestmentHistory): number | null {
  const s = [...h.totalAssets].sort((a, b) => a.year - b.year);
  if (s.length < 2) return null;
  const [prev, cur] = s.slice(-2);
  return cur.year - prev.year === 1 && prev.value > 0 ? cur.value / prev.value - 1 : null;
}

/** The signals the backtest measures; each abstains where its years are not on file. */
export const INVESTMENT_CANDIDATES: readonly {
  key: string; title: string; read: (f: StockFinancials) => number | null;
}[] = [
  { key: 'investment.capex-to-depreciation', title: 'Investitionen ÷ Abschreibungen', read: (f) => capexToDepreciation(f.fundamentalsHistory) },
  { key: 'investment.abnormal-capex', title: 'Investitionen über dem eigenen Schnitt', read: (f) => abnormalCapex(f.fundamentalsHistory) },
  { key: 'investment.asset-growth', title: 'Bilanzwachstum', read: (f) => assetGrowth(f.fundamentalsHistory) },
];
