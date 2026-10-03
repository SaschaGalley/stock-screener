import { memo, useState } from 'react';
import { CHART_COLORS } from './chartTheme';

interface Props {
  points: { at: string; score: number }[];
  width?: number;
  height?: number;
}

/**
 * Verdict score over time, table-cell sized — drawn as plain SVG. It was an
 * ECharts instance a row, three dozen of them in the list, each handed a new
 * tooltip function on every render and so redrawn with every poll.
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
function ScoreSparkline({ points, width = 116, height = 34 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-2xs text-ink-600"
        title="Noch keine Verlaufspunkte — entsteht ab dem nächsten Lauf"
      >
        —
      </div>
    );
  }

  const last = points[points.length - 1].score;
  const first = points[0].score;
  const color = last > first ? CHART_COLORS.green : last < first ? CHART_COLORS.red : CHART_COLORS.blue;
  const { min, max } = yWindow(points.map((p) => p.score));
  const PAD_X = 2, PAD_Y = 3;
  const x = (i: number) => (points.length === 1 ? width / 2 : PAD_X + (i * (width - 2 * PAD_X)) / (points.length - 1));
  const y = (v: number) => PAD_Y + (1 - (v - min) / (max - min || 1)) * (height - 2 * PAD_Y);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${height - PAD_Y}L${x(0).toFixed(1)},${height - PAD_Y}Z`;
  const shown = hover !== null ? points[hover] : null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        className="block"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - PAD_X) / (width - 2 * PAD_X)) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {points.length > 1 && <path d={area} fill={color} fillOpacity={0.12} />}
        {points.length > 1 && <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />}
        {(points.length === 1 || hover !== null) && (
          <circle cx={x(hover ?? 0)} cy={y(points[hover ?? 0].score)} r={2.5} fill={color} />
        )}
      </svg>
      {shown && (
        <div
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs"
          style={{ background: CHART_COLORS.bg, borderColor: CHART_COLORS.grid, color: CHART_COLORS.text }}
        >
          {new Date(shown.at).toLocaleDateString()} · <b>{shown.score.toFixed(1)}</b>/10
        </div>
      )}
    </div>
  );
}

export default memo(ScoreSparkline);
