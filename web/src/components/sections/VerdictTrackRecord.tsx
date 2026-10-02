import { api } from '../../api';
import { useMoney } from '../../currency';
import { recommendationColor } from '../../format';
import { pct } from '../evaluationParts';
import { useArchive } from '../useArchive';
import {
  RECORD_HORIZONS, callHit, type CallOutcome, type Leg,
} from '../../../../src/analysis/verdict-record';

/**
 * How our own verdicts on this stock have done: every call with the stock
 * against the index one, three, six and twelve months on, and for as long as
 * it held. The analysts' record beside it asks the same of their targets.
 */
export default function VerdictTrackRecord({ symbol }: { symbol: string }) {
  const { data, error } = useArchive(() => api.getVerdictRecord(symbol), [symbol]);
  if (error) return <p className="text-xs text-red-400">Nicht verfügbar: {error}</p>;
  if (data === undefined) return <p className="text-xs text-ink-500">Lade Urteils-Historie …</p>;
  if (data === null) {
    return <p className="text-xs text-ink-500">Für diesen Wert sind noch keine Urteile mit archivierten Kursen gespeichert.</p>;
  }
  const now = data.calls[0];
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-ink-300">
        {data.calls.length === 1 ? 'Ein Urteil' : `${data.calls.length} Urteile`} seit {fmtDay(data.calls[data.calls.length - 1].day)}.
        {' '}Aktuell <strong className="text-ink-100">{now.verdict}</strong> seit {fmtDay(now.day)}
        {now.held && (
          <>
            {' '}— seither Aktie {pct(now.held.stock)}
            {now.held.index !== null && <>, S&amp;P 500 {pct(now.held.index)}, also <Excess verdict={now.verdict} leg={now.held} /></>}
          </>
        )}
        .
      </p>
      <CallTable calls={data.calls} />
      <p className="text-[10px] leading-relaxed text-ink-500">
        Ein Urteilswechsel zählt, sobald er die nächste Aktualisierung gehalten hat. Gemessen mit Dividenden gegen den S&amp;P 500
        (SPY){data.currency && data.restated && <>, die Aktie von {data.currency} in Dollar umgerechnet</>}. Ein Kaufurteil war richtig,
        wenn die Aktie den Index schlug, ein Verkaufsurteil, wenn sie ihm hinterherlief; Halten wird nur gemessen.
        {data.currency && !data.restated && (
          <> Der Wechselkurs {data.currency}/USD ist noch nicht archiviert — bis dahin steht die Rendite in {data.currency} ohne Indexvergleich.</>
        )}
      </p>
    </div>
  );
}

const fmtDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;

/** The excess return, green where the call was right and red where it was wrong. */
function Excess({ verdict, leg }: { verdict: string; leg: Leg | null | undefined }) {
  if (!leg) return <span className="text-ink-600">läuft</span>;
  if (leg.excess === null) return <span className="text-ink-400" title="Ohne Indexvergleich">{pct(leg.stock)}</span>;
  const hit = callHit(verdict, leg);
  const cls = hit === null ? 'text-ink-300' : hit ? 'text-emerald-400' : 'text-red-400';
  return (
    <span className={`font-mono ${cls}`} title={`Aktie ${pct(leg.stock)} · S&P 500 ${pct(leg.index)}`}>
      {pct(leg.excess)}
    </span>
  );
}

function CallTable({ calls }: { calls: CallOutcome[] }) {
  const { fmtPrice } = useMoney();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs tabular">
        <thead>
          <tr className="border-b border-ink-700 text-[10px] uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal">Seit</th>
            <th className="py-1 pr-2 text-left font-normal">Urteil</th>
            <th className="py-1 text-right font-normal">Score</th>
            <th className="py-1 text-right font-normal">Kurs</th>
            {RECORD_HORIZONS.map((h) => (
              <th key={h} className="py-1 text-right font-normal" title="Mehrrendite gegenüber dem S&P 500">{h} M</th>
            ))}
            <th className="py-1 text-right font-normal" title="Vom Urteil bis zum nächsten — oder bis heute">Solange es galt</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.day} className="border-b border-ink-800">
              <td className="py-1 pr-2 font-mono text-ink-400">{fmtDay(c.day)}</td>
              <td className="py-1 pr-2">
                {c.from && <span className="mr-1 text-[10px] text-ink-500">{c.from} →</span>}
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${recommendationColor(c.verdict)}`}>{c.verdict}</span>
              </td>
              <td className="py-1 text-right font-mono text-ink-400">{c.score?.toFixed(1) ?? '—'}</td>
              <td className="py-1 text-right font-mono text-ink-400">{fmtPrice(c.price)}</td>
              {RECORD_HORIZONS.map((h) => (
                <td key={h} className="py-1 text-right"><Excess verdict={c.verdict} leg={c.horizons[h]} /></td>
              ))}
              <td className="py-1 text-right">
                <Excess verdict={c.verdict} leg={c.held} />
                {!c.until && <span className="ml-1 text-[10px] text-ink-500">(aktuell)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
