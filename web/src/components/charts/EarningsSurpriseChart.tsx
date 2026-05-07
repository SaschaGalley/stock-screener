import ReactECharts from 'echarts-for-react';
import { CHART_COLORS, baseTextStyle } from './chartTheme';

interface Props {
  surprises: any[];
}

export default function EarningsSurpriseChart({ surprises }: Props) {
  const labels = surprises.map((s: any) => s.quarter);
  const surprisePcts = surprises.map((s: any) => s.surprisePct !== null ? s.surprisePct * 100 : 0);

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
          data: surprisePcts.map((v: number) => ({
            value: v,
            itemStyle: { color: v >= 0 ? CHART_COLORS.green : CHART_COLORS.red, borderRadius: [3, 3, 0, 0] },
          })),
        }],
        textStyle: baseTextStyle,
      }}
    />
  );
}
