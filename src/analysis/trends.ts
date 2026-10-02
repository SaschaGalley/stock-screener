/**
 * Margins and returns per fiscal year, and where the latest year sits against
 * the ones before it.
 *
 * The detail page showed the absolute series — revenue, operating income, free
 * cash flow — and today's margins, but never the two together: whether a 32 %
 * operating margin is the company's normal or its best year in five is the
 * question an absolute chart cannot answer and a single TTM figure hides.
 *
 * Dependency-free and pure so the web app can import it across the package
 * boundary, like `src/cases.ts`.
 */

export interface YearValue { year: number; value: number }

/** The annual series this reads — a structural subset of `fundamentalsHistory`. */
export interface AnnualHistory {
  revenue:            YearValue[];
  grossProfit:        YearValue[];
  operatingIncome:    YearValue[];
  netIncome:          YearValue[];
  freeCashFlow:       YearValue[];
  totalAssets:        YearValue[];
  stockholdersEquity: YearValue[];
}

/**
 * Each ratio as numerator over denominator. A closed set of definitions rather
 * than something derivable — but declared once, so the chart, the table and
 * their labels cannot disagree about what "FCF-Konversion" divides by.
 */
export const TREND_RATIOS = [
  { key: 'grossMargin',     label: 'Bruttomarge',     num: 'grossProfit',     den: 'revenue',            chart: true },
  { key: 'operatingMargin', label: 'Operative Marge', num: 'operatingIncome', den: 'revenue',            chart: true },
  { key: 'netMargin',       label: 'Nettomarge',      num: 'netIncome',       den: 'revenue',            chart: true },
  { key: 'fcfMargin',       label: 'FCF-Marge',       num: 'freeCashFlow',    den: 'revenue',            chart: true },
  { key: 'fcfConversion',   label: 'FCF-Konversion',  num: 'freeCashFlow',    den: 'netIncome',          chart: false },
  { key: 'roe',             label: 'ROE',             num: 'netIncome',       den: 'stockholdersEquity', chart: false },
  { key: 'roa',             label: 'ROA',             num: 'netIncome',       den: 'totalAssets',        chart: false },
] as const satisfies readonly {
  key: string; label: string; num: keyof AnnualHistory; den: keyof AnnualHistory; chart: boolean;
}[];

export type TrendRatioKey = (typeof TREND_RATIOS)[number]['key'];

/**
 * One ratio, year by year, for the years both series cover.
 *
 * A year whose denominator is zero or negative is left out rather than
 * computed: a margin on negative revenue, a conversion rate against a loss and
 * a return on negative equity are all numbers with the wrong sign of meaning.
 */
export function ratioSeries(h: AnnualHistory, num: keyof AnnualHistory, den: keyof AnnualHistory): YearValue[] {
  const d = new Map(h[den].map((p) => [p.year, p.value]));
  return h[num]
    .filter((p) => (d.get(p.year) ?? 0) > 0)
    .map((p) => ({ year: p.year, value: p.value / d.get(p.year)! }))
    .sort((a, b) => a.year - b.year);
}

export interface TrendSummary {
  latest:     YearValue | null;
  /** Mean of the last three fiscal years, the latest included. */
  avg3:       number | null;
  /** Mean of every year on file, up to five — `years` says how many. */
  avgAll:     number | null;
  /** Latest minus the mean of the years before it — the direction of travel. */
  vsPrior:    number | null;
  years:      number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarise(series: YearValue[]): TrendSummary {
  const s = series.slice(-5);
  const latest = s.length ? s[s.length - 1] : null;
  const prior = s.slice(0, -1).map((p) => p.value);
  const priorMean = mean(prior);
  return {
    latest,
    avg3:    s.length >= 2 ? mean(s.slice(-3).map((p) => p.value)) : null,
    avgAll:  s.length >= 3 ? mean(s.map((p) => p.value)) : null,
    vsPrior: latest && priorMean !== null ? latest.value - priorMean : null,
    years:   s.length,
  };
}

/** Every ratio, summarised — what the table renders. */
export function trendTable(h: AnnualHistory): { key: TrendRatioKey; label: string; series: YearValue[]; summary: TrendSummary }[] {
  return TREND_RATIOS.map((r) => {
    const series = ratioSeries(h, r.num, r.den);
    return { key: r.key, label: r.label, series, summary: summarise(series) };
  }).filter((r) => r.series.length > 0);
}
