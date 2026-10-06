import type { BacktestResponse } from '../types';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const pct = (v: number | null | undefined, d = 2) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const share = (v: number) => `${Math.round(v * 100)} %`;
const num = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1).replace('.', ',').replace('-', '−'));
const VERDICT_COLOR: Record<string, string> = { 'trägt': 'text-emerald-400', 'warnt': 'text-red-400', 'nicht belegt': 'text-ink-400' };

/**
 * The setups against a random entry with the same stop and target: every
 * stock-month entered blindly, and the ones a setup chose, each month.
 */
export default function BacktestSetups({ bt }: { bt: Backtest }) {
  const st = bt.setups;
  if (!st) return null;
  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">Setups gegen den Zufallseinstieg</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          An jedem Monatsende ist jede Aktie ein Trade: Einstieg zum Schlusskurs, Stop und Ziel in typischen Tagesbewegungen (ATR aus
          Schlusskursen), sonst Ausstieg nach Ablauf; {pct(st.costPerSide, 1).replace('+', '')} Kosten je Seite. Das ist der Zufallseinstieg — Stop und Ziel
          allein bestimmen, wie oft er gewinnt. Ein Setup zählt nur, wenn seine Trades im selben Monat mehr bringen als die zufälligen.
          „trägt“: |t| ≥ 2 und beide Hälften der Jahre gleich gerichtet, nur bei den Abständen der Regel; die breiteren wurden nach dem
          ersten Probelauf ergänzt, weil die Trades nach etwa einer Woche endeten — gezeigt, nicht bewertet.
        </p>
      </header>
      {st.geometries.map((g) => (
        <table key={g.barriers.key} className="w-full min-w-[900px] text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="min-w-[16rem] px-4 py-1.5 text-left font-semibold text-ink-300">{g.barriers.label}{g.judged ? ' · Regel' : ' · gezeigt'}</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">Trades</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">Ziel · Stop · Zeit</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">je Trade</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">Tage</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">gegen Zufall (t)</th>
              <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">bis 2019 / ab 2020</th>
              <th className="whitespace-nowrap px-4 py-1.5 text-right font-normal">Urteil</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-ink-800/60 text-ink-400">
              <td className="px-4 py-1">Zufallseinstieg (jede Aktie, jeden Monat)</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{g.baseline.trades.toLocaleString('de-DE')}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{share(g.baseline.target)} · {share(g.baseline.stop)} · {share(g.baseline.time)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{pct(g.baseline.meanRet)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{g.baseline.sessions?.toFixed(0) ?? '—'}</td>
              <td colSpan={3} />
            </tr>
            {g.setups.map((s) => (
              <tr key={s.key} className="border-b border-ink-800/60 align-top last:border-0">
                <td className="px-4 py-1 text-ink-200">
                  {s.title}
                  <div className="text-2xs text-ink-500">{s.idea}</div>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-300">
                  {s.trades.toLocaleString('de-DE')}
                  <div className="text-2xs text-ink-500">{s.perMonth.toFixed(1).replace('.', ',')} im Monat</div>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-300">{share(s.target)} · {share(s.stop)} · {share(s.time)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-300">{pct(s.meanRet)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{s.sessions?.toFixed(0) ?? '—'}</td>
                <td className={`whitespace-nowrap px-2 py-1 text-right font-mono ${Math.abs(s.excess.t ?? 0) >= 2 ? 'font-semibold text-ink-100' : 'text-ink-300'}`}>
                  {pct(s.excess.mean)} <span className="text-2xs font-normal text-ink-500">({num(s.excess.t)})</span>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{pct(s.first.mean)} / {pct(s.second.mean)}</td>
                <td className={`whitespace-nowrap px-4 py-1 text-right ${g.judged ? VERDICT_COLOR[s.verdict] : 'text-ink-500'}`}>{s.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
