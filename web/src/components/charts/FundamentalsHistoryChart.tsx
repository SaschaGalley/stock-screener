import { useState, useMemo } from 'react';
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
  initialMode?: Mode;
}

interface SeriesDef {
  label: string;
  color: string;
  points: (h: History) => Series;
}

type Unit = 'money' | 'perShare' | 'pct';

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
function fmtChartValue(n: number, unit: Unit, cur: string): string {
  if (unit === 'pct') return fmtPct(n, 1);
  if (unit === 'perShare') return `${deNumber(n, 2)} ${cur}`;
  const a = Math.abs(n);
  if (a >= 1e12) return `${deNumber(n / 1e12, 2)} Bio. ${cur}`;
  if (a >= 1e9)  return `${deNumber(n / 1e9, 1)} Mrd. ${cur}`;
  if (a >= 1e6)  return `${deNumber(n / 1e6, 0)} Mio. ${cur}`;
  return `${deNumber(n, 0)} ${cur}`;
}

export default function FundamentalsHistoryChart({ history, initialMode = 'income' }: Props) {
  const { symbol: cur } = useMoney();
  const [mode, setMode] = useState<Mode>(initialMode);
  const preset = MODE_PRESETS[mode];
  const unit: Unit = preset.unit ?? 'money';

  const resolved = useMemo(
    () => preset.series.map((def) => ({ def, points: def.points(history) })),
    [history, preset],
  );

  // Union of all years across selected series, sorted ascending.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of resolved) for (const p of r.points) set.add(p.year);
    return [...set].sort((a, b) => a - b);
  }, [resolved]);

  if (years.length === 0) {
    return <p className="text-xs text-ink-500">Keine historischen Daten verfügbar.</p>;
  }

  const series = resolved.map(({ def, points }) => {
    const lookup = new Map(points.map((p) => [p.year, p.value]));
    return {
      name: def.label,
      type: 'line' as const,
      smooth: false,
      data: years.map((y) => lookup.get(y) ?? null),
      itemStyle: { color: def.color },
      lineStyle: { color: def.color, width: 2 },
      symbol: 'circle',
      symbolSize: 6,
    };
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {(Object.keys(MODE_PRESETS) as (keyof typeof MODE_PRESETS)[]).map((k) => {
          const active = k === mode;
          const has = MODE_PRESETS[k].series.some((s) => s.points(history).length > 0);
          return (
            <button
              key={k}
              disabled={!has}
              onClick={() => setMode(k)}
              className={`rounded border px-2.5 py-1 text-xs transition ${
                active
                  ? 'border-accent bg-accent-soft text-ink-100'
                  : has
                    ? 'border-ink-700 bg-ink-950 text-ink-400 hover:bg-ink-800'
                    : 'border-ink-800 bg-ink-950 text-ink-600 cursor-not-allowed'
              }`}
            >
              {MODE_PRESETS[k].label}
            </button>
          );
        })}
      </div>
      <div style={{ height: 260 }}>
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          notMerge
          option={{
            grid: { top: 32, left: 60, right: 24, bottom: 28 },
            tooltip: {
              trigger: 'axis',
              backgroundColor: CHART_COLORS.bg,
              borderColor: CHART_COLORS.grid,
              textStyle: { color: CHART_COLORS.text, fontSize: 13 },
              valueFormatter: (v: any) => v == null ? '—' : fmtChartValue(v, unit, cur),
            },
            legend: {
              textStyle: { color: CHART_COLORS.text, fontSize: 12 },
              top: 0,
              right: 8,
            },
            xAxis: {
              type: 'category',
              data: years.map((y) => String(y)),
              axisLabel: { color: CHART_COLORS.ink, fontSize: 12 },
              axisLine:  { lineStyle: { color: CHART_COLORS.grid } },
            },
            yAxis: {
              type: 'value',
              axisLabel: {
                color: CHART_COLORS.ink, fontSize: 11,
                formatter: (v: number) => fmtChartValue(v, unit, cur),
              },
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
