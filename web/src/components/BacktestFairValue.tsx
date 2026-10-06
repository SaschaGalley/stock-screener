import type { BacktestResponse } from '../types';
import { FAIR_HORIZONS, FAIR_LENSES, FAIR_POSITIONS } from '../../../src/backtest/fair-value';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const num = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d).replace('.', ',').replace('-', '−'));
const pct = (v: number | null | undefined, d = 2) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const share = (v: number) => `${Math.round(v * 100)} %`;
const months = (h: number) => (h === 1 ? '1 M' : `${h} M`);
/** Bold from two standard errors, as everywhere on the page. */
const firm = (t: number | null | undefined) => (t != null && Math.abs(t) >= 2 ? 'font-semibold text-ink-100' : 'text-ink-300');

/**
 * The composite fair value put to the test: does its margin of safety rank
 * the returns that followed, does the price close the gap, what each place
 * in the models' range earned, and whether the price ends up inside it.
 */
export default function BacktestFairValue({ bt }: { bt: Backtest }) {
  const fv = bt.fairValue;
  if (!fv) return null;
  const ic = (lens: string, h: number) => fv.ics.find((r) => r.key === lens && r.horizon === h);
  const slope = (lens: string, h: number) => fv.convergence.find((r) => r.lens === lens && r.horizon === h);
  const position = (p: string, h: number) => fv.positions.find((r) => r.bucket === p && r.horizon === h);
  const ranges = [...new Set(fv.ranges.map((r) => r.range))];

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">
          Der faire Wert im Test
          {bt.studiesAt && <span className="font-normal normal-case text-ink-500"> · Studie vom {new Date(bt.studiesAt).toLocaleDateString('de-DE')}</span>}
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Der faire Wert der Seite — der Median der primären Modelle — und seine Spanne an jedem Monatsende, wie der Backtest sie
          nachbaut (ohne Konsensschätzungen; das Kursziel aus der Rating-Historie). Lücke ist ln(fairer Wert / Kurs). „Geschlossen“ ist
          die Steigung der Überrendite auf die Lücke, Monat für Monat über alle Aktien: der Anteil der Lücke, den eine Aktie gegenüber
          der Durchschnittsaktie aufholte. Fett: zwei Standardfehler von null.
        </p>
      </header>

      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Linse</th>
            {FAIR_HORIZONS.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">IC {months(h)}</th>)}
            {FAIR_HORIZONS.map((h) => <th key={`s${h}`} className="px-2 py-1.5 text-right font-normal">geschlossen {months(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {FAIR_LENSES.map((l) => (
            <tr key={l.key} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1 text-ink-300">
                {l.label}
                <div className="text-2xs text-ink-500">
                  für {share(fv.coverage[l.key] ?? 0)} der Firmenmonate · typische Lücke {pct(Math.expm1(fv.medianGap[l.key] ?? NaN), 0)}
                </div>
              </td>
              {FAIR_HORIZONS.map((h) => {
                const r = ic(l.key, h);
                return (
                  <td key={h} className={`whitespace-nowrap px-2 py-1 text-right font-mono ${firm(r?.tStat)}`}>
                    {num(r?.meanIc, 3)} <span className="text-2xs font-normal text-ink-500">({num(r?.tStat, 1)})</span>
                  </td>
                );
              })}
              {FAIR_HORIZONS.map((h) => {
                const r = slope(l.key, h);
                return (
                  <td key={`s${h}`} className={`whitespace-nowrap px-2 py-1 text-right font-mono ${firm(r?.t)}`}>
                    {r?.slope == null ? '—' : `${num(r.slope * 100, 1)} %`}{' '}
                    <span className="text-2xs font-normal text-ink-500">({num(r?.t, 1)})</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
        Wo der Kurs in der Spanne der primären Modelle stand, und was das gegen die Durchschnittsaktie brachte:
      </div>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Kurs</th>
            <th className="px-2 py-1.5 text-right font-normal">Anteil</th>
            {FAIR_HORIZONS.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">{months(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {FAIR_POSITIONS.map((p) => (
            <tr key={p} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1 text-ink-300">{p}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{share(fv.positionShare[p] ?? 0)}</td>
              {FAIR_HORIZONS.map((h) => {
                const r = position(p, h);
                return (
                  <td key={h} className={`whitespace-nowrap px-2 py-1 text-right font-mono ${firm(r?.tStat)}`}>
                    {pct(r?.meanExcess)} <span className="text-2xs font-normal text-ink-500">({num(r?.tStat, 1)})</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
        Wie oft der Kurs in der Spanne lag, als sie gezogen wurde — und wie oft in derselben Spanne einen Horizont später. Zöge der
        faire Wert den Kurs an, wäre die zweite Zahl die größere:
      </div>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Spanne</th>
            {FAIR_HORIZONS.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">{months(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {ranges.map((g) => (
            <tr key={g} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1 text-ink-300">{fv.ranges.find((r) => r.range === g)?.label}</td>
              {FAIR_HORIZONS.map((h) => {
                const r = fv.ranges.find((x) => x.range === g && x.horizon === h);
                return (
                  <td key={h} className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-300">
                    {r ? <>{share(r.then)} → <span className={r.later > r.then ? 'text-emerald-400' : 'text-red-400'}>{share(r.later)}</span></> : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
