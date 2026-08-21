import { useState, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { useMoney } from '../../currency';

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

interface Props {
  history: History;
  initialMode?: 'income' | 'cashflow' | 'balance' | 'eps';
}

interface SeriesDef {
  key:   keyof History;
  label: string;
  color: string;
}

const MODE_PRESETS: Record<NonNullable<Props['initialMode']>, { label: string; series: SeriesDef[]; isPerShare?: boolean }> = {
  income: {
    label: 'Income',
    series: [
      { key: 'revenue',         label: 'Revenue',         color: CHART_COLORS.blue },
      { key: 'grossProfit',     label: 'Gross Profit',    color: CHART_COLORS.purple },
      { key: 'operatingIncome', label: 'Operating Income', color: CHART_COLORS.amber },
      { key: 'netIncome',       label: 'Net Income',      color: CHART_COLORS.green },
    ],
  },
  cashflow: {
    label: 'Cash Flow',
    series: [
      { key: 'operatingCashFlow', label: 'Operating CF', color: CHART_COLORS.blue },
      { key: 'freeCashFlow',      label: 'Free CF',      color: CHART_COLORS.green },
    ],
  },
  balance: {
    label: 'Balance Sheet',
    series: [
      { key: 'totalAssets',        label: 'Total Assets',  color: CHART_COLORS.blue },
      { key: 'stockholdersEquity', label: 'Equity',        color: CHART_COLORS.green },
    ],
  },
  eps: {
    label: 'EPS',
    series: [{ key: 'eps', label: 'Diluted EPS', color: CHART_COLORS.amber }],
    isPerShare: true,
  },
};

/**
 * Axis/tooltip label for this chart only: per-share values keep two decimals,
 * absolutes are abbreviated one digit shorter than the app-wide `fmtBig` so the
 * axis stays narrow. Named apart from it so the difference is deliberate.
 *
 * `cur` is the trading currency's prefix — the whole series is FX-converted
 * into it upstream, so one prefix is right for every point.
 */
function fmtChartValue(n: number, perShare: boolean, cur: string): string {
  if (perShare) return `${cur}${n.toFixed(2)}`;
  const a = Math.abs(n);
  if (a >= 1e12) return `${cur}${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9)  return `${cur}${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6)  return `${cur}${(n / 1e6).toFixed(0)}M`;
  return `${cur}${n.toFixed(0)}`;
}

export default function FundamentalsHistoryChart({ history, initialMode = 'income' }: Props) {
  const { symbol: cur } = useMoney();
  const [mode, setMode] = useState<NonNullable<Props['initialMode']>>(initialMode);
  const preset = MODE_PRESETS[mode];

  // Union of all years across selected series, sorted ascending.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const def of preset.series) {
      for (const p of history[def.key]) set.add(p.year);
    }
    return [...set].sort((a, b) => a - b);
  }, [history, preset]);

  if (years.length === 0) {
    return <p className="text-xs text-ink-500">No historical data available.</p>;
  }

  const series = preset.series.map((def) => {
    const lookup = new Map(history[def.key].map((p) => [p.year, p.value]));
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
      <div className="mb-3 flex items-center gap-1">
        {(Object.keys(MODE_PRESETS) as (keyof typeof MODE_PRESETS)[]).map((k) => {
          const active = k === mode;
          const has = MODE_PRESETS[k].series.some((s) => history[s.key].length > 0);
          return (
            <button
              key={k}
              disabled={!has}
              onClick={() => setMode(k)}
              className={`rounded border px-2.5 py-1 text-[11px] transition ${
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
              textStyle: { color: CHART_COLORS.text, fontSize: 12 },
              valueFormatter: (v: any) => v == null ? '—' : fmtChartValue(v, !!preset.isPerShare, cur),
            },
            legend: {
              textStyle: { color: CHART_COLORS.text, fontSize: 11 },
              top: 0,
              right: 8,
            },
            xAxis: {
              type: 'category',
              data: years.map((y) => String(y)),
              axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
              axisLine:  { lineStyle: { color: CHART_COLORS.grid } },
            },
            yAxis: {
              type: 'value',
              axisLabel: {
                color: CHART_COLORS.ink, fontSize: 10,
                formatter: (v: number) => fmtChartValue(v, !!preset.isPerShare, cur),
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
