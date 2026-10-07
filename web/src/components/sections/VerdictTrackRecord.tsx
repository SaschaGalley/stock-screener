import { useMoney } from '../../currency';
import { deNumber, recommendationColor, recommendationTone } from '../../format';
import { pct } from '../evaluationParts';
import { useSectionFinding } from '../Section';
import {
  RECORD_HORIZONS, callHit, type Leg, type LegStats,
} from '../../../../src/analysis/verdict-record';
import Term from '../Term';
import Tip from '../Tip';
import More from '../More';
import { AnswerCard } from '../chart/shared';
import ScoreHistoryChart from '../charts/ScoreHistoryChart';
import type { FairAtCall, VerdictRecordView } from '../../../../src/stock-history-service';

/** Where the verdict card's line jumps to. */
export const VERDICT_RECORD_ID = 'verdict-record';

/** The record as `useArchive` hands it over: undefined while loading, null when nothing is archived. */
export interface RecordState { data: VerdictRecordView | null | undefined; error: string | null }

/** Below this many calls a hit rate is not coloured: one right call is no record. */
const FEW = 3;

/** How many of a stretch's calls on direction were right. */
const right = (s: LegStats) => Math.round((s.hitRate ?? 0) * s.n);

/** "2 von 3 Kauf- und Verkaufsurteilen lagen bisher richtig." */
function hitsSentence(s: LegStats): string {
  if (s.n === 0) return 'Bisher ist kein Kauf- oder Verkaufsurteil gegen den Index messbar.';
  if (s.n === 1) return `Das bisher einzige Kauf- oder Verkaufsurteil lag ${right(s) ? 'richtig' : 'daneben'}.`;
  if (right(s) === 0) return `Von den ${s.n} Kauf- und Verkaufsurteilen lag bisher keins richtig.`;
  return `Von ${s.n} Kauf- und Verkaufsurteilen lagen bisher ${right(s)} richtig.`;
}

/**
 * Under the verdict: how its calls have done so far, and the way down to the
 * record. It used to be found only under the analysts' tab, beside theirs.
 */
export function VerdictRecordLine({ data }: { data: VerdictRecordView | null | undefined }) {
  if (!data) return null;
  return (
    <p className="pt-2 text-xs leading-relaxed text-ink-400">
      {hitsSentence(data.record.directional.held)}{' '}
      <button
        onClick={() => document.getElementById(VERDICT_RECORD_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        className="whitespace-nowrap text-ink-300 underline decoration-dotted underline-offset-2 hover:text-ink-100"
      >
        Verlauf und Trefferquote ↓
      </button>
    </p>
  );
}

/**
 * How our own verdicts on this stock have done: whether the one standing is
 * right so far, how often the calls before it were, the score over time, and
 * every call with the stock against the index one, three, six and twelve
 * months on, and for as long as it held. It sits on the overview under the
 * verdict's calculation; the analysts' record asks the same of their targets.
 */
export default function VerdictTrackRecord({ record: { data, error }, scoreHistory }: {
  record: RecordState;
  /** The score's readings, for the chart on its bands. */
  scoreHistory?: { at: string; score: number }[];
}) {
  const current = data?.calls[0];
  const directional = data?.record.directional.held;
  useSectionFinding(current && directional
    ? [
      directional.n > 1 ? `${right(directional)} von ${directional.n} Kauf- und Verkaufsurteilen richtig` : null,
      `aktuell ${current.verdict} seit ${fmtDay(current.day)}${current.held?.excess != null
        ? `, seither ${signedDe(current.held.excess)} gegen den S&P 500` : ''}`,
    ].filter(Boolean).join(' · ')
    : null);
  if (error) return <p className="text-xs text-red-400">Nicht verfügbar: {error}</p>;
  if (data === undefined) return <p className="text-xs text-ink-500">Lade Urteils-Historie …</p>;
  if (data === null) {
    return <p className="text-xs text-ink-500">Für diesen Wert sind noch keine Urteile mit archivierten Kursen gespeichert.</p>;
  }
  const now = data.calls[0];
  const first = data.calls[data.calls.length - 1];
  const d = data.record.directional;
  // The longest horizon any call on direction has reached.
  const longest = [...RECORD_HORIZONS].reverse().find((h) => d[h].n > 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <CurrentCall call={now} />
        <AnswerCard
          question="Wie oft lag es richtig?"
          answer={d.held.n === 0 ? 'Noch nicht messbar' : `${right(d.held)} von ${d.held.n}`}
          tone={d.held.n < FEW || d.held.hitRate === null ? 'neutral'
            : d.held.hitRate >= 0.6 ? 'bull' : d.held.hitRate <= 0.4 ? 'bear' : 'neutral'}
          why={[
            d.held.n > 0
              ? 'Kauf- und Verkaufsurteile, solange sie galten; das laufende mit dem Stand von heute'
              : 'Halten gibt keine Richtung vor, und ohne Indexkurse lässt sich nichts messen',
            ...(d.held.n > 0 && d.held.n < FEW ? ['noch zu wenige, um viel daraus zu lesen'] : []),
            ...(longest ? [`${longest === 1 ? 'einen Monat' : `${longest} Monate`} nach dem Urteil: ${right(d[longest])} von ${d[longest].n} richtig`] : []),
            `${data.calls.length === 1 ? 'ein Urteil' : `${data.calls.length} Urteile`} seit ${fmtDay(first.day)}`,
          ]}
        />
      </div>
      {scoreHistory && scoreHistory.length > 1 && <ScoreHistoryChart points={scoreHistory} />}
      <CallList calls={data.calls} latest={data.latest} />
      <More label="wie gemessen wird">
        <p className="text-xs leading-relaxed text-ink-400">
          Ein Urteilswechsel zählt, sobald er die nächste Aktualisierung gehalten hat. Gemessen mit Dividenden gegen den S&amp;P 500
          (SPY){data.currency && data.restated && <>, die Aktie von {data.currency} in Dollar umgerechnet</>}. Ein Kaufurteil war richtig,
          wenn die Aktie den Index schlug, ein Verkaufsurteil, wenn sie ihm hinterherlief; Halten wird nur gemessen. Der faire Wert ist
          der, den die Seite an dem Tag zeigte — der Median der primären Modelle, die Spanne beim Überfahren —, und „Weg zum Wert“,
          welchen Teil des Abstands zwischen dem damaligen Kurs und diesem Wert der Kurs seither zurückgelegt hat; negativ, wenn er sich
          entfernt hat.
          {data.currency && !data.restated && (
            <> Der Wechselkurs {data.currency}/USD ist noch nicht archiviert — bis dahin steht die Rendite in {data.currency} ohne Indexvergleich.</>
          )}
        </p>
      </More>
    </div>
  );
}

/** Whether the verdict standing now has been right so far. */
function CurrentCall({ call }: { call: VerdictRecordView['calls'][number] }) {
  const held = call.held;
  const hit = callHit(call.verdict, held);
  const hold = recommendationTone(call.verdict) === 'neutral';
  const answer = !held ? 'Gerade erst gefällt'
    : held.excess === null ? `Aktie ${signedDe(held.stock)}`
    : hold ? (held.excess >= 0 ? 'Vor dem Index' : 'Hinter dem Index')
    : hit ? 'Bisher richtig' : 'Bisher daneben';
  return (
    <AnswerCard
      question="Wie läuft das aktuelle Urteil?"
      answer={answer}
      tone={hit === null ? 'neutral' : hit ? 'bull' : 'bear'}
      why={[
        `${call.verdict} seit ${fmtDay(call.day)}${call.from ? `, vorher ${call.from}` : ''}`,
        ...(held ? [held.index !== null
          ? `Aktie ${signedDe(held.stock)}, S&P 500 ${signedDe(held.index)}${held.excess !== null ? `: ${signedDe(held.excess)} gegen den Index` : ''}`
          : `ohne Indexvergleich`] : []),
        ...(hold ? ['Halten gibt keine Richtung vor und wird nur gemessen'] : []),
      ]}
    />
  );
}

/** "+9,5 %" — the header's line is prose, and prose takes the comma. */
const signedDe = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
const fmtDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;

/** The excess return, green where the call was right and red where it was wrong. */
function Excess({ verdict, leg }: { verdict: string; leg: Leg | null | undefined }) {
  if (!leg) return <span className="text-ink-500">läuft</span>;
  if (leg.excess === null) return <Tip focusable={false} content="Ohne Indexvergleich"><span className="font-mono text-ink-400">{pct(leg.stock)}</span></Tip>;
  const hit = callHit(verdict, leg);
  const cls = hit === null ? 'text-ink-300' : hit ? 'text-emerald-400' : 'text-red-400';
  return (
    <Tip focusable={false} content={`Aktie ${pct(leg.stock)}, S&P 500 ${pct(leg.index)}${hit === null ? '' : hit ? ' — das Urteil lag richtig' : ' — das Urteil lag falsch'}`}>
      <span className={`font-mono ${cls}`}>{pct(leg.excess)}</span>
    </Tip>
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
    <Tip focusable={false} content={`Kurs damals ${deNumber(price, 2)}, fairer Wert ${deNumber(fair.value, 2)}, zuletzt ${deNumber(latest.price, 2)} (${fmtDay(latest.day)})`}>
      <span className={`font-mono ${cls}`}>{`${share >= 0 ? '' : '−'}${Math.abs(Math.round(share * 100))} %`}</span>
    </Tip>
  );
}

/**
 * Every call, newest first: when, what, and how the stock did against the
 * index after it. A list rather than a table of eleven columns, which needed
 * 760 pixels and scrolled sideways beside the stock list.
 */
function CallList({ calls, latest }: { calls: VerdictRecordView['calls']; latest: VerdictRecordView['latest'] }) {
  const { fmtPrice } = useMoney();
  return (
    <div>
      <p className="mb-1 text-xs text-ink-500">
        Jedes Urteil und was die Aktie danach <Term k="concept.vr.excess">gegen den S&amp;P 500</Term> machte — grün, wo es richtig lag.
      </p>
      <ol className="divide-y divide-ink-800 border-y border-ink-800">
        {calls.map((c) => (
          <li key={c.day} className="space-y-1 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-sm text-ink-300">{fmtDay(c.day)}</span>
                {c.from && <span className="text-2xs text-ink-500">{c.from} →</span>}
                <span className={`rounded px-1.5 py-0.5 text-2xs font-bold ${recommendationColor(c.verdict)}`}>{c.verdict}</span>
                {c.score != null && <span className="text-xs text-ink-500">Score {deNumber(c.score, 1)}</span>}
              </div>
              <div className="whitespace-nowrap text-sm">
                <Term k="concept.vr.held"><span className="text-xs text-ink-400">{c.until ? `bis ${fmtDay(c.until)}` : 'bis heute'}</span></Term>{' '}
                <Excess verdict={c.verdict} leg={c.held} />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
              {RECORD_HORIZONS.map((h) => (
                <span key={h} className="whitespace-nowrap">
                  <span className="text-ink-500">nach {h} M</span> <Excess verdict={c.verdict} leg={c.horizons[h]} />
                </span>
              ))}
            </div>
            <div className="text-xs text-ink-500">
              Kurs damals <span className="font-mono text-ink-400">{fmtPrice(c.price)}</span>
              {c.fair && (
                <>
                  {' · '}
                  <Tip focusable={false} content={c.fair.low !== null && c.fair.high !== null ? `Spanne der Modelle ${fmtPrice(c.fair.low)} – ${fmtPrice(c.fair.high)}` : 'Median der primären Modelle'}>
                    fairer Wert <span className="font-mono text-ink-400">{fmtPrice(c.fair.value)}</span>{' '}
                    <span className={c.fair.value >= c.price ? 'text-emerald-400' : 'text-red-400'}>{pct(c.fair.value / c.price - 1)}</span>
                  </Tip>
                  {' · '}
                  <Tip focusable={false} content="Welchen Teil des Abstands zum damaligen fairen Wert der Kurs seither zurückgelegt hat">Weg zum Wert</Tip>{' '}
                  <GapClosed price={c.price} fair={c.fair} latest={latest} />
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
