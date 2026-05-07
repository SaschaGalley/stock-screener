import ReactECharts from 'echarts-for-react';
import { CHART_COLORS, baseTextStyle } from './chartTheme';

interface Props {
  returns: any;
}

export default function ReturnsChart({ returns }: Props) {
  const periods = [
    { key: 'd1',  label: '1D' },
    { key: 'w1',  label: '1W' },
    { key: 'm1',  label: '1M' },
    { key: 'm3',  label: '3M' },
    { key: 'm6',  label: '6M' },
    { key: 'ytd', label: 'YTD' },
    { key: 'y1',  label: '1Y' },
  ];

  const labels = periods.map((p) => p.label);
  const values = periods.map((p) => returns[p.key] !== null ? returns[p.key] * 100 : 0);

  return (
    <ReactECharts
      style={{ height: '100%', width: '100%' }}
      option={{
        grid: { top: 16, left: 45, right: 16, bottom: 24 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: CHART_COLORS.bg,
          borderColor: '#1e293b',
          textStyle: { color: CHART_COLORS.text, fontSize: 12 },
          valueFormatter: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`,
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
        series: [{
          type: 'bar',
          data: values.map((v: number) => ({
            value: v,
            itemStyle: { color: v >= 0 ? CHART_COLORS.green : CHART_COLORS.red, borderRadius: [3, 3, 0, 0] },
          })),
        }],
        textStyle: baseTextStyle,
      }}
    />
  );
}
