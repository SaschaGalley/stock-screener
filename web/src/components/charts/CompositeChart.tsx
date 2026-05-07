import ReactECharts from 'echarts-for-react';
import type { CompositeFairValue } from '../../types';
import { CHART_COLORS, baseTextStyle } from './chartTheme';

interface Props {
  composite: CompositeFairValue;
  price: number;
}

/**
 * Stacked bar chart of every contributing model's fair value, grouped by tier
 * (Primary = filled, Conservative = outlined). Vertical line at current market
 * price. Color reflects under/overvaluation.
 */
export default function CompositeChart({ composite, price }: Props) {
  type Row = { name: string; value: number; tier: 'primary' | 'conservative' };
  const rows: Row[] = [
    ...composite.primary.models.map((m) => ({ name: m.name, value: m.fairValue, tier: 'primary' as const })),
    ...composite.conservative.models.map((m) => ({ name: m.name, value: m.fairValue, tier: 'conservative' as const })),
  ].sort((a, b) => a.value - b.value);

  if (rows.length === 0) return null;

  const labels = rows.map((r) => r.name);
  const values = rows.map((r) => {
    const isUndervalued = r.value > price;
    const baseColor = isUndervalued ? CHART_COLORS.green : CHART_COLORS.red;
    return {
      value: r.value,
      itemStyle: r.tier === 'primary'
        ? { color: baseColor, borderRadius: [0, 3, 3, 0] }
        : { color: 'transparent', borderColor: baseColor, borderWidth: 1.5, borderRadius: [0, 3, 3, 0] },
    };
  });

  const allValues = [...rows.map((r) => r.value), price];
  const xMin = Math.min(...allValues) * 0.85;
  const xMax = Math.max(...allValues) * 1.15;

  return (
    <ReactECharts
      style={{ height: '100%', width: '100%' }}
      option={{
        grid: { top: 16, left: 160, right: 32, bottom: 32 },
        tooltip: {
          trigger: 'item',
          backgroundColor: CHART_COLORS.bg,
          borderColor: CHART_COLORS.grid,
          textStyle: { color: CHART_COLORS.text, fontSize: 12 },
          formatter: (p: any) => {
            const row = rows[p.dataIndex];
            const tierLabel = row.tier === 'primary' ? 'Primary' : 'Conservative';
            return `${p.name} (${tierLabel}): <b>$${p.value.toFixed(2)}</b><br/>vs price $${price.toFixed(2)}: ` +
              `${((p.value - price) / price * 100).toFixed(1)}%`;
          },
        },
        xAxis: {
          type: 'value',
          min: xMin,
          max: xMax,
          axisLabel: { color: CHART_COLORS.ink, fontSize: 10, formatter: (v: number) => `$${v.toFixed(0)}` },
          splitLine: { lineStyle: { color: CHART_COLORS.grid } },
        },
        yAxis: {
          type: 'category',
          data: labels,
          axisLabel: {
            color: CHART_COLORS.ink, fontSize: 11,
            formatter: (label: string) => {
              const isPrimary = composite.primary.models.some((m) => m.name === label);
              return isPrimary ? `{primary|${label}}` : `{cons|${label}}`;
            },
            rich: {
              primary: { color: CHART_COLORS.text, fontWeight: 'bold' as any },
              cons:    { color: CHART_COLORS.ink },
            },
          },
          axisLine: { lineStyle: { color: CHART_COLORS.grid } },
          axisTick: { show: false },
        },
        series: [
          {
            type: 'bar',
            data: values,
            barWidth: 14,
            label: {
              show: true,
              position: 'right',
              color: CHART_COLORS.text,
              fontSize: 10,
              fontFamily: 'monospace',
              formatter: (p: any) => `$${p.value.toFixed(0)}`,
            },
            markLine: {
              symbol: 'none',
              lineStyle: { color: CHART_COLORS.text, type: 'dashed', width: 1.5 },
              label: {
                color: CHART_COLORS.text,
                fontSize: 10,
                fontFamily: 'monospace',
                formatter: () => `Price $${price.toFixed(2)}`,
                position: 'end',
              },
              data: [{ xAxis: price }],
            },
          },
        ],
        textStyle: baseTextStyle,
      }}
    />
  );
}
