import { useMemo } from 'react';
import ReactECharts from './ECharts';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import type { ChartRead, ChartResponse } from '../../../../src/analysis/chart';

/** What can be drawn over the candles; each is a toggle above the chart. */
export const CHART_LAYERS = [
  { key: 'ma',         label: 'SMA 20/50/200' },
  { key: 'channel',    label: 'Kanal' },
  { key: 'levels',     label: 'Marken' },
  { key: 'trendlines', label: 'Trendlinien' },
  { key: 'profile',    label: 'Volumenzone' },
  { key: 'fib',        label: 'Fibonacci' },
  { key: 'gaps',       label: 'Kurslücken' },
  { key: 'pivots',     label: 'Wendepunkte' },
  { key: 'read',       label: 'KI-Lesung' },
] as const;
export type ChartLayer = (typeof CHART_LAYERS)[number]['key'];

interface Props {
  data:     ChartResponse;
  /** Sessions shown, from the newest back. */
  sessions: number;
  /** The regression channel drawn: 63, 126 or 252 sessions. */
  channel:  number;
  layers:   ReadonlySet<ChartLayer>;
  read:     ChartRead | null;
  fmtPrice: (n: number) => string;
  /** Any CSS height; the chart tab gives it most of the screen. */
  height?:  number | string;
}

const de = (x: number, d = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))}. ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;

/** Translucent version of a hex colour, for bands under the candles. */
const alpha = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * The price chart: candles and volume, and over them what `analysis/chart.ts`
 * read — the averages, a regression channel, the levels, the trend lines, the
 * year's volume zone, the Fibonacci retracements, open gaps and the swings —
 * and, when there is one, what a model read.
 *
 * Everything is computed on the full history and only drawn in the window, so
 * a line that began before the window enters it from the edge instead of
 * starting where the window does.
 */
export default function PriceChart({ data, sessions, channel, layers, read, fmtPrice, height = 440 }: Props) {
  const option = useMemo(() => {
    const { bars, sma, analysis: a } = data;
    const from = Math.max(0, bars.length - sessions);
    const shown = bars.slice(from);
    const days = shown.map((b) => b.day);
    const indexOf = new Map(bars.map((b, k) => [b.day, k]));
    const last = bars.length - 1;
    const on = (l: ChartLayer) => layers.has(l);

    // ── Price range: the candles in view, and the nearest level either side ──
    let lo = Math.min(...shown.map((b) => b.low ?? b.close));
    let hi = Math.max(...shown.map((b) => b.high ?? b.close));
    if (a && on('levels')) {
      const sup = a.levels.filter((l) => l.kind === 'support')[0];
      const res = a.levels.filter((l) => l.kind === 'resistance').at(-1);
      if (sup) lo = Math.min(lo, sup.price);
      if (res) hi = Math.max(hi, res.price);
    }
    const pad = (hi - lo) * 0.04;
    const yMin = Math.max(0, lo - pad), yMax = hi + pad;

    const series: object[] = [];
    const priceMarkLines: object[] = [];
    const priceMarkAreas: object[][] = [];

    // ── Candles ──
    series.push({
      name: 'Kurs', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0,
      data: shown.map((b) => [b.open ?? b.close, b.close, b.low ?? b.close, b.high ?? b.close]),
      itemStyle: {
        color: CHART_COLORS.green, color0: CHART_COLORS.red,
        borderColor: CHART_COLORS.green, borderColor0: CHART_COLORS.red,
      },
      barMaxWidth: 8,
      markLine: { symbol: 'none', silent: true, animation: false, data: priceMarkLines },
      markArea: { silent: true, animation: false, data: priceMarkAreas },
      z: 3,
    });

    // ── Volume ──
    series.push({
      name: 'Volumen', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
      data: shown.map((b, k) => ({
        value: b.volume,
        itemStyle: { color: alpha(b.close >= (k > 0 ? shown[k - 1].close : b.open ?? b.close) ? CHART_COLORS.green : CHART_COLORS.red, 0.45) },
      })),
      barMaxWidth: 8,
    });

    const lineSeries = (name: string, values: (number | null)[], color: string, extra: Record<string, unknown> = {}) => ({
      name, type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: values, showSymbol: false, connectNulls: false,
      lineStyle: { color, width: 1.2 }, itemStyle: { color }, emphasis: { disabled: true }, z: 2, ...extra,
    });

    // ── Moving averages ──
    if (on('ma')) {
      series.push(lineSeries('SMA 20', sma.sma20.slice(from), CHART_COLORS.amber, { lineStyle: { color: CHART_COLORS.amber, width: 1, opacity: 0.8 } }));
      series.push(lineSeries('SMA 50', sma.sma50.slice(from), CHART_COLORS.blue));
      series.push(lineSeries('SMA 200', sma.sma200.slice(from), CHART_COLORS.purple, { lineStyle: { color: CHART_COLORS.purple, width: 1.6 } }));
    }

    if (a) {
      // ── Regression channel: straight in log price, so geometric between its ends ──
      const ch = a.channels.find((c) => c.sessions === channel);
      if (on('channel') && ch) {
        const start = last - ch.sessions + 1;
        const along = (ends: [number, number]) => shown.map((_, k) => {
          const i = from + k - start;
          if (i < 0 || i >= ch.sessions) return null;
          return ends[0] * (ends[1] / ends[0]) ** (i / (ch.sessions - 1));
        });
        const style = { color: CHART_COLORS.copper, width: 1, type: 'dashed' as const, opacity: 0.9 };
        series.push(lineSeries('Kanal oben', along(ch.upper), CHART_COLORS.copper, { lineStyle: style }));
        series.push(lineSeries('Kanalmitte', along(ch.center), CHART_COLORS.copper, { lineStyle: { ...style, type: 'dotted', opacity: 0.6 } }));
        series.push(lineSeries('Kanal unten', along(ch.lower), CHART_COLORS.copper, { lineStyle: style }));
      }

      // ── Trend lines through the last two swings ──
      if (on('trendlines')) {
        for (const t of a.trendlines) {
          const p = indexOf.get(t.from.day), q = indexOf.get(t.to.day);
          if (p === undefined || q === undefined || q === p) continue;
          const slope = (Math.log(t.to.price) - Math.log(t.from.price)) / (q - p);
          const end = t.brokenAt ? Math.min(last, (indexOf.get(t.brokenAt) ?? last) + 10) : last;
          const color = t.kind === 'support' ? CHART_COLORS.green : CHART_COLORS.red;
          series.push(lineSeries(t.kind === 'support' ? 'Trendlinie Tiefs' : 'Trendlinie Hochs', shown.map((_, k) => {
            const i = from + k;
            return i < p || i > end ? null : Math.exp(Math.log(t.from.price) + slope * (i - p));
          }), color, { lineStyle: { color, width: 1.2, type: t.broken ? 'dotted' : 'solid', opacity: t.broken ? 0.6 : 0.9 } }));
        }
      }

      // ── Levels ──
      if (on('levels')) {
        for (const l of a.levels) {
          const color = l.kind === 'support' ? CHART_COLORS.green : CHART_COLORS.red;
          priceMarkLines.push({
            yAxis: l.price,
            lineStyle: { color, type: 'dashed', width: 0.8 + 1.6 * l.strength, opacity: 0.35 + 0.5 * l.strength },
            label: { show: true, position: 'insideEndTop', color, fontSize: 10, formatter: `${l.kind === 'support' ? 'U' : 'W'} ${de(l.price)}` },
          });
        }
      }

      // ── Where the year's volume traded ──
      if (on('profile') && a.profile) {
        priceMarkAreas.push([
          { yAxis: a.profile.valueLow, itemStyle: { color: alpha(CHART_COLORS.blue, 0.07) }, label: { show: true, position: 'insideTopLeft', color: CHART_COLORS.ink, fontSize: 10, formatter: '70 % Volumen' } },
          { yAxis: a.profile.valueHigh },
        ]);
        priceMarkLines.push({
          yAxis: a.profile.poc,
          lineStyle: { color: CHART_COLORS.blue, type: 'solid', width: 1, opacity: 0.6 },
          label: { show: true, position: 'insideStartTop', color: CHART_COLORS.blue, fontSize: 10, formatter: `POC ${de(a.profile.poc)}` },
        });
      }

      // ── Fibonacci of the year's move ──
      if (on('fib') && a.fibonacci) {
        for (const f of a.fibonacci.levels) {
          priceMarkLines.push({
            yAxis: f.price,
            lineStyle: { color: CHART_COLORS.purple, type: 'dotted', width: 1, opacity: 0.7 },
            label: { show: true, position: 'insideStartBottom', color: CHART_COLORS.purple, fontSize: 10, formatter: `${de(f.ratio * 100, 1)} %` },
          });
        }
      }

      // ── Gaps not yet filled, from their day to today ──
      if (on('gaps')) {
        for (const g of a.gaps) {
          const x0 = days.includes(g.day) ? g.day : days[0];
          priceMarkAreas.push([
            { xAxis: x0, yAxis: g.low, itemStyle: { color: alpha(CHART_COLORS.amber, 0.14) } },
            { xAxis: days.at(-1), yAxis: g.high },
          ]);
        }
      }

      // ── Swing points ──
      if (on('pivots')) {
        const pts = (kind: 'high' | 'low') => shown.map((b) => {
          const p = a.pivots.find((x) => x.day === b.day && x.kind === kind);
          return p ? p.price : null;
        });
        series.push({ name: 'Wendehoch', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts('high'), symbol: 'triangle', symbolRotate: 180, symbolSize: 7, symbolOffset: [0, -8], itemStyle: { color: CHART_COLORS.red }, z: 4 });
        series.push({ name: 'Wendetief', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: pts('low'), symbol: 'triangle', symbolSize: 7, symbolOffset: [0, 8], itemStyle: { color: CHART_COLORS.green }, z: 4 });
      }
    }

    // ── The model's reading: its levels, and the span of each pattern ──
    if (read && on('read')) {
      // Weak levels stay in the table: drawn beside the computed ones they only crowd the chart.
      for (const l of read.levels.filter((x) => x.strength !== 'weak')) {
        priceMarkLines.push({
          yAxis: l.price,
          lineStyle: { color: CHART_COLORS.purple, type: 'solid', width: l.strength === 'strong' ? 1.6 : 0.9, opacity: l.strength === 'strong' ? 0.85 : 0.5 },
          label: { show: l.strength === 'strong', position: 'insideEndBottom', color: CHART_COLORS.purple, fontSize: 10, formatter: `KI ${de(l.price)}` },
        });
      }
      for (const p of read.patterns) {
        if (!p.from) continue;
        const x0 = p.from < days[0] ? days[0] : days.find((d) => d >= p.from!) ?? days[0];
        const x1 = p.to ? [...days].reverse().find((d) => d <= p.to!) ?? days.at(-1) : days.at(-1);
        priceMarkAreas.push([
          { xAxis: x0, itemStyle: { color: alpha(CHART_COLORS.purple, 0.08) }, label: { show: true, position: 'insideTop', color: CHART_COLORS.purple, fontSize: 10, formatter: p.name } },
          { xAxis: x1 },
        ]);
        if (p.trigger !== null) {
          priceMarkLines.push({
            yAxis: p.trigger,
            lineStyle: { color: CHART_COLORS.purple, type: 'dashed', width: 1, opacity: 0.6 },
            label: { show: true, position: 'insideStartTop', color: CHART_COLORS.purple, fontSize: 10, formatter: `Auslöser ${de(p.trigger)}` },
          });
        }
      }
    }

    const axisLabel = { color: CHART_COLORS.ink, fontSize: 11 };
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: [
        { top: 12, left: 12, right: 64, height: '68%' },
        { left: 12, right: 64, top: '79%', bottom: 24 },
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: CHART_COLORS.ink } },
        backgroundColor: CHART_COLORS.bg,
        borderColor: CHART_COLORS.grid,
        textStyle: { color: CHART_COLORS.text, fontSize: 12 },
        formatter: (items: { dataIndex: number; seriesName: string; marker: string; value: unknown }[]) => {
          const k = items[0]?.dataIndex ?? 0;
          const b = shown[k];
          if (!b) return '';
          const prev = k > 0 ? shown[k - 1].close : (from > 0 ? bars[from - 1].close : null);
          const chg = prev ? b.close / prev - 1 : null;
          const rows = [
            `<b>${dayLabel(b.day)}</b>`,
            b.open !== null
              ? `E ${fmtPrice(b.open)} · H ${fmtPrice(b.high ?? b.close)} · T ${fmtPrice(b.low ?? b.close)} · S ${fmtPrice(b.close)}`
              : `Schluss ${fmtPrice(b.close)}`,
            chg !== null ? `Veränderung ${chg >= 0 ? '+' : '−'}${de(Math.abs(chg * 100), 1)} %` : '',
            b.volume !== null ? `Volumen ${de(b.volume / 1e6, 1)} Mio.` : '',
            ...items
              .filter((it) => it.seriesName.startsWith('SMA') && typeof it.value === 'number')
              .map((it) => `${it.marker}${it.seriesName} ${fmtPrice(it.value as number)}`),
          ];
          return rows.filter(Boolean).join('<br/>');
        },
      },
      xAxis: [
        { type: 'category', data: days, gridIndex: 0, boundaryGap: true, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: CHART_COLORS.grid } } },
        { type: 'category', data: days, gridIndex: 1, boundaryGap: true, axisLabel: { ...axisLabel, formatter: (d: string) => dayLabel(d).replace(/^\d+\. /, '') }, axisLine: { lineStyle: { color: CHART_COLORS.grid } } },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, min: yMin, max: yMax, position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => de(v, v >= 1000 ? 0 : 2) }, splitLine: { lineStyle: { color: CHART_COLORS.grid } } },
        { type: 'value', gridIndex: 1, position: 'right', axisLabel: { ...axisLabel, formatter: (v: number) => `${de(v / 1e6, 0)} M` }, splitNumber: 2, splitLine: { show: false } },
      ],
      dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }],
      series,
    };
  }, [data, sessions, channel, layers, read, fmtPrice]);

  return (
    <div style={{ height }}>
      <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
    </div>
  );
}
