import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { EvaluationResponse } from '../types';
import { CloseIcon } from '../components/icons';
import { recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';

/**
 * Does a high score come before a better return?
 *
 * The page shows what `pnpm run evaluate` prints, for the one reader who will
 * never open a terminal. It leans hard on the caveats, because the numbers
 * look authoritative long before they are: with a few dozen stocks one day's
 * IC has a standard error near ±0.17, and until there are many independent
 * windows every column here describes the past rather than testing the model.
 */

const HORIZONS = [5, 20, 60];

interface Props {
  onClose: () => void;
}

function pct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} %`;
}

/** How much the sample supports reading anything into the row. */
function evidence(t: number | null, independent: number): { label: string; cls: string } {
  if (t === null || independent < 3) return { label: 'zu wenig Daten', cls: 'text-ink-500' };
  const a = Math.abs(t);
  if (a >= 2) return { label: t > 0 ? 'belastbar positiv' : 'belastbar negativ', cls: t > 0 ? 'text-emerald-400' : 'text-red-400' };
  if (a >= 1) return { label: 'Tendenz', cls: 'text-amber-400' };
  return { label: 'nicht von Zufall zu unterscheiden', cls: 'text-ink-500' };
}

/** A signed bar around a centre line; `scale` is the value that fills one side. */
function SignedBar({ value, scale }: { value: number | null; scale: number }) {
  if (value === null) return <div className="h-2 w-full" />;
  const w = Math.min(Math.abs(value) / scale, 1) * 50;
  return (
    <div className="relative h-2 w-full rounded bg-ink-800">
      <div className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
      <div
        className={`absolute inset-y-0 rounded ${value >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
        style={value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </div>
  );
}

export default function EvaluationPage({ onClose }: Props) {
  const [data, setData] = useState<EvaluationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState(20);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getEvaluation(HORIZONS, fresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const ev = data?.evaluation;
  const rows = ev?.ics.filter((r) => r.horizon === horizon) ?? [];
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const labels = (ev?.labels.filter((l) => l.horizon === horizon) ?? [])
    .sort((a, b) => RECOMMENDATIONS.indexOf(a.label as never) - RECOMMENDATIONS.indexOf(b.label as never));
  const closedHorizons = new Set(ev?.ics.filter((r) => r.days > 0).map((r) => r.horizon));
  const headline = rowOf.get('score.final.score');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-ink-100">Auswertung</h2>
          {ev && (
            <span className="text-[11px] text-ink-500">
              Scores {ev.from ?? '—'} bis {ev.to ?? '—'} · {ev.symbols} Aktien
              {data && ` · berechnet ${new Date(data.computedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void load(true)}
              disabled={loading}
              className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 disabled:opacity-40"
            >
              {loading ? 'Rechne…' : 'Neu berechnen'}
            </button>
            <button
              onClick={onClose}
              title="Schließen (Esc)"
              className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-ink-300">
          Sortiert an jedem Handelstag alle Aktien nach dem Score, den sie <em>vorher</em> hatten, und nach
          ihrer Rendite gegenüber dem S&amp;P 500 in den folgenden Handelstagen, und misst, wie gut die
          beiden Reihenfolgen übereinstimmen (Rang-IC: +1 perfekt, 0 kein Zusammenhang, −1 umgekehrt).
          Ein brauchbarer Faktor liegt bei 0,03–0,08. Mit ~37 Aktien schwankt ein einzelner Tag um etwa ±0,17 —
          belastbar wird das erst nach vielen unabhängigen Zeitfenstern, also nach Monaten.
        </p>

        {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
        {!data && loading && (
          <div className="p-8 text-center text-sm text-ink-500">
            Lade Kurse und rechne — beim ersten Aufruf dauert das etwa eine halbe Minute…
          </div>
        )}

        {ev && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-ink-400">Horizont</span>
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  onClick={() => setHorizon(h)}
                  className={`rounded px-2.5 py-1 text-xs transition ${
                    h === horizon ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
                  } ${closedHorizons.has(h) ? '' : 'opacity-50'}`}
                  title={closedHorizons.has(h) ? undefined : 'Noch kein Zeitfenster dieser Länge abgeschlossen'}
                >
                  {h} Handelstage
                </button>
              ))}
            </div>

            {headline && headline.days > 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-ink-200">
                Gesamt-Score über {horizon} Handelstage: Rang-IC <span className="font-mono">{headline.meanIc?.toFixed(2)}</span>,
                im oberen Drittel {pct(headline.spread)} gegenüber dem unteren ·{' '}
                <span className={evidence(headline.tStat, headline.independent).cls}>
                  {evidence(headline.tStat, headline.independent).label}
                </span>{' '}
                <span className="text-ink-500">({headline.independent} unabhängige Fenster)</span>
              </div>
            )}

            <section className="rounded-lg border border-ink-700 bg-ink-900">
              <header className="border-b border-ink-800 px-4 py-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Signale</h3>
                <p className="mt-0.5 text-[11px] text-ink-500">
                  IC gemittelt über alle Tage · t nur aus nicht überlappenden Fenstern · Treffer = Anteil der Tage mit positivem IC ·
                  Oben−Unten = Mehrrendite oberes minus unteres Drittel
                </p>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-[11px] text-ink-400">
                    <tr className="border-b border-ink-800">
                      <th className="px-4 py-2 text-left font-normal">Signal</th>
                      <th className="px-2 py-2 text-right font-normal">IC</th>
                      <th className="w-32 px-2 py-2 font-normal" />
                      <th className="px-2 py-2 text-right font-normal">t</th>
                      <th className="px-2 py-2 text-right font-normal">Treffer</th>
                      <th className="px-2 py-2 text-right font-normal">Oben−Unten</th>
                      <th className="px-2 py-2 text-right font-normal">Tage / unabh.</th>
                      <th className="px-4 py-2 text-left font-normal">Aussagekraft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.signals.map((s) => {
                      const r = rowOf.get(s.key);
                      if (!r || r.days === 0) return null;
                      const e = evidence(r.tStat, r.independent);
                      return (
                        <tr key={s.key} className="border-b border-ink-800/60 last:border-0">
                          <td className={`px-4 py-1.5 ${s.pillar ? 'pl-8 text-ink-300' : 'font-medium text-ink-100'}`}>{s.title}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{r.meanIc?.toFixed(2) ?? '—'}</td>
                          <td className="px-2 py-1.5"><SignedBar value={r.meanIc} scale={0.3} /></td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-300">{r.tStat?.toFixed(1) ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-300">
                            {r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)} %`}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-300">{pct(r.spread)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-400">{r.days} / {r.independent}</td>
                          <td className={`px-4 py-1.5 text-[11px] ${e.cls}`}>{e.label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.every((r) => r.days === 0) && (
                  <div className="p-6 text-center text-sm text-ink-500">
                    Noch kein Zeitfenster von {horizon} Handelstagen abgeschlossen.
                  </div>
                )}
              </div>
            </section>

            {labels.length > 0 && (
              <section className="rounded-lg border border-ink-700 bg-ink-900">
                <header className="border-b border-ink-800 px-4 py-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Mehrrendite nach Urteil</h3>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    Durchschnittliche Rendite gegenüber dem S&amp;P 500 über {horizon} Handelstage, nur nicht überlappende Fenster ·
                    in Klammern die Zahl der Aktien-Fenster
                  </p>
                </header>
                <div className="space-y-2 p-4">
                  {labels.map((l) => (
                    <div key={l.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
                      <span className={`rounded px-2 py-0.5 text-center text-[11px] font-bold ${recommendationColor(l.label)}`}>{l.label}</span>
                      <SignedBar value={l.meanExcess} scale={0.1} />
                      <span className="whitespace-nowrap text-right font-mono text-ink-300">
                        {pct(l.meanExcess)} <span className="text-ink-500">({l.count})</span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <p className="text-[11px] leading-relaxed text-ink-500">
              Die Scores vor dem Einbau des aktuellen Modells sind mit den heutigen Regeln nachgerechnet: die Daten sind
              die damaligen, die Regeln aber nicht an Renditen angepasst — sobald sie das werden, ist dies kein Test mehr.
              Eine Reihe, die endet (z. B. der alte LLM-Score), zählt nur zehn Tage über ihren letzten Wert hinaus.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
