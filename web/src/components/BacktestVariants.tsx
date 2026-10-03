import type { BacktestResponse } from '../types';
import { recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const pct = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)} %`);

/**
 * The score assembled again from the same rows under other rules — the
 * conviction stretch at full, half and none. The rank is what means the same
 * in every variant; the verdicts show how many stocks each band then holds.
 */
export default function BacktestVariants({ bt, horizon, monthName }: { bt: Backtest; horizon: number; monthName: (h: number) => string }) {
  const variants = bt.variants ?? [];
  if (variants.length < 2) return null;
  const horizons = [...new Set(variants[0].ics.map((r) => r.horizon))].sort((a, b) => a - b);
  const ic = (v: (typeof variants)[number], h: number) => v.ics.find((r) => r.key === 'score' && r.horizon === h);
  const bucket = (list: { horizon: number; bucket: string; meanExcess: number | null; count: number }[], b: string) =>
    list.find((r) => r.horizon === horizon && r.bucket === b);

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Varianten: Conviction-Streckung</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Derselbe Score aus denselben Kriterienpunkten, demselben Vertrauen und denselben Kappungen, nur die Streckung anders.
          Die Rangfolge (IC, Zehntel) bedeutet in jeder Variante dasselbe; die Urteilsbänder wurden mit der Streckung gesetzt,
          ohne sie erreicht sie kaum noch jemand.
        </p>
      </header>
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Variante</th>
            {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">IC {monthName(h)}</th>)}
            <th className="px-2 py-1.5 text-right font-normal" title={`Zehntes gegen neuntes Zehntel, ${monthName(horizon)}`}>D9 / D10</th>
            <th className="px-4 py-1.5 text-left font-normal">Verteilung der Urteile</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr key={v.key} className="border-b border-ink-800/60 last:border-0 align-top">
              <td className="px-4 py-1.5 text-ink-200">{v.label}</td>
              {horizons.map((h) => (
                <td key={h} className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-300">
                  {ic(v, h)?.meanIc?.toFixed(3) ?? '—'} <span className="text-ink-500">({ic(v, h)?.tStat?.toFixed(1) ?? '—'})</span>
                </td>
              ))}
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-300">
                {pct(bucket(v.deciles, 'D9')?.meanExcess)} / {pct(bucket(v.deciles, 'D10')?.meanExcess)}
              </td>
              <td className="px-4 py-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {RECOMMENDATIONS.map((r) => {
                    const share = v.verdictShare[r] ?? 0;
                    const b = bucket(v.verdicts, r);
                    return (
                      <span
                        key={r}
                        className={`rounded px-1.5 py-0.5 text-2xs font-bold ${recommendationColor(r)}`}
                        title={b ? `${monthName(horizon)}: ${pct(b.meanExcess)} gegenüber Ø · ${b.count} Fälle` : 'keine Fälle'}
                      >
                        {r} {(share * 100).toFixed(share < 0.01 ? 1 : 0)} %
                      </span>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
