import ReactECharts from './ECharts';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { useMoney } from '../../currency';
import { fmtSignedPct } from '../../format';
import { growthPair, pastAndForecast, type ForecastInput } from '../../../../src/analysis/forecast';
import Term from '../Term';

/**
 * Reported years and the consensus for the next two on one axis: revenue as
 * bars, EPS as a line, the estimates lighter and dashed, with the range from
 * the lowest to the highest analyst in the tooltip.
 */
export default function ForecastChart(input: ForecastInput) {
  const { fmtBig, fmtPrice } = useMoney();
  const rows = pastAndForecast(input);
  if (rows.filter((r) => !r.estimate).length < 2) return null;
  const revG = growthPair(rows, (r) => r.revenue);
  const epsG = growthPair(rows, (r) => r.eps);
  const hasEstimates = rows.some((r) => r.estimate);
  const lastActual = rows.map((r) => r.estimate).lastIndexOf(false);

  const option = {
    grid: { top: 32, left: 64, right: 56, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.bg,
      borderColor: CHART_COLORS.grid,
      textStyle: { color: CHART_COLORS.text, fontSize: 13 },
      formatter: (items: { dataIndex: number }[]) => {
        const r = rows[items[0]?.dataIndex ?? 0];
        const lines = [`GJ ${r.year}${r.estimate ? ` · Konsens${r.analysts ? ` (${r.analysts} Analysten)` : ''}` : ''}`,
          `Umsatz: ${r.revenue === null ? '—' : fmtBig(r.revenue)}`,
          `EPS: ${r.eps === null ? '—' : fmtPrice(r.eps)}`];
        if (r.estimate && r.epsLow !== null && r.epsHigh !== null) lines.push(`Spanne: ${fmtPrice(r.epsLow)} – ${fmtPrice(r.epsHigh)}`);
        return lines.join('<br/>');
      },
    },
    legend: { textStyle: { color: CHART_COLORS.text, fontSize: 12 }, top: 0, right: 8, data: ['Umsatz', 'EPS'] },
    xAxis: {
      type: 'category',
      data: rows.map((r) => `${r.year}${r.estimate ? 'e' : ''}`),
      axisLabel: { color: CHART_COLORS.ink, fontSize: 12 },
      axisLine: { lineStyle: { color: CHART_COLORS.grid } },
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (v: number) => fmtBig(v) },
        splitLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      {
        type: 'value',
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (v: number) => fmtPrice(v) },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Umsatz', type: 'bar', barMaxWidth: 36,
        data: rows.map((r) => ({
          value: r.revenue,
          itemStyle: { color: CHART_COLORS.blue, opacity: r.estimate ? 0.35 : 0.85 },
        })),
      },
      {
        name: 'EPS', type: 'line', yAxisIndex: 1, symbolSize: 6,
        itemStyle: { color: CHART_COLORS.amber }, lineStyle: { color: CHART_COLORS.amber, width: 2 },
        data: rows.map((r) => (r.estimate ? null : r.eps)),
      },
      // The consensus continues the line from the last reported year, dashed.
      ...(hasEstimates ? [{
        name: 'EPS', type: 'line', yAxisIndex: 1, symbolSize: 6,
        itemStyle: { color: CHART_COLORS.amber }, lineStyle: { color: CHART_COLORS.amber, width: 2, type: 'dashed' },
        data: rows.map((r, i) => (r.estimate || i === lastActual ? r.eps : null)),
      }] : []),
      ...(hasEstimates ? [{
        name: 'EPS-Spanne', type: 'line', yAxisIndex: 1, symbol: 'none', silent: true,
        lineStyle: { color: CHART_COLORS.amber, width: 1, type: 'dotted', opacity: 0.7 },
        data: rows.map((r) => r.epsHigh),
      }, {
        name: 'EPS-Spanne', type: 'line', yAxisIndex: 1, symbol: 'none', silent: true,
        lineStyle: { color: CHART_COLORS.amber, width: 1, type: 'dotted', opacity: 0.7 },
        data: rows.map((r) => r.epsLow),
      }] : []),
    ],
    textStyle: baseTextStyle,
  };

  const line = (label: string, g: ReturnType<typeof growthPair>) => (
    <span>
      {label}{' '}
      {g.past !== null && <>{fmtSignedPct(g.past, 0)}/Jahr über {g.pastYears} J</>}
      {g.ahead !== null && <>{g.past !== null ? ', ' : ''}Konsens {fmtSignedPct(g.ahead, 0)}/Jahr für die nächsten {g.aheadYears} J</>}
    </span>
  );

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-500">
        <Term k="concept.forecast">Vergangenheit &amp; Prognose</Term>
      </h3>
      <p className="mb-2 text-xs text-ink-400">
        {line('Umsatz', revG)}
        {(epsG.past !== null || epsG.ahead !== null) && <> · {line('EPS', epsG)}</>}
      </p>
      <div style={{ height: 240 }}>
        <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
      </div>
    </div>
  );
}
