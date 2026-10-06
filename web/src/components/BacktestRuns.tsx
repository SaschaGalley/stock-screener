import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { BacktestOverview } from '../../../src/backtest-service';
import { deNumber, fmt } from '../format';

const TRIGGER: Record<string, string> = { cron: 'monatlich', manual: 'von Hand', cli: 'Terminal' };
const fmtTime = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

/** The overview, polled while a run is going. */
export function useBacktestOverview(): { data: BacktestOverview | null; reload: () => void } {
  const [data, setData] = useState<BacktestOverview | null>(null);
  const reload = useCallback(() => { api.getBacktestOverview().then(setData).catch(() => { /* shown as nothing */ }); }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!data?.running) return;
    const t = window.setInterval(reload, 5_000);
    return () => window.clearInterval(t);
  }, [data?.running, reload]);
  return { data, reload };
}

/** One line on the run in progress or the last one. */
export function BacktestStatusLine({ o }: { o: BacktestOverview }) {
  const s = o.status;
  if (o.running && s) {
    return <span className="text-amber-300">Läuft seit {fmtTime(s.startedAt)} ({TRIGGER[s.trigger] ?? s.trigger}){s.phase ? ` — ${s.phase}` : ''}</span>;
  }
  if (!s) return <span className="text-ink-500">Noch kein Lauf aus der App.</span>;
  const when = s.finishedAt ? fmtTime(s.finishedAt) : fmtTime(s.updatedAt);
  if (s.state === 'done') {
    return <span className="text-ink-300">Zuletzt fertig {when} ({TRIGGER[s.trigger] ?? s.trigger}){s.peakMb ? `, Speicher bis ${deNumber(s.peakMb / 1024, 1)} GB` : ''}</span>;
  }
  return (
    <span className="text-red-400">
      {s.state === 'interrupted' ? 'Abgebrochen' : 'Fehlgeschlagen'} {when}{s.error ? ` — ${s.error}` : ''}
    </span>
  );
}

/** Every run kept: when, on what, and what the factor score did at one month. */
export default function BacktestRuns({ o }: { o: BacktestOverview }) {
  if (o.runs.length < 2) return null;
  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">Frühere Läufe</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Jeder Lauf bleibt gespeichert. Ein Monatsende mehr, eine korrigierte Meldung oder ein größeres Universum verschiebt
          die Zahlen — wie weit, steht hier.
        </p>
      </header>
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Gerechnet</th>
            <th className="px-2 py-1.5 text-left font-normal">Universum</th>
            <th className="px-2 py-1.5 text-right font-normal">Monate</th>
            <th className="px-2 py-1.5 text-right font-normal">Firmen</th>
            <th className="px-2 py-1.5 text-right font-normal">IC 1 M (t)</th>
            <th className="px-2 py-1.5 text-right font-normal">Im Sektor</th>
            <th className="px-4 py-1.5 text-right font-normal">Gewichts-Fit</th>
          </tr>
        </thead>
        <tbody>
          {o.runs.map((r) => (
            <tr key={r.id} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1 text-ink-300">{fmtTime(r.generatedAt)} <span className="text-xs text-ink-500">{TRIGGER[r.trigger] ?? r.trigger}</span></td>
              <td className="px-2 py-1 text-ink-300">{r.universe ?? '—'}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{r.months ?? '—'}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{r.companies ?? '—'}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-200">
                {fmt(r.ic, '', 3)} <span className="text-ink-500">({fmt(r.tStat, '', 1)})</span>
              </td>
              <td className="px-2 py-1 text-right font-mono text-ink-300">{fmt(r.neutralIc, '', 3)}</td>
              <td className={`px-4 py-1 text-right text-xs ${r.held ? 'text-emerald-400' : 'text-ink-500'}`}>{r.held ? 'hält' : 'hält nicht'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
