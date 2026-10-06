import { api } from '../../api';
import { useMoney } from '../../currency';
import { deNumber, recommendationColor } from '../../format';
import { pct } from '../evaluationParts';
import { useArchive } from '../useArchive';
import { useSectionFinding } from '../Section';
import {
  RECORD_HORIZONS, callHit, type Leg,
} from '../../../../src/analysis/verdict-record';
import Term from '../Term';
import type { FairAtCall, VerdictRecordView } from '../../../../src/stock-history-service';

/**
 * How our own verdicts on this stock have done: every call with the stock
 * against the index one, three, six and twelve months on, and for as long as
 * it held. The analysts' record beside it asks the same of their targets.
 */
export default function VerdictTrackRecord({ symbol }: { symbol: string }) {
  const { data, error } = useArchive(() => api.getVerdictRecord(symbol), [symbol]);
  const current = data?.calls[0];
  useSectionFinding(current
    ? `Aktuell ${current.verdict} seit ${fmtDay(current.day)}${
      current.held?.excess != null ? `, seither ${signedDe(current.held.excess)} gegen den S&P 500`
        : current.held ? `, seither ${signedDe(current.held.stock)}` : ''}`
    : null);
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
      <CallTable calls={data.calls} latest={data.latest} />
      <p className="text-xs leading-relaxed text-ink-500">
        Ein Urteilswechsel zählt, sobald er die nächste Aktualisierung gehalten hat. Gemessen mit Dividenden gegen den S&amp;P 500
        (SPY){data.currency && data.restated && <>, die Aktie von {data.currency} in Dollar umgerechnet</>}. Ein Kaufurteil war richtig,
        wenn die Aktie den Index schlug, ein Verkaufsurteil, wenn sie ihm hinterherlief; Halten wird nur gemessen. Der faire Wert ist
        der, den die Seite an dem Tag zeigte — der Median der primären Modelle, die Spanne beim Überfahren —, und „Lücke bis heute“,
        welchen Teil des Abstands zwischen dem damaligen Kurs und diesem Wert der Kurs seither zurückgelegt hat; negativ, wenn er sich
        entfernt hat.
        {data.currency && !data.restated && (
          <> Der Wechselkurs {data.currency}/USD ist noch nicht archiviert — bis dahin steht die Rendite in {data.currency} ohne Indexvergleich.</>
        )}
      </p>
    </div>
  );
}

/** "+9,5 %" — the header's line is prose, and prose takes the comma. */
const signedDe = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
const fmtDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;

/** The excess return, green where the call was right and red where it was wrong. */
function Excess({ verdict, leg }: { verdict: string; leg: Leg | null | undefined }) {
  if (!leg) return <span className="text-ink-500">läuft</span>;
  if (leg.excess === null) return <span className="text-ink-400" title="Ohne Indexvergleich">{pct(leg.stock)}</span>;
  const hit = callHit(verdict, leg);
  const cls = hit === null ? 'text-ink-300' : hit ? 'text-emerald-400' : 'text-red-400';
  return (
    <span className={`font-mono ${cls}`} title={`Aktie ${pct(leg.stock)} · S&P 500 ${pct(leg.index)}`}>
      {pct(leg.excess)}
    </span>
  );
}

/** How much of the way from the call's price to its fair value the price has gone since. */
function GapClosed({ price, fair, latest }: { price: number; fair: FairAtCall | null; latest: VerdictRecordView['latest'] }) {
  if (!fair || !latest || !(price > 0)) return <span className="text-ink-600">—</span>;
  const gap = fair.value - price;
  // Within five per cent the price stood at the value: there was no gap to close.
  if (Math.abs(gap) / price < 0.05) return <span className="text-ink-500">am Wert</span>;
  const share = (latest.price - price) / gap;
  const cls = share >= 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <span className={`font-mono ${cls}`} title={`Kurs damals ${deNumber(price, 2)}, fairer Wert ${deNumber(fair.value, 2)}, zuletzt ${deNumber(latest.price, 2)} (${fmtDay(latest.day)})`}>
      {`${share >= 0 ? '' : '−'}${Math.abs(Math.round(share * 100))} %`}
    </span>
  );
}

function CallTable({ calls, latest }: { calls: VerdictRecordView['calls']; latest: VerdictRecordView['latest'] }) {
  const { fmtPrice } = useMoney();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs tabular">
        <thead>
          <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal">Seit</th>
            <th className="py-1 pr-2 text-left font-normal">Urteil</th>
            <th className="py-1 text-right font-normal">Score</th>
            <th className="py-1 text-right font-normal">Kurs</th>
            <th className="py-1 text-right font-normal">Fairer Wert</th>
            <th className="py-1 text-right font-normal" title="Anteil des Abstands zum damaligen fairen Wert, den der Kurs seither zurückgelegt hat">Lücke bis heute</th>
            {RECORD_HORIZONS.map((h) => (
              <th key={h} className="py-1 text-right font-normal"><Term k="concept.vr.excess">{h} M</Term></th>
            ))}
            <th className="py-1 text-right font-normal"><Term k="concept.vr.held">Solange es galt</Term></th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.day} className="border-b border-ink-800">
              <td className="py-1 pr-2 font-mono text-ink-400">{fmtDay(c.day)}</td>
              <td className="py-1 pr-2">
                {c.from && <span className="mr-1 text-2xs text-ink-500">{c.from} →</span>}
                <span className={`rounded px-1.5 py-0.5 text-2xs font-bold ${recommendationColor(c.verdict)}`}>{c.verdict}</span>
              </td>
              <td className="py-1 text-right font-mono text-ink-400">{c.score != null ? deNumber(c.score, 1) : '—'}</td>
              <td className="py-1 text-right font-mono text-ink-400">{fmtPrice(c.price)}</td>
              <td
                className="py-1 text-right font-mono text-ink-400"
                title={c.fair && c.fair.low !== null && c.fair.high !== null ? `Spanne ${fmtPrice(c.fair.low)} – ${fmtPrice(c.fair.high)}` : undefined}
              >
                {c.fair ? (
                  <>
                    {fmtPrice(c.fair.value)}{' '}
                    <span className={c.fair.value >= c.price ? 'text-emerald-400' : 'text-red-400'}>
                      {pct(c.fair.value / c.price - 1)}
                    </span>
                  </>
                ) : '—'}
              </td>
              <td className="py-1 text-right"><GapClosed price={c.price} fair={c.fair} latest={latest} /></td>
              {RECORD_HORIZONS.map((h) => (
                <td key={h} className="py-1 text-right"><Excess verdict={c.verdict} leg={c.horizons[h]} /></td>
              ))}
              <td className="py-1 text-right">
                <Excess verdict={c.verdict} leg={c.held} />
                {!c.until && <span className="ml-1 text-2xs text-ink-500">(aktuell)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
