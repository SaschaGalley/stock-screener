import { useMemo } from 'react';
import ReactECharts from './ECharts';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { SCORE_BANDS, recommendationTone, verdictForScore } from '../../../../src/verdict';
import { deNumber } from '../../format';

/** Translucent version of a hex colour, for the bands behind the line. */
const alpha = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * The score over time, on the bands that turn it into a verdict.
 *
 * It used to be a sparkline in every row of the list, where it drew the eye
 * and said little: a line without a scale cannot tell a move across a band
 * from a wobble inside one. Here it has the scale — 0 to 10 with the bands
 * behind it — so a change of verdict is a line crossing a colour.
 */
export default function ScoreHistoryChart({ points }: { points: { at: string; score: number }[] }) {
  const option = useMemo(() => {
    const data = points.map((p) => [p.at, p.score]);
    const short = Date.parse(points[points.length - 1]?.at ?? '') - Date.parse(points[0]?.at ?? '') < 183 * 86_400_000;
    const tone = (v: string) => recommendationTone(v);
    const color = (v: string) => (tone(v) === 'positive' ? CHART_COLORS.green : tone(v) === 'negative' ? CHART_COLORS.red : CHART_COLORS.amber);
    // Bands from the top down: STRONG BUY above 8, BUY above 6.5, …
    const bands = SCORE_BANDS.map((b, k) => ({
      verdict: b.verdict,
      lo: Math.max(0, b.min),
      hi: k === 0 ? 10 : SCORE_BANDS[k - 1].min,
    }));
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: { top: 8, left: 36, right: 96, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: CHART_COLORS.bg,
        borderColor: CHART_COLORS.grid,
        textStyle: { color: CHART_COLORS.text, fontSize: 12 },
        formatter: (items: { value: [string, number] }[]) => {
          const [at, v] = items[0].value;
          const d = new Date(at);
          return `${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()}<br/>Score <b>${deNumber(v, 1)}</b> · ${verdictForScore(v)}`;
        },
      },
      xAxis: {
        type: 'time',
        // Under half a year a month label repeats from tick to tick; the day says more.
        minInterval: 86_400_000,
        axisLabel: {
          color: CHART_COLORS.ink, fontSize: 11, hideOverlap: true,
          formatter: (t: number) => {
            const d = new Date(t);
            return short ? `${d.getDate()}. ${MONTHS[d.getMonth()]}` : `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
          },
        },
        axisLine: { lineStyle: { color: CHART_COLORS.grid } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 10, interval: 2,
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
        splitLine: { show: false },
      },
      series: [{
        type: 'line', data, showSymbol: data.length < 40, symbolSize: 4, step: false,
        lineStyle: { color: CHART_COLORS.text, width: 1.8 },
        itemStyle: { color: CHART_COLORS.text },
        markArea: {
          silent: true,
          data: bands.map((b) => [
            {
              yAxis: b.lo,
              itemStyle: { color: alpha(color(b.verdict), b.verdict.startsWith('STRONG') ? 0.16 : 0.08) },
              label: { show: true, position: 'right', color: color(b.verdict), fontSize: 10, formatter: b.verdict },
            },
            { yAxis: b.hi },
          ]),
        },
      }],
    };
  }, [points]);

  if (points.length < 2) return <p className="text-xs text-ink-500">Noch zu wenige gespeicherte Scores für einen Verlauf.</p>;
  return (
    <div style={{ height: 200 }}>
      <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
    </div>
  );
}
