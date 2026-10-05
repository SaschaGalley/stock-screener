import { useEffect, useState } from 'react';
import { api } from '../api';
import { CloseIcon } from '../components/icons';
import { fmtSignedPct } from '../format';
import { decisionRight, MIN_COMPARE, type ModelStance, type ReviewedDecision } from '../../../src/analysis/review';
import { RECORD_HORIZONS } from '../../../src/analysis/verdict-record';
import type { ReviewResponse } from '../../../src/review-service';

const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
const SIDE_LABEL = { buy: 'Kauf', sell: 'Verkauf' } as const;
const SIDE_BADGE = {
  buy:  'border-emerald-800 bg-emerald-950 text-emerald-400',
  sell: 'border-red-800 bg-red-950 text-red-400',
} as const;
const STANCE_LABEL: Record<ModelStance, string> = {
  with: 'mit dem Modell', against: 'gegen das Modell', neutral: 'Modell neutral', none: '',
};

type Filter = 'all' | 'buy' | 'sell' | 'impulse' | 'unexplained';
const FILTERS: { key: Filter; label: string; test: (d: ReviewedDecision) => boolean }[] = [
  { key: 'all',         label: 'Alle',             test: () => true },
  { key: 'buy',         label: 'Käufe',            test: (d) => d.side === 'buy' },
  { key: 'sell',        label: 'Verkäufe',         test: (d) => d.side === 'sell' },
  { key: 'impulse',     label: 'nach Lauf/Sprung', test: (d) => d.situation?.impulse === true },
  { key: 'unexplained', label: 'ohne Begründung',  test: (d) => d.reason === null },
];

/**
 * My purchases and sales looked back on: each against the S&P 500 one to
 * twelve months on, beside the situation it was made in and the reason given
 * for it, and the groups compared — after a jump or not, with the model or
 * against it, with a reason or without. See `analysis/review.ts`.
 */
export default function ReviewPage({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api.getReview().then(setData).catch((e) => setError((e as Error).message));
  }, []);

  const shown = data ? data.decisions.filter(FILTERS.find((f) => f.key === filter)!.test) : [];
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-ink-100">Rückblick</h2>
          <span className="text-xs text-ink-500">Meine Käufe und Verkäufe gegen den S&amp;P 500</span>
          <button
            onClick={onClose}
            title="Schließen (Esc)"
            className="ml-auto rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
          >
            <CloseIcon />
          </button>
        </div>

        {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
        {!data && !error && <p className="p-8 text-center text-sm text-ink-500">Rechne nach …</p>}
        {data?.syncError && <p className="text-xs text-amber-300">⚠ {data.syncError}</p>}
        {data && data.decisions.length === 0 && (
          <p className="text-sm text-ink-500">
            Noch keine Käufe oder Verkäufe — weder im <a href="#/journal" className="text-accent hover:underline">Journal</a> noch aus umsatz.
          </p>
        )}

        {data && data.decisions.length > 0 && (
          <>
            <section className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-300">Was sich zeigt</h3>
              <ul className="space-y-0.5 text-sm text-ink-200">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              <p className="mt-2 text-2xs text-ink-500">
                Gemessen wie unsere Urteile: Aktie gegen den S&amp;P 500 (SPY, mit Dividenden), in Dollar, vom Tag der
                Entscheidung an. Ein Kauf lag richtig, wenn die Aktie danach vorn lag, ein Verkauf, wenn sie zurückblieb.
                Auf ein paar Dutzend Entscheidungen sind das Hinweise, keine Befunde.
                {data.unmeasured > 0 && ` ${data.unmeasured} Entscheidungen betreffen Werte ohne gespeicherte Kurse und sind nicht gemessen.`}
              </p>
            </section>

            <section className="overflow-x-auto rounded-lg border border-ink-800">
              <table className="w-full min-w-[40rem] text-xs">
                <thead className="bg-ink-900 text-2xs uppercase tracking-wider text-ink-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Gruppe</th>
                    {RECORD_HORIZONS.map((h) => <th key={h} className="px-2 py-2 text-right">{h} M</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800">
                  {data.rows.filter((r) => RECORD_HORIZONS.some((h) => r.cells[h].n > 0)).map((r) => (
                    <tr key={r.label}>
                      <td className="px-3 py-1.5 text-ink-300">{r.label}</td>
                      {RECORD_HORIZONS.map((h) => {
                        const c = r.cells[h];
                        const thin = c.n < MIN_COMPARE;
                        return (
                          <td key={h} className={`px-2 py-1.5 text-right font-mono ${thin ? 'text-ink-600' : ''}`}
                            title={c.n ? `${c.n} Entscheidungen; ${Math.round((c.right ?? 0) * 100)} % lagen richtig` : undefined}>
                            {c.median === null ? '—' : (
                              <>
                                <span className={thin ? '' : decisionRight(r.side, c.median) ? 'text-emerald-400' : 'text-red-400'}>{fmtSignedPct(c.median)}</span>
                                <span className="text-ink-600"> ({c.n})</span>
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-1.5 text-2xs text-ink-600">
                Median gegenüber dem S&amp;P 500, in Klammern die Zahl der Entscheidungen; grau unter {MIN_COMPARE}. Grün, wo die
                Gruppe im Median richtig lag — bei Verkäufen heißt das: die Aktie blieb danach zurück.
              </p>
            </section>

            <section className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`rounded-full border px-2 py-0.5 text-xs transition ${
                      filter === f.key ? 'border-ink-600 bg-ink-700 text-ink-50' : 'border-ink-800 text-ink-400 hover:text-ink-200'
                    }`}
                  >
                    {f.label} <span className="font-mono text-ink-500">{data.decisions.filter(f.test).length}</span>
                  </button>
                ))}
              </div>
              <ul className="space-y-2">
                {shown.map((d) => <DecisionCard key={d.key} d={d} />)}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function DecisionCard({ d }: { d: ReviewedDecision }) {
  const s = d.situation;
  return (
    <li className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-ink-400">{fmtDay(d.day)}</span>
        <span className={`rounded border px-1.5 py-px text-2xs font-medium ${SIDE_BADGE[d.side]}`}>{SIDE_LABEL[d.side]}</span>
        {d.symbol
          ? <a href={`#/stock/${encodeURIComponent(d.symbol)}`} className="font-mono text-ink-100 hover:text-accent">{d.symbol}</a>
          : <span className="text-ink-300">{d.name}</span>}
        {s?.verdict && <span className="text-2xs text-ink-500">Modell {s.verdict}{s.stance !== 'none' && ` · ${STANCE_LABEL[s.stance]}`}</span>}
        <span className="ml-auto flex flex-wrap gap-2 font-mono">
          {RECORD_HORIZONS.map((h) => {
            const leg = d.outcome?.horizons[h];
            const due = d.outcome?.due[h];
            if (leg?.excess != null) {
              return (
                <span key={h} className={decisionRight(d.side, leg.excess) ? 'text-emerald-400' : 'text-red-400'}
                  title={`${h} ${h === 1 ? 'Monat' : 'Monate'}: Aktie ${fmtSignedPct(leg.stock)}, S&P 500 ${leg.index !== null ? fmtSignedPct(leg.index) : '—'}`}>
                  <span className="text-ink-600">{h}M </span>{fmtSignedPct(leg.excess)}
                </span>
              );
            }
            return due ? <span key={h} className="text-ink-700" title={`gemessen ab ${fmtDay(due)}`}>{h}M ·</span> : null;
          })}
          {d.outcome?.since?.excess != null && (
            <span className="text-ink-400" title="Von der Entscheidung bis heute, gegen den S&P 500">bisher {fmtSignedPct(d.outcome.since.excess)}</span>
          )}
          {!d.outcome && <span className="text-ink-600">nicht messbar</span>}
        </span>
      </div>
      <div className="mt-1 text-ink-300">
        {d.reason
          ? <a href="#/journal" className="hover:text-ink-100">{d.reason}</a>
          : <span className="text-amber-300/80">ohne Begründung — <a href="#/journal" className="underline">im Journal nachtragen</a></span>}
      </div>
      {s && s.flags.length > 0 && (
        <ul className="mt-1 text-2xs text-amber-300">{s.flags.map((f) => <li key={f}>⚠ {f}</li>)}</ul>
      )}
    </li>
  );
}
