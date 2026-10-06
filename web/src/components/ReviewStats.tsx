import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtSignedPct } from '../format';
import Tip from './Tip';
import { decisionRight, MIN_COMPARE } from '../../../src/analysis/review';
import { RECORD_HORIZONS } from '../../../src/analysis/verdict-record';
import { REVIEW_CAUSE_LABEL, type ReviewCause } from '../../../src/research/kinds';
import type { ReviewStats as Stats } from '../../../src/review-service';

/**
 * My purchases and sales compared in groups — after a jump or not, with the
 * model or against it, with a reason or without — against the S&P 500 one to
 * twelve months on. It headed the review, above the list of decisions; it is
 * the same question the evaluation asks of the score, asked of me, so it
 * lives here, and the review is the list.
 */
export default function ReviewStats() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getReviewStats().then(setData).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>;
  if (!data) return <p className="p-8 text-center text-sm text-ink-500">Rechne nach …</p>;
  if (data.decisions === 0) {
    return (
      <p className="text-sm text-ink-500">
        Noch keine Käufe oder Verkäufe — weder im <a href="#/journal" className="text-accent hover:underline">Journal</a> noch aus umsatz.
      </p>
    );
  }
  const causes = Object.entries(data.causes) as [ReviewCause, number][];

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
        <h3 className="mb-1.5 text-xs font-semibold text-ink-300">Was sich zeigt</h3>
        <ul className="space-y-1 text-sm text-ink-200">
          {data.notes.map((n) => <li key={n}>{n}</li>)}
          {causes.length > 0 && (
            <li>Rückblick-Checks: {causes.map(([k, n]) => `${REVIEW_CAUSE_LABEL[k]} (${n}×)`).join('; ')}.</li>
          )}
        </ul>
        <p className="mt-2 text-xs text-ink-500">
          Gemessen wie unsere Urteile: Aktie gegen den S&amp;P 500 (SPY, mit Dividenden), in Dollar, vom Tag der
          Entscheidung an. Ein Kauf lag richtig, wenn die Aktie danach vorn lag, ein Verkauf, wenn sie zurückblieb.
          Auf ein paar Dutzend Entscheidungen sind das Hinweise, keine Befunde.
          {data.unmeasured > 0 && ` ${data.unmeasured} von ${data.decisions} Entscheidungen betreffen Werte ohne gespeicherte Kurse und sind nicht gemessen.`}
          {' '}Die einzelnen Entscheidungen stehen im <a href="#/review" className="text-accent hover:underline">Rückblick</a>.
        </p>
      </section>

      <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-2 text-left font-semibold">Gruppe</th>
              {RECORD_HORIZONS.map((h) => <th key={h} className="px-3 py-2 text-right font-semibold">{h} {h === 1 ? 'Monat' : 'Monate'}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {data.rows.filter((r) => RECORD_HORIZONS.some((h) => r.cells[h].n > 0)).map((r) => (
              <tr key={r.label}>
                <td className="px-4 py-1.5 text-ink-300">{r.label}</td>
                {RECORD_HORIZONS.map((h) => {
                  const c = r.cells[h];
                  const thin = c.n < MIN_COMPARE;
                  return (
                    <td key={h} className={`px-3 py-1.5 text-right font-mono ${thin ? 'text-ink-600' : ''}`}>
                      {c.median === null ? '—' : (
                        <Tip focusable={false} content={`${c.n} Entscheidungen; ${Math.round((c.right ?? 0) * 100)} % lagen richtig`}>
                          <span className={thin ? '' : decisionRight(r.side, c.median) ? 'text-emerald-400' : 'text-red-400'}>{fmtSignedPct(c.median)}</span>
                          <span className="text-ink-600"> ({c.n})</span>
                        </Tip>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-2 text-xs text-ink-500">
          Median gegenüber dem S&amp;P 500, in Klammern die Zahl der Entscheidungen; grau unter {MIN_COMPARE}. Grün, wo die
          Gruppe im Median richtig lag — bei Verkäufen heißt das: die Aktie blieb danach zurück.
        </p>
      </section>
    </div>
  );
}
