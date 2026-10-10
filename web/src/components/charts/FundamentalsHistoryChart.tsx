import { useMemo } from 'react';
import ReactECharts from './ECharts';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { useMoney } from '../../currency';
import { deNumber, fmtPct } from '../../format';
import { TREND_RATIOS, ratioSeries } from '../../../../src/analysis/trends';

type Series = { year: number; value: number }[];

interface History {
  revenue:            Series;
  grossProfit:        Series;
  operatingIncome:    Series;
  netIncome:          Series;
  eps:                Series;
  freeCashFlow:       Series;
  operatingCashFlow:  Series;
  totalAssets:        Series;
  stockholdersEquity: Series;
}

type Mode = 'income' | 'cashflow' | 'balance' | 'eps' | 'margins';

interface Props {
  history: History;
}

interface SeriesDef {
  label: string;
  color: string;
  points: (h: History) => Series;
}

export type Unit = 'money' | 'perShare' | 'pct';

const raw = (key: keyof History) => (h: History) => h[key];

const RATIO_COLORS = [CHART_COLORS.purple, CHART_COLORS.amber, CHART_COLORS.green, CHART_COLORS.blue];

const MODE_PRESETS: Record<Mode, { label: string; series: SeriesDef[]; unit?: Unit }> = {
  income: {
    label: 'Gewinn',
    series: [
      { points: raw('revenue'),         label: 'Umsatz',          color: CHART_COLORS.blue },
      { points: raw('grossProfit'),     label: 'Bruttogewinn',    color: CHART_COLORS.purple },
      { points: raw('operatingIncome'), label: 'Operativer Gewinn', color: CHART_COLORS.amber },
      { points: raw('netIncome'),       label: 'Nettogewinn',     color: CHART_COLORS.green },
    ],
  },
  cashflow: {
    label: 'Cashflow',
    series: [
      { points: raw('operatingCashFlow'), label: 'Operativer Cashflow', color: CHART_COLORS.blue },
      { points: raw('freeCashFlow'),      label: 'Free Cashflow', color: CHART_COLORS.green },
    ],
  },
  balance: {
    label: 'Bilanz',
    series: [
      { points: raw('totalAssets'),        label: 'Bilanzsumme',   color: CHART_COLORS.blue },
      { points: raw('stockholdersEquity'), label: 'Eigenkapital',  color: CHART_COLORS.green },
    ],
  },
  eps: {
    label: 'EPS',
    series: [{ points: raw('eps'), label: 'EPS (verwässert)', color: CHART_COLORS.amber }],
    unit: 'perShare',
  },
  // The absolute series above say how big; this says how good — whether this
  // year's margin is the company's normal or its best year in five.
  margins: {
    label: 'Margen',
    series: TREND_RATIOS.filter((r) => r.chart).map((r, i) => ({
      label: r.label,
      color: RATIO_COLORS[i % RATIO_COLORS.length],
      points: (h: History) => ratioSeries(h, r.num, r.den),
    })),
    unit: 'pct',
  },
};

/**
 * Axis/tooltip label for this chart only: per-share values keep two decimals,
 * absolutes are abbreviated one digit shorter than the app-wide `fmtBig` so the
 * axis stays narrow. Named apart from it so the difference is deliberate.
 *
 * `cur` is the trading currency's sign, written after the amount — the whole
 * series is FX-converted into it upstream, so one sign is right for every point.
 */
export function fmtChartValue(n: number, unit: Unit, cur: string): string {
  if (unit === 'pct') return fmtPct(n, 1);
  if (unit === 'perShare') return `${deNumber(n, 2)} ${cur}`;
  const a = Math.abs(n);
  if (a >= 1e12) return `${deNumber(n / 1e12, 2)} Bio. ${cur}`;
  if (a >= 1e9)  return `${deNumber(n / 1e9, 1)} Mrd. ${cur}`;
  if (a >= 1e6)  return `${deNumber(n / 1e6, 0)} Mio. ${cur}`;
  return `${deNumber(n, 0)} ${cur}`;
}

/** "+16 % im Jahr" over the years shown — what a line chart makes a reader estimate. */
function growthLine(points: Series): string | null {
  const xs = points.filter((p) => p.value > 0).sort((a, b) => a.year - b.year);
  if (xs.length < 2) return null;
  const years = xs[xs.length - 1].year - xs[0].year;
  if (years <= 0) return null;
  const cagr = (xs[xs.length - 1].value / xs[0].value) ** (1 / years) - 1;
  return `${cagr >= 0 ? '+' : '−'}${deNumber(Math.abs(cagr * 100), 0)} % im Jahr seit ${xs[0].year}`;
}

/**
 * The fiscal years as five small charts side by side — profits, cash flow,
 * balance sheet, earnings per share, margins — each headed by what its main
 * line did. It was one chart with five buttons, and only one of them on show.
 */
export default function FundamentalsHistoryChart({ history }: Props) {
  const modes = (Object.keys(MODE_PRESETS) as Mode[]).filter((k) => MODE_PRESETS[k].series.some((s) => s.points(history).length > 0));
  if (modes.length === 0) return <p className="text-xs text-ink-500">Keine historischen Daten verfügbar.</p>;
  return (
    <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 2xl:grid-cols-3">
      {modes.map((k) => <MiniChart key={k} history={history} mode={k} />)}
    </div>
  );
}

function MiniChart({ history, mode }: { history: History; mode: Mode }) {
  const { symbol: cur } = useMoney();
  const preset = MODE_PRESETS[mode];
  const unit: Unit = preset.unit ?? 'money';

  const resolved = useMemo(
    () => preset.series.map((def) => ({ def, points: def.points(history) })).filter((r) => r.points.length > 0),
    [history, preset],
  );
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of resolved) for (const p of r.points) set.add(p.year);
    return [...set].sort((a, b) => a - b);
  }, [resolved]);
  const lead = resolved[0];
  const growth = unit === 'pct' || !lead ? null : growthLine(lead.points);
  const last = lead?.points.length ? [...lead.points].sort((a, b) => a.year - b.year).at(-1)! : null;

  const series = resolved.map(({ def, points }) => {
    const lookup = new Map(points.map((p) => [p.year, p.value]));
    return {
      name: def.label,
      type: 'line' as const,
      data: years.map((y) => lookup.get(y) ?? null),
      itemStyle: { color: def.color },
      lineStyle: { color: def.color, width: 2 },
      symbol: 'circle',
      symbolSize: 5,
    };
  });

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-semibold text-ink-100">{preset.label}</span>
        {lead && (
          <span className="text-xs text-ink-400">
            {lead.def.label}{last && unit !== 'pct' ? ` ${fmtChartValue(last.value, unit, cur)}` : ''}{growth ? `, ${growth}` : ''}
          </span>
        )}
      </div>
      <div style={{ height: resolved.length > 2 ? 214 : 190 }}>
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          notMerge
          option={{
            // Four series wrap the legend onto a second line at this width.
            grid: { top: resolved.length > 2 ? 46 : resolved.length > 1 ? 26 : 10, left: 56, right: 12, bottom: 22 },
            tooltip: {
              trigger: 'axis',
              backgroundColor: CHART_COLORS.bg,
              borderColor: CHART_COLORS.grid,
              textStyle: { color: CHART_COLORS.text, fontSize: 12 },
              valueFormatter: (v: any) => v == null ? '—' : fmtChartValue(v, unit, cur),
            },
            legend: { show: resolved.length > 1, textStyle: { color: CHART_COLORS.text, fontSize: 11 }, top: 0, left: 0, itemWidth: 12, itemHeight: 8 },
            xAxis: {
              type: 'category',
              data: years.map((y) => String(y)),
              axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
              axisLine:  { lineStyle: { color: CHART_COLORS.grid } },
            },
            yAxis: {
              type: 'value',
              axisLabel: { color: CHART_COLORS.ink, fontSize: 10, formatter: (v: number) => fmtChartValue(v, unit, cur) },
              splitLine: { lineStyle: { color: CHART_COLORS.grid } },
            },
            series,
            textStyle: baseTextStyle,
          }}
        />
      </div>
    </div>
  );
}
