import ReactECharts from '../charts/ECharts';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import { AnswerCard } from '../chart/shared';
import Term from '../Term';
import { api } from '../../api';
import { useArchive } from '../useArchive';
import { deNumber, fmtSignedPct } from '../../format';
import { REVISION_MOVED, WINDOWS, type YearRevision } from '../../../../src/analysis/estimate-revisions';
import type { EarningsRevisions } from '../../../../src/types';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const monthYear = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const dayMonth = (d: string) => `${Number(d.slice(8, 10))}. ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
/** A revision with its sign, to a tenth of a percent; what rounds to nothing says so. */
const signed = (x: number) => (Math.abs(x) < 0.0005 ? '±0 %' : fmtSignedPct(x, 1));

/** The longest window the archive covers, or the span it has. */
function headline(y: YearRevision): { change: number; over: string } {
  if (y.d90 !== null) return { change: y.d90, over: `in ${WINDOWS[1]} Tagen` };
  if (y.d30 !== null) return { change: y.d30, over: `in ${WINDOWS[0]} Tagen` };
  return { change: y.sinceChange, over: `seit ${dayMonth(y.since)}` };
}

/**
 * How the revenue consensus for this fiscal year and the next has moved, from
 * our own archive (`analysis/estimate-revisions.ts`), with the earnings-per-
 * share consensus Yahoo reports beside it. Yahoo keeps no history of the
 * revenue estimate; this one is as long as the archive.
 */
export default function EstimateRevisions({ symbol, revisions }: { symbol: string; revisions: EarningsRevisions | null }) {
  const { data } = useArchive(() => api.getEstimateRevisions(symbol), [symbol]);
  if (!data?.length) return null;

  const years = data.map((y) => ({ y, h: headline(y) }));
  const moved = years.filter((x) => Math.abs(x.h.change) >= REVISION_MOVED)
    .sort((a, b) => Math.abs(b.h.change) - Math.abs(a.h.change))[0];
  const lead = moved ?? years[0];
  const which = lead.y.period === '+1y' ? ' für nächstes Jahr' : '';
  const answer = !moved ? `Kaum verändert: ${signed(lead.h.change)} ${lead.h.over}`
    : moved.h.change > 0 ? `Ja: Umsatzschätzung${which} ${signed(moved.h.change)} ${moved.h.over}`
    : `Nein, sie sinken: Umsatzschätzung${which} ${signed(moved.h.change)} ${moved.h.over}`;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">
        <Term k="concept.revenueRevisions">Umsatzschätzungen im Verlauf</Term>
      </h3>
      <div className="grid gap-4 md:grid-cols-2">
        <AnswerCard
          question="Steigen die Umsatzerwartungen?"
          answer={answer}
          tone={!moved ? 'neutral' : moved.h.change > 0 ? 'bull' : 'bear'}
          why={reasons(data, revisions)}
        />
        <Paths years={data} />
      </div>
    </div>
  );
}

function reasons(years: YearRevision[], revisions: EarningsRevisions | null): string[] {
  const out = years.map((y) => {
    const label = y.period === '0y'
      ? `Dieses Geschäftsjahr bis ${monthYear(y.endDate)} (Umsatzwachstum erwartet ${fmtSignedPct(y.growth, 1)})`
      : `Nächstes bis ${monthYear(y.endDate)} (${fmtSignedPct(y.growth, 1)} darauf)`;
    const parts = [
      y.d30 !== null ? `${signed(y.d30)} in ${WINDOWS[0]} Tagen` : null,
      y.d90 !== null ? `${signed(y.d90)} in ${WINDOWS[1]} Tagen` : null,
      `${signed(y.sinceChange)} seit ${dayMonth(y.since)}`,
    ].filter(Boolean);
    return `${label}: ${parts.join(', ')}`;
  });

  // Earnings per share from Yahoo's own trend, which reaches 90 days back from the start.
  const eps = revisions?.perPeriod.find((p) => p.period === '0y')?.epsTrend;
  const epsChange = (then: number | null | undefined) =>
    eps?.current != null && then != null && then !== 0 ? eps.current / then - 1 : null;
  const e30 = epsChange(eps?.ago30d), e90 = epsChange(eps?.ago90d);
  if (e30 !== null || e90 !== null) {
    out.push(`Gewinn je Aktie dieses Jahr zum Vergleich: ${[
      e30 !== null ? `${signed(e30)} in ${WINDOWS[0]} Tagen` : null,
      e90 !== null ? `${signed(e90)} in ${WINDOWS[1]} Tagen` : null,
    ].filter(Boolean).join(', ')}`);
  }
  // Revenue and earnings moving apart is a statement about the margin.
  const rev = years.find((y) => y.period === '0y');
  if (rev?.d30 != null && e30 !== null && Math.abs(rev.d30) >= REVISION_MOVED && Math.abs(e30) >= REVISION_MOVED
    && Math.sign(rev.d30) !== Math.sign(e30)) {
    out.push(`Umsatz und Gewinn laufen auseinander: Die Analysten rechnen mit ${e30 > rev.d30 ? 'breiteren' : 'schmaleren'} Margen`);
  }

  const first = years.reduce((a, y) => (y.since < a ? y.since : a), years[0].since);
  const full = new Date(Date.parse(first) + WINDOWS[1] * 86_400_000).toISOString().slice(0, 10);
  if (years.every((y) => y.d90 === null)) out.push(`Aus unserem Archiv seit ${dayMonth(first)}; ${WINDOWS[1]} Tage reicht es ab ${dayMonth(full)}`);
  return out;
}

/** The consensus of each year as a line, against its first day on file. */
function Paths({ years }: { years: YearRevision[] }) {
  const today = new Date().toISOString();
  const colors = [CHART_COLORS.blue, CHART_COLORS.amber];
  return (
    <div style={{ height: 180 }}>
      <ReactECharts
        style={{ height: '100%', width: '100%' }}
        notMerge
        option={{
          grid: { top: 26, left: 48, right: 8, bottom: 22 },
          tooltip: {
            trigger: 'axis',
            backgroundColor: CHART_COLORS.bg,
            borderColor: CHART_COLORS.grid,
            textStyle: { color: CHART_COLORS.text, fontSize: 12 },
            valueFormatter: (v: any) => (v == null ? '—' : signed(v / 100)),
          },
          legend: { textStyle: { color: CHART_COLORS.text, fontSize: 11 }, top: 0, left: 0, itemWidth: 12, itemHeight: 8 },
          xAxis: {
            type: 'time',
            axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (v: number) => new Date(v).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          yAxis: {
            type: 'value', scale: true,
            axisLabel: { color: CHART_COLORS.ink, fontSize: 10, formatter: (v: number) => `${deNumber(v, 1)} %` },
            splitLine: { lineStyle: { color: CHART_COLORS.grid } },
          },
          series: years.map((y, k) => ({
            name: `bis ${monthYear(y.endDate)}`,
            type: 'line' as const,
            step: 'end' as const,
            symbol: 'circle', symbolSize: 4,
            itemStyle: { color: colors[k % colors.length] },
            lineStyle: { color: colors[k % colors.length], width: 2 },
            // The consensus holds until it changes, so the line runs on to today.
            data: [...y.path, { at: today, index: y.path[y.path.length - 1].index }].map((p) => [p.at, (p.index - 1) * 100]),
          })),
          textStyle: baseTextStyle,
        }}
      />
    </div>
  );
}
