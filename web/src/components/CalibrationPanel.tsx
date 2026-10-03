import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { CalibrationOverview } from '../../../src/calibration-service';

const fmtTime = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const pts = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(2).replace('.', ',')} Pkt.`;

interface Committed {
  generatedAt:       string | null;
  symbols:           number;
  observations:      number;
  premiumAdjustment: number;
  due:               string | null;
}

/**
 * The calibration in force, and a new one computed where the universe is.
 *
 * The table is code: the button computes it from this deployment's database,
 * and the page offers the file to put in `src/analysis/` and commit. The deploy
 * that carries it re-scores the history, as every scoring change does.
 */
export default function CalibrationPanel({ committed }: { committed: Committed }) {
  const [data, setData] = useState<CalibrationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { api.getCalibration().then(setData).catch(() => { /* shown as nothing */ }); }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!data?.running) return;
    const t = window.setInterval(reload, 5_000);
    return () => window.clearInterval(t);
  }, [data?.running, reload]);

  async function run() {
    setError(null);
    try {
      const r = await api.runCalibration();
      if (!r.started) setError(r.reason ?? 'Kalibrierung nicht gestartet.');
    } catch (e) {
      setError((e as Error).message);
    }
    reload();
  }

  const p = data?.proposal ?? null;
  // A proposal older than the table in force has been committed, or overtaken.
  const pending = p && (!committed.generatedAt || p.generatedAt > committed.generatedAt) ? p : null;
  const s = data?.status ?? null;

  return (
    <div className="rounded border border-ink-800 bg-ink-950/40 px-3 py-2 text-xs leading-relaxed text-ink-400">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Kalibrierung {committed.generatedAt ? `vom ${new Date(committed.generatedAt).toLocaleDateString('de-DE')}` : 'fehlt'}
          {' '}· {committed.symbols} Aktien, {committed.observations} Beobachtungen · Prämienkorrektur {pts(committed.premiumAdjustment)}
        </span>
        <button
          onClick={() => void run()}
          disabled={!!data?.running}
          className="ml-auto rounded border border-ink-700 bg-ink-800 px-3 py-1 text-xs text-ink-200 transition hover:bg-ink-700 disabled:opacity-40"
          title="Rechnet die Verteilungen aus den gespeicherten Daten der letzten 26 Wochen neu — als eigener Prozess, einige Minuten"
        >
          Neu berechnen
        </button>
      </div>
      {committed.due && !pending && <div className="mt-1 text-amber-400">Neukalibrierung fällig: {committed.due}.</div>}
      {data?.running && s && <div className="mt-1 text-amber-300">Läuft seit {fmtTime(s.startedAt)} …</div>}
      {!data?.running && s && (s.state === 'failed' || s.state === 'interrupted') && (
        <div className="mt-1 text-red-400">
          {s.state === 'interrupted' ? 'Abgebrochen' : 'Fehlgeschlagen'} {s.finishedAt ? fmtTime(s.finishedAt) : ''}{s.error ? ` — ${s.error}` : ''}
        </div>
      )}
      {error && <div className="mt-1 text-red-400">{error}</div>}

      {pending && (
        <div className="mt-2 border-t border-ink-800 pt-2">
          <div className="text-ink-200">
            Neue Tabelle vom {fmtTime(pending.generatedAt)}: {pending.symbols} Aktien (bisher {pending.current.symbols}),
            {' '}{pending.observations} Beobachtungen (bisher {pending.current.observations}), {pending.criteria} Verteilungen
            (bisher {pending.current.criteria}), Prämienkorrektur {pts(pending.premiumAdjustment)} (bisher {pts(pending.current.premiumAdjustment)}).
          </div>
          {pending.shifts.length > 0 && (
            <>
              <div className="mt-1.5">Wo die typische Aktie jetzt auf der alten Skala läge (50 = unverändert):</div>
              <ul className="mt-0.5 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {pending.shifts.map((x) => (
                  <li key={x.key} className="flex justify-between gap-2 font-mono">
                    <span className="truncate">{x.key}</span>
                    <span className={Math.abs(x.oldPercentile - 0.5) >= 0.1 ? 'text-amber-300' : 'text-ink-300'}>
                      {Math.round(x.oldPercentile * 100)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={api.calibrationTableUrl}
              download="calibration-table.ts"
              className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-xs text-accent transition hover:bg-accent/20"
            >
              calibration-table.ts herunterladen
            </a>
            <span className="text-ink-500">
              Ersetzt <span className="font-mono">src/analysis/calibration-table.ts</span>; committen und deployen — der Server bewertet
              danach die gespeicherte Historie neu.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
