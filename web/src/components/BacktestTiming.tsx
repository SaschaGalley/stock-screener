import type { BacktestResponse } from '../types';
import { TIMING_GROUPS } from '../../../src/analysis/timing';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const num = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d).replace('.', ',').replace('-', '−'));
const pct = (v: number | null | undefined, d = 2) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const firm = (t: number | null | undefined) => (t != null && Math.abs(t) >= 2 ? 'font-semibold text-ink-100' : 'text-ink-300');

/**
 * Whether it pays to wait for the chart: each timing reading across all
 * stocks as a rank IC, and inside each verdict as the half deeper in the dip
 * against the half higher up. Marked where the rule fixed with the readings
 * holds — two standard errors, and both halves of the years the same way.
 */
export default function BacktestTiming({ bt, horizon, monthName }: { bt: Backtest; horizon: number; monthName: (h: number) => string }) {
  const study = bt.timing;
  if (!study) return null;
  const horizons = [...new Set(study.splits.map((s) => s.horizon))];
  const h = horizons.includes(horizon) ? horizon : 3;
  const ic = (key: string) => bt.evaluation.ics.find((r) => r.key === `candidate.${key}` && r.horizon === h);
  const split = (key: string, group: string) => study.splits.find((s) => s.candidate === key && s.group === group && s.horizon === h);
  const held = study.splits.filter((s) => s.holds);

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">
          Timing: lohnt es, auf den Chart zu warten? · {monthName(h)}
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Jede Lesart so gedreht, dass mehr „tiefer im Dip“ heißt. IC: Rangkorrelation mit der Rendite über alle Aktien. Rechts: in
          jeder Urteilsgruppe Monat für Monat die Hälfte tiefer im Dip gegen die Hälfte weiter oben, gegen die Durchschnittsaktie;
          darunter die beiden Hälften der Jahre (bis 2019 / ab 2020). Plus: Warten auf den Rücksetzer hat sich gelohnt; minus: der Trend
          lief weiter. ✓ nach der Regel, die mit den Lesarten festgelegt wurde: |t| ≥ 2 und beide Hälften gleich gerichtet — was ohne jeden
          Effekt etwa jeder dreißigste Test schafft. Über alle {study.splits.length} Tests: {held.length} ✓.
        </p>
      </header>

      <table className="w-full min-w-[860px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Lesart</th>
            <th className="px-2 py-1.5 text-right font-normal">IC</th>
            {TIMING_GROUPS.map((g) => <th key={g.key} className="px-2 py-1.5 text-right font-normal">{g.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {study.candidates.map((c) => {
            const r = ic(c.key);
            return (
              <tr key={c.key} className="border-b border-ink-800/60 align-top last:border-0">
                <td className="px-4 py-1 text-ink-300">
                  {c.title}
                  <div className="text-2xs text-ink-500">{c.claim}</div>
                </td>
                <td className={`whitespace-nowrap px-2 py-1 text-right font-mono ${firm(r?.tStat)}`}>
                  {num(r?.meanIc, 3)} <span className="text-2xs font-normal text-ink-500">({num(r?.tStat, 1)})</span>
                </td>
                {TIMING_GROUPS.map((g) => {
                  const s = split(c.key, g.key);
                  return (
                    <td key={g.key} className={`whitespace-nowrap px-2 py-1 text-right font-mono ${firm(s?.diff.t)}`}>
                      {pct(s?.diff.mean)} <span className="text-2xs font-normal text-ink-500">({num(s?.diff.t, 1)})</span>
                      {s?.holds && <span className="ml-1 text-emerald-400">✓</span>}
                      <div className="text-2xs font-normal text-ink-500">{pct(s?.first.mean, 1)} / {pct(s?.second.mean, 1)}</div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
