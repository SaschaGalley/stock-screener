import ReactECharts from 'echarts-for-react';
import type { SignalGroup } from '../../types';
import { CHART_COLORS, baseTextStyle } from './chartTheme';

interface Props {
  group: SignalGroup;
  title: string;
}

/**
 * TradingView/Tipranks-style half-circle gauge:
 *   −1 STRONG SELL ←→ STRONG BUY +1
 * Needle position reflects (buy − sell) / total.
 */
export default function TechnicalGauge({ group, title }: Props) {
  // Map score from [-1, 1] to ECharts gauge value [0, 1]
  const gaugeValue = (group.score + 1) / 2;

  const verdictColor = (() => {
    switch (group.verdict) {
      case 'STRONG BUY':  return CHART_COLORS.green;
      case 'BUY':         return CHART_COLORS.green;
      case 'STRONG SELL': return CHART_COLORS.red;
      case 'SELL':        return CHART_COLORS.red;
      default:            return CHART_COLORS.amber;
    }
  })();

  return (
    <div className="rounded border border-ink-700 bg-ink-950 p-3">
      <div className="text-center text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        {title}
      </div>
      <div style={{ height: 180 }}>
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          option={{
            series: [
              {
                type: 'gauge',
                startAngle: 200,
                endAngle: -20,
                center: ['50%', '70%'],
                radius: '110%',
                min: 0,
                max: 1,
                splitNumber: 5,
                axisLine: {
                  lineStyle: {
                    width: 18,
                    color: [
                      [0.20, CHART_COLORS.red],          // Strong Sell
                      [0.40, '#c47c7e'],                 // Sell
                      [0.60, CHART_COLORS.amber],        // Neutral
                      [0.80, '#90b89c'],                 // Buy
                      [1.00, CHART_COLORS.green],        // Strong Buy
                    ],
                  },
                },
                axisTick: { show: false },
                splitLine: {
                  length: 8, distance: -18,
                  lineStyle: { color: CHART_COLORS.bg, width: 2 },
                },
                axisLabel: {
                  color: CHART_COLORS.ink,
                  fontSize: 9,
                  distance: -28,
                  formatter: (v: number) => {
                    if (v < 0.05) return 'Sell';
                    if (v > 0.95) return 'Buy';
                    if (Math.abs(v - 0.5) < 0.05) return 'Neutral';
                    return '';
                  },
                },
                pointer: {
                  length: '70%',
                  width: 4,
                  itemStyle: { color: CHART_COLORS.text },
                },
                anchor: {
                  show: true, size: 10, showAbove: true,
                  itemStyle: { color: CHART_COLORS.text, borderColor: CHART_COLORS.bg, borderWidth: 2 },
                },
                detail: {
                  valueAnimation: true,
                  fontSize: 13,
                  fontWeight: 'bold',
                  fontFamily: 'var(--font-sans)',
                  color: verdictColor,
                  offsetCenter: [0, '40%'],
                  formatter: () => group.verdict,
                },
                data: [{ value: gaugeValue }],
                animationDuration: 600,
              },
            ],
            textStyle: baseTextStyle,
          }}
        />
      </div>
      <div className="mt-1 flex items-center justify-around text-[10px]">
        <span className="text-emerald-400">{group.buy} buy</span>
        <span className="text-ink-500">{group.neutral} neutral</span>
        <span className="text-red-400">{group.sell} sell</span>
      </div>
    </div>
  );
}
