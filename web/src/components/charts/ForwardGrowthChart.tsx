import ReactECharts from './ECharts';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { fmtPercentPoints } from '../../format';

interface Props {
  estimates: any[];
}

export default function ForwardGrowthChart({ estimates }: Props) {
  const ordered = ['0q', '+1q', '0y', '+1y']
    .map((p) => estimates.find((e: any) => e.period === p))
    .filter(Boolean);

  const map: Record<string, string> = { '0q': 'lfd. Quartal', '+1q': 'nächstes Quartal', '0y': 'lfd. GJ', '+1y': 'nächstes GJ' };
  const labels = ordered.map((e: any) => map[e.period] ?? e.period);
  const epsGrowth = ordered.map((e: any) => e.epsGrowth !== null ? e.epsGrowth * 100 : null);
  const revGrowth = ordered.map((e: any) => e.revenueGrowth !== null ? e.revenueGrowth * 100 : null);

  return (
    <ReactECharts
      style={{ height: '100%', width: '100%' }}
      option={{
        grid: { top: 32, left: 50, right: 16, bottom: 24 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: CHART_COLORS.bg,
          borderColor: '#1e293b',
          textStyle: { color: CHART_COLORS.text, fontSize: 13 },
          valueFormatter: (v: number) => fmtPercentPoints(v, 1),
        },
        legend: {
          textStyle: { color: CHART_COLORS.text, fontSize: 12 },
          right: 8, top: 0,
        },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { color: CHART_COLORS.ink, fontSize: 12 },
          axisLine: { lineStyle: { color: '#334155' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: CHART_COLORS.ink, fontSize: 12, formatter: (v: number) => `${v.toLocaleString('de-DE').replace('-', '−')} %` },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        series: [
          {
            name: 'EPS-Wachstum ggü. Vj.',
            type: 'bar',
            data: epsGrowth,
            itemStyle: { color: CHART_COLORS.blue, borderRadius: [3, 3, 0, 0] },
          },
          {
            name: 'Umsatzwachstum ggü. Vj.',
            type: 'bar',
            data: revGrowth,
            itemStyle: { color: CHART_COLORS.green, borderRadius: [3, 3, 0, 0] },
          },
        ],
        textStyle: baseTextStyle,
      }}
    />
  );
}
