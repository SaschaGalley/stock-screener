import ReactECharts from 'echarts-for-react';
import { CHART_COLORS } from './chartTheme';

interface Props {
  points: { at: string; score: number }[];
  width?: number;
  height?: number;
}

/**
 * Verdict score over time, table-cell sized.
 *
 * The y-window is padded rather than autoscaled: a plain autoscale turns a
 * wobble between 6.8 and 7.0 into a cliff, while the full 0–10 range flattens a
 * genuine two-point move into a straight line. So the window is the series ±1,
 * widened to a minimum span of 3 points and clamped to 0–10 — noise stays
 * visibly small, real movement stays visible, and no row can show a dramatic
 * shape for a change of 0.1.
 */
const MIN_SPAN = 3;

function yWindow(values: number[]): { min: number; max: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  let min = lo - 1;
  let max = hi + 1;
  const grow = MIN_SPAN - (max - min);
  if (grow > 0) {
    min -= grow / 2;
    max += grow / 2;
  }
  return { min: Math.max(0, Math.round(min * 10) / 10), max: Math.min(10, Math.round(max * 10) / 10) };
}
export default function ScoreSparkline({ points, width = 116, height = 34 }: Props) {
  if (points.length === 0) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-[10px] text-ink-600"
        title="Noch keine Verlaufspunkte — entsteht ab dem nächsten Lauf"
      >
        —
      </div>
    );
  }

  // A single point has no line to draw; show it as a dot so the row still reads
  // as "we have exactly one reading" rather than "no data".
  const single = points.length === 1;
  const last = points[points.length - 1].score;
  const first = points[0].score;
  const color = last > first ? CHART_COLORS.green : last < first ? CHART_COLORS.red : CHART_COLORS.blue;

  return (
    <ReactECharts
      style={{ width, height }}
      opts={{ renderer: 'svg' }}
      option={{
        animation: false,
        grid: { top: 3, left: 2, right: 2, bottom: 3 },
        xAxis: { type: 'category', show: false, data: points.map((p) => p.at), boundaryGap: false },
        yAxis: { type: 'value', show: false, ...yWindow(points.map((p) => p.score)) },
        tooltip: {
          trigger: 'axis',
          backgroundColor: CHART_COLORS.bg,
          borderColor: CHART_COLORS.grid,
          textStyle: { color: CHART_COLORS.text, fontSize: 11 },
          formatter: (params: { dataIndex: number }[]) => {
            const p = points[params[0].dataIndex];
            return `${new Date(p.at).toLocaleDateString()}<br/><b>${p.score.toFixed(1)}</b>/10`;
          },
        },
        series: [{
          type: 'line',
          data: points.map((p) => p.score),
          smooth: true,
          symbol: single ? 'circle' : 'none',
          symbolSize: 5,
          lineStyle: { width: 1.5, color },
          itemStyle: { color },
          areaStyle: { color, opacity: 0.12 },
        }],
      }}
    />
  );
}
