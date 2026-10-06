import type { EvaluationResponse } from '../types';
import { deNumber, fmt, fmtPct, fmtSignedPct } from '../format';

/**
 * The pieces the evaluation page and the backtest panel share: how a return
 * and an IC are printed, and how much a row's sample supports reading it.
 */

type IcRow = EvaluationResponse['evaluation']['ics'][number];
type WeightRow = EvaluationResponse['weights'][number];

export function pct(v: number | null): string {
  return fmtSignedPct(v, 1);
}

/** How much the sample supports reading anything into the row. */
export function evidence(t: number | null, independent: number): { label: string; cls: string } {
  if (t === null || independent < 3) return { label: 'zu wenig Daten', cls: 'text-ink-500' };
  const a = Math.abs(t);
  if (a >= 2) return { label: t > 0 ? 'belastbar positiv' : 'belastbar negativ', cls: t > 0 ? 'text-emerald-400' : 'text-red-400' };
  if (a >= 1) return { label: t > 0 ? 'Tendenz positiv' : 'Tendenz negativ', cls: 'text-amber-400' };
  return { label: 'nicht von Zufall zu unterscheiden', cls: 'text-ink-500' };
}

/** A signed bar around a centre line; `scale` is the value that fills one side. */
export function SignedBar({ value, scale }: { value: number | null; scale: number }) {
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

/** One row per signal: pooled and sector-neutral IC, their t, hit rate, spread and sample. */
export function IcTable({ signals, rows, periodLabel }: {
  signals: { key: string; title: string; pillar: boolean }[];
  rows: IcRow[];
  /** What a formation period is called in the "periods / independent" column. */
  periodLabel: string;
}) {
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-2 text-left font-normal">Signal</th>
            <th className="px-2 py-2 text-right font-normal">IC</th>
            <th className="w-32 px-2 py-2 font-normal" />
            <th className="px-2 py-2 text-right font-normal">t</th>
            <th className="px-2 py-2 text-right font-normal">Im Sektor (t)</th>
            <th className="px-2 py-2 text-right font-normal">Treffer</th>
            <th className="px-2 py-2 text-right font-normal">Oben−Unten</th>
            <th className="px-2 py-2 text-right font-normal">{periodLabel} / unabh.</th>
            <th className="px-4 py-2 text-left font-normal">Aussagekraft</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => {
            const r = rowOf.get(s.key);
            if (!r || r.days === 0) return null;
            const e = evidence(r.tStat, r.independent);
            return (
              <tr key={s.key} className="border-b border-ink-800/60 last:border-0">
                <td className={`px-4 py-1.5 ${s.pillar ? 'pl-8 text-ink-300' : 'font-medium text-ink-100'}`}>{s.title}</td>
                <td className="px-2 py-1.5 text-right font-mono">{fmt(r.meanIc, '', 3)}</td>
                <td className="px-2 py-1.5"><SignedBar value={r.meanIc} scale={0.1} /></td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-300">{fmt(r.tStat, '', 1)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-300">
                  {fmt(r.neutralIc, '', 3)}
                  {r.neutralTStat !== null && <span className="text-ink-500"> ({deNumber(r.neutralTStat, 1)})</span>}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-300">
                  {r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)} %`}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-300">{pct(r.spread)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-400">{r.days} / {r.independent}</td>
                <td className={`px-4 py-1.5 text-xs ${e.cls}`}>{e.label}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Today's pillar weights beside the ones the evidence argues for. */
export function WeightsTable({ weights }: { weights: (WeightRow & { title?: string })[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-2 text-left font-normal">Säule</th>
            <th className="px-2 py-2 text-right font-normal">Heute</th>
            <th className="px-2 py-2 text-right font-normal">Vorschlag</th>
            <th className="px-2 py-2 text-right font-normal">IC</th>
            <th className="px-2 py-2 text-right font-normal">geschrumpft</th>
            <th className="px-4 py-2 text-right font-normal">unabh. Fenster</th>
          </tr>
        </thead>
        <tbody>
          {weights.map((w) => {
            const delta = w.suggested - w.current;
            return (
              <tr key={w.key} className="border-b border-ink-800/60 last:border-0">
                <td className="px-4 py-1.5 text-ink-200">{w.title ?? w.key}</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-300">{fmtPct(w.current, 0)}</td>
                <td className={`px-2 py-1.5 text-right font-mono ${Math.abs(delta) < 0.005 ? 'text-ink-400' : delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtPct(w.suggested, 0)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-300">{fmt(w.ic, '', 3)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-400">{deNumber(w.shrunkIc, 3)}</td>
                <td className="px-4 py-1.5 text-right font-mono text-ink-500">{w.independent}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
