import {
  depreciationOutlook, LEVEL_RATIO, type DepreciationOutlook as Outlook, type InvestmentHistory,
} from '../../../../src/analysis/investment';
import ReactECharts from '../charts/ECharts';
import { fmtChartValue } from '../charts/FundamentalsHistoryChart';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import { AnswerCard } from '../chart/shared';
import Term from '../Term';
import { useMoney } from '../../currency';
import { deNumber, fmtPct, fmtSignedPct } from '../../format';

const times = (x: number) => `${deNumber(x, 1)}×`;
/** A yearly rate with its sign; under half a percent is no change, not "−0 %". */
const signed = (x: number) => (Math.abs(x) < 0.005 ? '±0 %' : fmtSignedPct(x, 0));

/**
 * Whether the investment of the last years is still to reach earnings: capital
 * spending against depreciation, the answer in a card, the years in bars
 * beside it. `analysis/investment.ts` says how the size is estimated.
 */
export default function DepreciationOutlook({ history }: { history: InvestmentHistory }) {
  const { fmtBig } = useMoney();
  const o = depreciationOutlook(history);
  if (!o) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">
        <Term k="concept.depreciationWave">Investitionen &amp; Abschreibungen</Term>
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        <AnswerCard question="Kommt eine Abschreibungswelle?" answer={answer(o)} tone={o.level === 'wave' ? 'bear' : o.level === 'none' ? 'bull' : 'neutral'} why={reasons(o, fmtBig)} />
        <Bars o={o} />
      </div>
    </div>
  );
}

function answer(o: Outlook): string {
  const spends = `investiert ${times(o.ratio)} so viel, wie es abschreibt`;
  if (o.level === 'wave') return `Ja: ${spends}`;
  if (o.level === 'some') return `Etwas: ${spends}`;
  if (o.ratio >= LEVEL_RATIO) return 'Nein: zu klein, um den Gewinn zu bewegen';
  return o.ratio >= 1 ? 'Nein: investiert etwa so viel, wie es abschreibt' : 'Nein: schreibt mehr ab, als es investiert';
}

function reasons(o: Outlook, fmtBig: (n: number | null | undefined) => string): string[] {
  const out: string[] = [];
  if (o.firstRatio !== null) out.push(`${o.years[0].year} waren es ${times(o.firstRatio)}, ${o.latest.year} ${times(o.ratio)}`);
  if (o.intensity !== null && o.intensityBefore !== null) {
    out.push(`Investitionen ${fmtPct(o.intensity, 0)} vom Umsatz, in den Jahren davor im Mittel ${fmtPct(o.intensityBefore, 0)}`);
  }
  if (o.gap > 0 && o.level !== 'none') {
    const ofProfit = (share: number | null) => (share !== null ? `, ${fmtPct(share, 0)} des operativen Gewinns ${o.latest.year}` : '');
    out.push(o.perYear !== null && o.life !== null
      ? `Bleiben die Investitionen so hoch, liegen die Abschreibungen am Ende ${fmtBig(o.gap)} über heute: bei rund ${deNumber(o.life, 0)} Jahren Nutzungsdauer kommen jedes Jahr ${fmtBig(o.perYear)} dazu${ofProfit(o.perYearShare)}`
      : `Bleiben die Investitionen so hoch, liegen die Abschreibungen am Ende ${fmtBig(o.gap)} über heute${ofProfit(o.gapShare)}`);
  }
  if (o.depreciationGrowth !== null && o.operatingIncomeGrowth !== null) {
    out.push(`Seit ${o.years[0].year} je Jahr: Abschreibungen ${signed(o.depreciationGrowth)}, operativer Gewinn ${signed(o.operatingIncomeGrowth)}`);
  }
  return out;
}

/** The two lines as bars per fiscal year: the gap opening is the picture. */
function Bars({ o }: { o: Outlook }) {
  const { fmtBig, symbol: cur } = useMoney();
  const years = o.years.map((y) => String(y.year));
  const bar = (name: string, color: string, data: number[]) => ({
    name, type: 'bar' as const, data, itemStyle: { color }, barMaxWidth: 18,
  });
  return (
    <div style={{ height: 180 }}>
      <ReactECharts
        style={{ height: '100%', width: '100%' }}
        notMerge
        option={{
          grid: { top: 26, left: 56, right: 8, bottom: 22 },
          tooltip: {
            trigger: 'axis',
            backgroundColor: CHART_COLORS.bg,
            borderColor: CHART_COLORS.grid,
            textStyle: { color: CHART_COLORS.text, fontSize: 12 },
            valueFormatter: (v: any) => (v == null ? '—' : fmtBig(v)),
          },
          legend: { textStyle: { color: CHART_COLORS.text, fontSize: 11 }, top: 0, left: 0, itemWidth: 12, itemHeight: 8 },
          xAxis: {
            type: 'category', data: years,
            axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          yAxis: {
            type: 'value',
            axisLabel: { color: CHART_COLORS.ink, fontSize: 10, formatter: (v: number) => fmtChartValue(v, 'money', cur) },
            splitLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          series: [
            bar('Investitionen', CHART_COLORS.blue, o.years.map((y) => y.capex)),
            bar('Abschreibungen', CHART_COLORS.amber, o.years.map((y) => y.depreciation)),
          ],
          textStyle: baseTextStyle,
        }}
      />
    </div>
  );
}
