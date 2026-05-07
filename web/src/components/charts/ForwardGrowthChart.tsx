import ReactECharts from 'echarts-for-react';
import { CHART_COLORS, baseTextStyle } from './chartTheme';

interface Props {
  estimates: any[];
}

export default function ForwardGrowthChart({ estimates }: Props) {
  const ordered = ['0q', '+1q', '0y', '+1y']
    .map((p) => estimates.find((e: any) => e.period === p))
    .filter(Boolean);

  const map: Record<string, string> = { '0q': 'Cur Qtr', '+1q': 'Nxt Qtr', '0y': 'Cur Year', '+1y': 'Nxt Year' };
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
          textStyle: { color: CHART_COLORS.text, fontSize: 12 },
          valueFormatter: (v: number) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
        },
        legend: {
          textStyle: { color: CHART_COLORS.text, fontSize: 11 },
          right: 8, top: 0,
        },
        xAxis: {
          type: 'category',
          data: labels,
          axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
          axisLine: { lineStyle: { color: '#334155' } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: '{value}%' },
          splitLine: { lineStyle: { color: '#1e293b' } },
        },
        series: [
          {
            name: 'EPS Growth YoY',
            type: 'bar',
            data: epsGrowth,
            itemStyle: { color: CHART_COLORS.blue, borderRadius: [3, 3, 0, 0] },
          },
          {
            name: 'Revenue Growth YoY',
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
