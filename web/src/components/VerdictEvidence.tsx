import { useEffect, useState } from 'react';
import { api } from '../api';
import type { VerdictEvidence as Evidence } from '../../../src/backtest/result';

let cached: Promise<Evidence | null> | null = null;

/** The newest backtest's verdict bands, fetched once a page load: the list asks for them on every row. */
export function useVerdictEvidence(): Evidence | null {
  const [data, setData] = useState<Evidence | null>(null);
  useEffect(() => {
    cached ??= api.getVerdictEvidence().catch(() => null);
    let live = true;
    void cached.then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, []);
  return data;
}

const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).replace('.', ',')} %`);
const months = (h: number) => (h === 12 ? '12 M' : `${h} M`);
/** Two standard errors from nothing: anything less is a direction, not evidence. */
const FIRM_T = 2;

/** One verdict's past, as a line for a tooltip: "1 M +0,2 % · 6 M −2,5 % …". */
export function evidenceLine(e: Evidence, verdict: string): string | null {
  const rows = e.verdicts.filter((r) => r.bucket === verdict).sort((a, b) => a.horizon - b.horizon);
  if (!rows.length) return null;
  return `Im Backtest gegenüber der Durchschnittsaktie: ${rows.map((r) => `${months(r.horizon)} ${pct(r.meanExcess)}`).join(' · ')}`;
}

/**
 * What a verdict did before: the newest backtest's stocks with the same
 * factor verdict, against the average stock of the same month, one, three,
 * six and twelve months on. Beside the verdict so that it does not promise
 * more than it has delivered — a STRONG BUY ahead after a month and behind
 * after six is a different statement from one ahead after both.
 */
export default function VerdictEvidence({ verdict }: { verdict: string }) {
  const e = useVerdictEvidence();
  if (!e) return null;
  const rows = e.verdicts.filter((r) => r.bucket === verdict).sort((a, b) => a.horizon - b.horizon);
  if (!rows.length) return null;
  const firm = rows.some((r) => r.tStat !== null && Math.abs(r.tStat) >= FIRM_T);

  return (
    <div className="mt-3 rounded border border-ink-800 bg-ink-950 px-3 py-2">
      <div className="text-2xs uppercase tracking-wider text-ink-500">Was {verdict} im Backtest brachte</div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((r) => {
          const solid = r.tStat !== null && Math.abs(r.tStat) >= FIRM_T;
          const color = r.meanExcess === null ? 'text-ink-500' : r.meanExcess >= 0 ? 'text-emerald-400' : 'text-red-400';
          return (
            <div
              key={r.horizon}
              title={`t ${r.tStat?.toFixed(1).replace('.', ',') ?? '—'} · ${r.count.toLocaleString('de-DE')} Fälle in ${r.months} Monaten`
                + (r.hitRate !== null ? ` · in ${Math.round(r.hitRate * 100)} % der Monate vorn` : '')}
            >
              <div className="text-2xs text-ink-500">{months(r.horizon)}</div>
              <div className={`font-mono text-sm ${color} ${solid ? 'font-semibold' : 'opacity-70'}`}>{pct(r.meanExcess)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-2xs leading-snug text-ink-500">
        Aktien mit demselben Faktor-Urteil, {e.universe} {e.from.slice(0, 4)}–{e.to.slice(0, 4)}, gegen die Durchschnittsaktie
        desselben Monats.{' '}
        {firm ? 'Fett: mindestens zwei Standardfehler von null.' : 'Kein Wert liegt zwei Standardfehler von null — eine Richtung, kein Beleg.'}
        {e.fidelity?.rho != null && <> Der nachgebaute Score folgt dem der App mit einer Rangkorrelation von {e.fidelity.rho.toFixed(2).replace('.', ',')}.</>}
      </p>
    </div>
  );
}
