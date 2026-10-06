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

function Summary({ r }: { r: TrackRecordView }) {
  const o = r.overall;
  const err = o.medianError ?? 0;
  const first = r.consensus[0]?.day.slice(0, 4);
  return (
    <p className="text-xs leading-relaxed text-ink-300">
      {o.n} Kursziele mit abgeschlossenem Jahr{first ? ` seit ${first}` : ''}: Der Kurs lag ein Jahr später im Median{' '}
      <strong className="text-ink-100">{fmtSignedPct(err, 0)}</strong> {err >= 0 ? 'über' : 'unter'} dem Ziel —{' '}
      {Math.abs(err) < 0.05
        ? 'die Ziele lagen im Mittel nah an der Wirklichkeit.'
        : err > 0
          ? 'die Analysten waren hier zu vorsichtig.'
          : 'die Analysten waren hier zu optimistisch.'}{' '}
      {o.reachedRate !== null && <>Erreicht wurden <strong className="text-ink-100">{Math.round(o.reachedRate * 100)} %</strong> der Ziele, </>}
      {o.directionRate !== null && <>die Richtung stimmte in <strong className="text-ink-100">{Math.round(o.directionRate * 100)} %</strong> der Fälle.</>}
      {r.pending > 0 && <span className="text-ink-500"> {r.pending} Ziele laufen noch.</span>}
    </p>
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
      <h3 className="mb-2 text-xs font-semibold text-ink-300">Die Häuser einzeln</h3>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal">Haus</th>
            <th className="py-1 text-right font-normal"><Term k="concept.ar.targets">Ziele</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.ar.medianError">Kurs vs. Ziel</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.ar.reached">Erreicht</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.ar.direction">Richtung</Term></th>
            <th className="hidden py-1 text-right font-normal sm:table-cell">Zuletzt</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((f) => (
            <tr key={f.firm} className="border-b border-ink-800">
              <td className="py-1 pr-2 text-ink-300">{f.firm}</td>
              <td className="py-1 text-right font-mono text-ink-400">{f.n}</td>
              <td className={`py-1 text-right font-mono ${f.medianError === null ? 'text-ink-500' : Math.abs(f.medianError) < 0.1 ? 'text-emerald-400' : Math.abs(f.medianError) < 0.25 ? 'text-ink-300' : 'text-amber-400'}`}>
                {f.medianError === null ? '—' : fmtSignedPct(f.medianError, 0)}
              </td>
              <td className="py-1 text-right font-mono text-ink-300">{pct(f.reachedRate)}</td>
              <td className={`py-1 text-right font-mono ${f.directionRate === null ? 'text-ink-500' : f.directionRate >= 0.7 ? 'text-emerald-400' : f.directionRate < 0.5 ? 'text-red-400' : 'text-ink-300'}`}>
                {pct(f.directionRate)}
              </td>
              <td className="hidden py-1 text-right text-ink-400 sm:table-cell">
                {f.last.grade ?? '—'}{f.last.target !== null ? ` · ${fmtPrice(f.last.target)}` : ''} · {f.last.day.slice(0, 7)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
      {rest > 0 && (
        <button onClick={() => setAll((x) => !x)} className="mt-1 block text-xs text-ink-400 hover:text-ink-100">
          {all ? 'Nur Häuser mit mindestens fünf Zielen' : `+ ${rest} Häuser mit weniger als fünf abgeschlossenen Zielen`}
        </button>
      )}
    </div>
  );
}
