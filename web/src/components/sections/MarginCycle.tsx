import ReactECharts from '../charts/ECharts';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import { AnswerCard } from '../chart/shared';
import Term from '../Term';
import { api } from '../../api';
import { useArchive } from '../useArchive';
import { deNumber, fmtPct } from '../../format';
import { cycleReading, type CycleReading, type MarginHistory, type MarginKey } from '../../../../src/analysis/cycle';

/** A P/E on normal margins this close to today's says nothing the P/E does not. */
const SAME_PE = 0.05;
/** Finnhub's first years of a young company run to −1000 %; the axis stops here. */
const AXIS_FLOOR = -50;

const ANSWER: Record<CycleReading['level'], string> = {
  peak:   'Ja: operative Marge weit über ihrem Schnitt',
  high:   'Nahe am Hoch, aber kaum über dem Schnitt',
  normal: 'Nein: Marge im üblichen Bereich',
  low:    'Eher unten, aber nahe am Schnitt',
  trough: 'Nein, im Tal: Marge weit unter ihrem Schnitt',
};

/**
 * Whether the business stands at a peak of its own cycle (`analysis/cycle.ts`):
 * today's margins against every fiscal year on record, and the P/E as it would
 * read on a normal margin. The card answers, the years are the lines beside it.
 */
export default function MarginCycle({ symbol, now, pe }: {
  symbol: string; now: Record<MarginKey, number | null>; pe: number | null;
}) {
  const { data } = useArchive(() => api.getMargins(symbol), [symbol]);
  const r = data ? cycleReading(data, now, pe) : null;
  if (!data || !r) return null;
  const op = r.lines.find((l) => l.key === 'operatingMargin')!;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">
        <Term k="concept.marginCycle">Margen im Zyklus</Term>
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        <AnswerCard
          question="Steht das Geschäft am Gipfel?"
          answer={r.level === 'peak' && op.record ? 'Ja: operative Marge auf Rekordhöhe' : ANSWER[r.level]}
          tone={r.level === 'peak' ? 'bear' : r.level === 'trough' ? 'bull' : 'neutral'}
          why={reasons(r, pe, data)}
        />
        <Lines history={data} r={r} />
      </div>
    </div>
  );
}

function reasons(r: CycleReading, pe: number | null, h: MarginHistory): string[] {
  const out = r.lines.map((l) => {
    const above = Math.round(l.rank * l.years);
    const where = l.record ? `höher als in allen ${l.years} Jahren seit ${l.since}`
      : above === 0 ? `niedriger als in jedem der ${l.years} Jahre seit ${l.since}`
      : `höher als in ${above} von ${l.years} Jahren seit ${l.since}`;
    return `${l.label} ${fmtPct(l.now, 1)}: ${where}; im Mittel der letzten ${l.window} Jahre ${fmtPct(l.median, 1)}`;
  });
  if (r.normalizedPE !== null && pe !== null && Math.abs(r.normalizedPE / pe - 1) >= SAME_PE) {
    out.push(`Mit der Nettomarge auf ihrem Mittel läge das KGV bei ${deNumber(r.normalizedPE, 1)} statt ${deNumber(pe, 1)}`);
  }
  out.push(h.source === 'finnhub'
    ? 'Geschäftsjahre von Finnhub; heute: die letzten vier Quartale'
    : `Nur ${h.years.length} Geschäftsjahre von Yahoo — weniger als ein ganzer Zyklus`);
  return out;
}

/** Operating and net margin year by year, today as the last point, the operating margin's median dashed. */
function Lines({ history, r }: { history: MarginHistory; r: CycleReading }) {
  const years = [...history.years].sort((a, b) => a.year - b.year);
  const labels = [...years.map((y) => String(y.year)), 'heute'];
  const op = r.lines.find((l) => l.key === 'operatingMargin')!;
  const net = r.lines.find((l) => l.key === 'netMargin');
  const line = (name: string, color: string, past: (number | null)[], today: number | null, median?: number) => ({
    name, type: 'line' as const, symbol: 'none', connectNulls: true,
    itemStyle: { color }, lineStyle: { color, width: 2 },
    data: [...past, today].map((v) => (v === null ? null : v * 100)),
    ...(median !== undefined ? {
      markLine: {
        symbol: 'none', silent: true, label: { show: false },
        lineStyle: { color, type: 'dashed' as const, width: 1 },
        data: [{ yAxis: median * 100 }],
      },
    } : {}),
  });
  return (
    <div style={{ height: 180 }}>
      <ReactECharts
        style={{ height: '100%', width: '100%' }}
        notMerge
        option={{
          grid: { top: 26, left: 44, right: 8, bottom: 22 },
          tooltip: {
            trigger: 'axis',
            backgroundColor: CHART_COLORS.bg,
            borderColor: CHART_COLORS.grid,
            textStyle: { color: CHART_COLORS.text, fontSize: 12 },
            valueFormatter: (v: any) => (v == null ? '—' : `${deNumber(v, 1)} %`),
          },
          legend: { textStyle: { color: CHART_COLORS.text, fontSize: 11 }, top: 0, left: 0, itemWidth: 12, itemHeight: 8 },
          xAxis: {
            type: 'category', data: labels,
            axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          yAxis: {
            type: 'value',
            min: (v: { min: number }) => Math.max(Math.floor(v.min / 10) * 10, AXIS_FLOOR),
            axisLabel: { color: CHART_COLORS.ink, fontSize: 10, formatter: (v: number) => `${deNumber(v, 0)} %` },
            splitLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          series: [
            line('Operative Marge', CHART_COLORS.blue, years.map((y) => y.operatingMargin), op.now, op.median),
            ...(net ? [line('Nettomarge', CHART_COLORS.amber, years.map((y) => y.netMargin), net.now)] : []),
          ],
          textStyle: baseTextStyle,
        }}
      />
    </div>
  );
}
