import { useState } from 'react';
import type { BacktestResponse } from '../types';
import { deNumber, fmt, fmtSignedPct, recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';
import { SignedBar } from './evaluationParts';
import type { BucketReturn } from '../../../src/analysis/evaluate';

type Backtest = NonNullable<BacktestResponse['backtest']>;
type Bands = NonNullable<Backtest['bands']>;

/** Two decimals: a month's difference between tenths is a tenth of a per cent. */
const pct = (v: number | null) => fmtSignedPct(v, 2);

const STEPS = ['<3', '3–4', '4–5', '5–6', '6–7', '7–8', '≥8'];
const DECILES = Array.from({ length: 10 }, (_, k) => `D${k + 1}`);

/** One bucket's line: what it earned against the month's average stock, how sure, how often. */
function Row({ label, r, scale }: { label: React.ReactNode; r: BucketReturn | undefined; scale: number }) {
  if (!r) return null;
  const t = r.tStat;
  const cls = t === null ? 'text-ink-500' : t >= 2 ? 'text-emerald-400' : t <= -2 ? 'text-red-400' : 'text-ink-300';
  return (
    <tr className="border-b border-ink-800/60 last:border-0">
      <td className="px-4 py-1 text-ink-200">{label}</td>
      <td className="w-32 px-2 py-1"><SignedBar value={r.meanExcess} scale={scale} /></td>
      <td className={`px-2 py-1 text-right font-mono ${cls}`}>{pct(r.meanExcess)}</td>
      <td className="px-2 py-1 text-right font-mono text-ink-400">{fmt(t, '', 1)}</td>
      <td className="px-2 py-1 text-right font-mono text-ink-400">{r.hitRate === null ? '—' : `${Math.round(r.hitRate * 100)} %`}</td>
      <td className="px-4 py-1 text-right font-mono text-ink-500">{r.months} / {deNumber(r.count, 0)}</td>
    </tr>
  );
}

function Head({ first }: { first: string }) {
  return (
    <thead className="text-xs text-ink-400">
      <tr className="border-b border-ink-800">
        <th className="px-4 py-1.5 text-left font-normal">{first}</th>
        <th className="w-32 px-2 py-1.5 font-normal" />
        <th className="px-2 py-1.5 text-right font-normal" title="Mittlere Mehrrendite gegenüber der Durchschnittsaktie desselben Monats">Mehr als Ø</th>
        <th className="px-2 py-1.5 text-right font-normal">t</th>
        <th className="px-2 py-1.5 text-right font-normal" title="Anteil der Monate, in denen das Band besser lief als der Durchschnitt">Monate besser</th>
        <th className="px-4 py-1.5 text-right font-normal">Monate / Fälle</th>
      </tr>
    </thead>
  );
}

/**
 * The score cut up: its tenths, its published verdicts and its whole points,
 * each against the average stock of the same months. Whether the ranking the
 * IC measures holds at every step — and whether the verdicts on the page
 * mean what their names say.
 */
export default function BacktestBands({ bt, horizon, monthName }: { bt: Backtest; horizon: number; monthName: (h: number) => string }) {
  const [scope, setScope] = useState<string>('all');
  if (!bt.bands) return null;
  const scopes: { key: string; label: string; bands: Bands }[] = [
    { key: 'all', label: bt.universe ?? 'Alle', bands: bt.bands },
    ...(bt.segments ?? []).flatMap((s) => (s.bands ? [{ key: s.key, label: s.label, bands: s.bands }] : [])),
  ];
  const b = (scopes.find((s) => s.key === scope) ?? scopes[0]).bands;
  const at = (list: BucketReturn[], bucket: string) => list.find((r) => r.horizon === horizon && r.bucket === bucket);
  // A month's spread between tenths grows with the horizon; the bars keep their reach.
  const scale = 0.004 * Math.sqrt(horizon) * 2.5;
  const verdicts = RECOMMENDATIONS.filter((v) => at(b.verdicts, v));

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Urteile, Zehntel und Stufen ({monthName(horizon)})</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Jeden Monat gegen die Durchschnittsaktie desselben Monats gemessen, nicht gegen den Index: Was alle gemeinsam hatten —
          der Markt, der Rückstand der Small Caps seit 2020 — steckt nicht darin. Steigt die Mehrrendite von Zehntel zu Zehntel,
          trägt die Rangfolge überall; die Urteile sollten in ihrer Reihenfolge liegen.
        </p>
        {scopes.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {scopes.map((s) => (
              <button
                key={s.key}
                onClick={() => setScope(s.key)}
                className={`rounded px-2 py-0.5 text-xs transition ${s.key === scope ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:bg-ink-800'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="grid gap-0 lg:grid-cols-2">
        <table className="w-full min-w-[420px] text-sm">
          <Head first="Score-Zehntel" />
          <tbody>
            {DECILES.map((d) => (
              <Row key={d} label={<>{d}{d === 'D1' ? ' (niedrigster)' : d === 'D10' ? ' (höchster)' : ''}</>} r={at(b.deciles, d)} scale={scale} />
            ))}
          </tbody>
        </table>
        <div>
          <table className="w-full min-w-[420px] text-sm">
            <Head first="Urteil" />
            <tbody>
              {verdicts.map((v) => (
                <Row
                  key={v}
                  label={<span className={`rounded px-1.5 py-0.5 text-2xs font-bold ${recommendationColor(v)}`}>{v}</span>}
                  r={at(b.verdicts, v)}
                  scale={scale}
                />
              ))}
            </tbody>
          </table>
          <table className="w-full min-w-[420px] text-sm">
            <Head first="Score-Stufe" />
            <tbody>
              {STEPS.map((st) => <Row key={st} label={st} r={at(b.steps, st)} scale={scale} />)}
            </tbody>
          </table>
        </div>
      </div>
      <p className="border-t border-ink-800 px-4 py-2 text-xs leading-relaxed text-ink-500">
        Höchstes Zehntel des Scores vor der Schrumpfung und Streckung: {pct(at(b.rawDeciles, 'D10')?.meanExcess ?? null)}
        {' '}(t {fmt(at(b.rawDeciles, 'D10')?.tStat, '', 1)}), nach ihr {pct(at(b.deciles, 'D10')?.meanExcess ?? null)}
        {' '}(t {fmt(at(b.deciles, 'D10')?.tStat, '', 1)}). „Monate / Fälle“: Formationsmonate ohne Überlappung und die
        Aktien darin.
      </p>
    </section>
  );
}
