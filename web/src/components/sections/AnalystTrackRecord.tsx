import { useState } from 'react';
import ReactECharts from '../charts/ECharts';
import { api } from '../../api';
import { useMoney } from '../../currency';
import { fmtSignedPct } from '../../format';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import { useArchive } from '../useArchive';
import { MIN_FIRM_TARGETS, type FirmRecord } from '../../../../src/analysis/analyst-accuracy';
import type { TrackRecordView } from '../../../../src/stock-history-service';
import Term from '../Term';
import { useFirst } from '../More';
import { useSectionFinding } from '../Section';
import { AnswerCard } from '../chart/shared';

/**
 * How good the analysts' targets for this stock have been: every target with
 * a finished year against where the price stood a year later, per firm and
 * for the consensus. The analyst card shows the mean target every day; this
 * says how much it has been worth.
 */
export default function AnalystTrackRecord({ symbol }: { symbol: string }) {
  const { data, error } = useArchive(() => api.getAnalystRecord(symbol), [symbol]);
  const o = data?.overall;
  useSectionFinding(o && o.n > 0 ? [
    `${o.n} Kursziele mit abgeschlossenem Jahr`,
    o.directionRate !== null && `Richtung in ${Math.round(o.directionRate * 100)} % richtig`,
    o.reachedRate !== null && `${Math.round(o.reachedRate * 100)} % erreicht`,
  ].filter(Boolean).join(' · ') : null);
  if (error) return <p className="text-xs text-red-400">Nicht verfügbar: {error}</p>;
  if (data === undefined) return <p className="text-xs text-ink-500">Lade Analysten-Historie …</p>;
  if (data === null || data.overall.n === 0) {
    return (
      <p className="text-xs text-ink-500">
        {data ? `${data.targets} Kursziele archiviert, aber noch keines mit abgeschlossenem Jahr.` : 'Für diesen Wert sind keine Analysten-Aktionen archiviert.'}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <Summary r={data} />
      <ConsensusChart r={data} />
      <FirmTable firms={data.firms} />
      <p className="text-xs leading-relaxed text-ink-500">
        Jedes Kursziel aus Yahoos Analysten-Historie gegen den Schlusskurs zwölf Monate später; Ziele aus der Zeit
        vor einem Aktiensplit auf die heutige Basis umgerechnet. „Erreicht“: Der Kurs hat das Ziel innerhalb des
        Jahres an einem Schlusskurs berührt. „Richtung“: Der Kurs bewegte sich, wie das Ziel es nahelegte. Die
        Konsenslinie ist der Mittelwert des jeweils neuesten Ziels jedes Hauses aus den zwölf Monaten davor.
      </p>
    </div>
  );
}

/** Three answers: were the targets too high or too low, how often were they reached, did the direction hold. */
function Summary({ r }: { r: TrackRecordView }) {
  const o = r.overall;
  const err = o.medianError ?? 0;
  const first = r.consensus[0]?.day.slice(0, 4);
  const rate = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3">
        <AnswerCard
          question="Lagen die Ziele zu hoch oder zu tief?"
          answer={Math.abs(err) < 0.05 ? 'Ziemlich genau' : err > 0 ? 'Zu vorsichtig' : 'Zu optimistisch'}
          tone={Math.abs(err) < 0.05 ? 'bull' : err > 0 ? 'neutral' : 'bear'}
          why={[`ein Jahr später stand der Kurs im Median ${fmtSignedPct(err, 0)} ${err >= 0 ? 'über' : 'unter'} dem Ziel`]}
        />
        <AnswerCard
          question="Wie oft wurde das Ziel erreicht?"
          answer={rate(o.reachedRate)}
          tone={o.reachedRate === null ? 'neutral' : o.reachedRate >= 0.6 ? 'bull' : o.reachedRate < 0.4 ? 'bear' : 'neutral'}
          why={['der Kurs berührte das Ziel binnen eines Jahres an einem Schlusskurs']}
        />
        <AnswerCard
          question="Stimmte wenigstens die Richtung?"
          answer={rate(o.directionRate)}
          tone={o.directionRate === null ? 'neutral' : o.directionRate >= 0.65 ? 'bull' : o.directionRate < 0.5 ? 'bear' : 'neutral'}
          why={['der Kurs ging dorthin, wohin das Ziel zeigte']}
        />
      </div>
      <p className="mt-2 text-sm text-ink-400">
        {o.n} Kursziele mit abgeschlossenem Jahr{first ? ` seit ${first}` : ''}{r.pending > 0 ? `; ${r.pending} laufen noch` : ''}.
      </p>
    </div>
  );
}

function ConsensusChart({ r }: { r: TrackRecordView }) {
  const { fmtPrice } = useMoney();
  const [years, setYears] = useState<5 | 0>(5);
  const pts = years ? r.consensus.slice(-years * 12) : r.consensus;
  if (pts.length < 6) return null;
  const label = (d: string) => `${d.slice(5, 7)}/${d.slice(2, 4)}`;
  const line = (name: string, data: (number | null)[], color: string, dashed = false) => ({
    name, type: 'line', data, showSymbol: false, connectNulls: false,
    itemStyle: { color }, lineStyle: { color, width: dashed ? 1.5 : 2, type: dashed ? 'dashed' : 'solid' },
  });
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-ink-500">Kurs gegen das Kursziel, das ein Jahr vorher für diesen Tag galt</span>
        <div className="flex gap-1">
          {([5, 0] as const).map((y) => (
            <button
              key={y}
              onClick={() => setYears(y)}
              className={`rounded px-2 py-0.5 text-xs ${years === y ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:bg-ink-800'}`}
            >
              {y ? '5 Jahre' : 'Alles'}
            </button>
          ))}
        </div>
      </div>
      <div style={{ height: 260 }}>
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          notMerge
          option={{
            grid: { top: 30, left: 56, right: 20, bottom: 26 },
            tooltip: {
              trigger: 'axis', backgroundColor: CHART_COLORS.bg, borderColor: CHART_COLORS.grid,
              textStyle: { color: CHART_COLORS.text, fontSize: 13 },
              valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtPrice(v) : '—'),
            },
            legend: { textStyle: { color: CHART_COLORS.text, fontSize: 12 }, top: 0, right: 8 },
            xAxis: { type: 'category', data: pts.map((p) => label(p.day)), axisLabel: { color: CHART_COLORS.ink, fontSize: 11 }, axisLine: { lineStyle: { color: CHART_COLORS.grid } } },
            yAxis: { type: 'value', scale: true, axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (v: number) => fmtPrice(v) }, splitLine: { lineStyle: { color: CHART_COLORS.grid } } },
            series: [
              line('Kurs', pts.map((p) => p.price), CHART_COLORS.text),
              line('Versprochen (Ziel von vor 12 M)', pts.map((p) => p.promised), CHART_COLORS.amber),
              line('Konsensziel heute', pts.map((p) => p.target), CHART_COLORS.blue, true),
            ],
            textStyle: baseTextStyle,
          }}
        />
      </div>
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monthDe = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;

/**
 * The firms one by one, the best at calling the direction first: how often
 * each was right, a bar to see it; how often its targets were reached; where
 * the price stood a year after its targets; and what it says now.
 */
function FirmTable({ firms }: { firms: FirmRecord[] }) {
  const { fmtPrice } = useMoney();
  const [all, setAll] = useState(false);
  const ranked = firms.filter((f) => f.n >= MIN_FIRM_TARGETS);
  const rest = firms.length - ranked.length;
  const [shown, more] = useFirst(all ? firms : ranked, 8, 'Häuser');
  if (shown.length === 0) return null;
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-ink-100">Welches Haus lag wie oft richtig?</h3>
      <p className="mb-2 text-xs text-ink-500">Häuser mit mindestens {MIN_FIRM_TARGETS} abgeschlossenen Zielen, die meisten Ziele zuerst.</p>
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-ink-700 text-xs text-ink-500">
            <th className="py-1 pr-2 text-left font-normal">Haus</th>
            <th className="py-1 px-2 text-right font-normal"><Term k="concept.ar.targets">Ziele</Term></th>
            <th className="py-1 px-2 text-left font-normal"><Term k="concept.ar.direction">Richtung richtig</Term></th>
            <th className="py-1 px-2 text-right font-normal"><Term k="concept.ar.reached">erreicht</Term></th>
            <th className="py-1 px-2 text-right font-normal"><Term k="concept.ar.medianError">Kurs ein Jahr später</Term></th>
            <th className="hidden py-1 pl-2 text-right font-normal md:table-cell">sagt heute</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {shown.map((f) => (
            <tr key={f.firm}>
              <td className="py-1.5 pr-2 text-ink-200">{f.firm}</td>
              <td className="py-1.5 px-2 text-right font-mono text-ink-400">{f.n}</td>
              <td className="py-1.5 px-2">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-800">
                    <div
                      className={f.directionRate === null ? '' : f.directionRate >= 0.7 ? 'h-full bg-emerald-500' : f.directionRate < 0.5 ? 'h-full bg-red-500' : 'h-full bg-ink-400'}
                      style={{ width: `${Math.round((f.directionRate ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-ink-200">{pct(f.directionRate)}</span>
                </div>
              </td>
              <td className="py-1.5 px-2 text-right font-mono text-ink-300">{pct(f.reachedRate)}</td>
              <td className={`whitespace-nowrap py-1.5 px-2 text-right ${f.medianError === null ? 'text-ink-500' : Math.abs(f.medianError) < 0.1 ? 'text-emerald-400' : 'text-ink-300'}`}>
                {f.medianError === null ? '—' : Math.abs(f.medianError) < 0.02 ? 'auf dem Ziel' : `${fmtSignedPct(f.medianError, 0)} ${f.medianError > 0 ? 'darüber' : 'darunter'}`}
              </td>
              <td className="hidden whitespace-nowrap py-1.5 pl-2 text-right text-ink-400 md:table-cell">
                {f.last.grade ?? '—'}{f.last.target !== null ? <> · <span className="font-mono text-ink-200">{fmtPrice(f.last.target)}</span></> : ''} · {monthDe(f.last.day)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
      {rest > 0 && (
        <button onClick={() => setAll((x) => !x)} className="mt-1 block text-xs text-ink-400 hover:text-ink-100">
          {all ? `Nur Häuser mit mindestens ${MIN_FIRM_TARGETS} Zielen` : `+ ${rest} Häuser mit weniger als ${MIN_FIRM_TARGETS} abgeschlossenen Zielen`}
        </button>
      )}
    </div>
  );
}
