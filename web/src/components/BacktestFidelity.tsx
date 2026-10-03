import type { BacktestResponse } from '../types';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const rho = (v: number | null) => (v === null ? '—' : v.toFixed(2).replace('.', ','));
const share = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
const num = (v: number | null, d = 1) => (v === null ? '—' : v.toFixed(d).replace('.', ','));
/** Agreement a reader can take at a glance: green from 0.9, amber from 0.7. */
const tone = (v: number | null) => (v === null ? 'text-ink-500' : v >= 0.9 ? 'text-emerald-400' : v >= 0.7 ? 'text-amber-300' : 'text-red-400');

/**
 * Whether the backtest measures the score the app shows: the newest live
 * scores beside the backtest's of the same sessions, the rank correlation
 * split into what the data does and what the method does.
 */
export default function BacktestFidelity({ bt }: { bt: Backtest }) {
  const f = bt.fidelity;
  if (!f) return null;
  const score = f.scores.find((s) => s.key === 'score');
  const pillarLabel = new Map(f.scores.map((s) => [s.key, s.label]));

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">
          Misst der Backtest den Score der App?
          <span className="font-normal normal-case text-ink-500"> · Abgleich vom {new Date(f.generatedAt).toLocaleDateString('de-DE')}</span>
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Für {f.compared} Aktien, die in der App und im Backtest sind, der neueste Live-Faktor-Score neben dem, den der Backtest aus
          SEC-Abschlüssen, Kursen und der Rating-Historie für dieselbe Sitzung nachbaut
          ({f.sessions.slice(0, 3).map((s) => new Date(s.day).toLocaleDateString('de-DE')).join(', ')}). „Daten“ bewertet die
          nachgebauten Daten wie die App — gleiche Kalibrierung, Prämie und Zinsen —, so trennt sich, was an den Daten liegt und was
          an der Methode. {f.outside} Aktien der App liegen außerhalb des S&amp;P 1500.
        </p>
      </header>

      {score && (
        <div className="border-b border-ink-800 px-4 py-2.5 text-sm text-ink-200">
          Rangkorrelation des Scores <span className={`font-mono ${tone(score.rho)}`}>{rho(score.rho)}</span> · gleiches Urteil{' '}
          <span className="font-mono">{share(f.verdicts.same)}</span>, höchstens eine Stufe auseinander{' '}
          <span className="font-mono">{share(f.verdicts.adjacent)}</span> · oberstes Zehntel{' '}
          <span className="font-mono">{f.top.shared} von {f.top.size}</span> in beiden
        </div>
      )}

      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Signal</th>
            <th className="px-2 py-1.5 text-right font-normal" title="Live gegen Backtest — was der IC erbt">ρ live ~ Backtest</th>
            <th className="px-2 py-1.5 text-right font-normal" title="Live gegen die Backtest-Daten, wie die App sie bewertet: nur die Daten">ρ Daten</th>
            <th className="px-2 py-1.5 text-right font-normal" title="Backtest-Daten wie die App gegen wie der Backtest: nur die Methode">ρ Methode</th>
            <th className="px-2 py-1.5 text-right font-normal">Ø live</th>
            <th className="px-2 py-1.5 text-right font-normal">Ø Backtest</th>
            <th className="px-4 py-1.5 text-right font-normal">Ø |Abstand|</th>
          </tr>
        </thead>
        <tbody>
          {f.scores.map((s) => (
            <tr key={s.key} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1 text-ink-300">{s.label}</td>
              <td className={`px-2 py-1 text-right font-mono ${tone(s.rho)}`}>{rho(s.rho)}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{rho(s.rhoData)}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{rho(s.rhoMethod)}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{num(s.meanLive, 2)}</td>
              <td className="px-2 py-1 text-right font-mono text-ink-400">{num(s.meanBacktest, 2)}</td>
              <td className="px-4 py-1 text-right font-mono text-ink-400">{num(s.meanAbsDiff, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="border-t border-ink-800">
        <summary className="cursor-pointer px-4 py-2 text-xs text-ink-400 hover:text-ink-200">Kriterien: Abdeckung und Übereinstimmung</summary>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-1.5 text-left font-normal">Kriterium</th>
              <th className="px-2 py-1.5 text-right font-normal">Abdeckung live</th>
              <th className="px-2 py-1.5 text-right font-normal">Backtest</th>
              <th className="px-2 py-1.5 text-right font-normal" title="Rangkorrelation der Punkte, live gegen die Backtest-Daten">ρ Punkte</th>
              <th className="px-4 py-1.5 text-right font-normal">Ø Punkte live / Backtest</th>
            </tr>
          </thead>
          <tbody>
            {/* In pillar order, as the comparison lists them. */}
            {f.criteria.map((c, i) => (
              <tr key={`${c.pillar}.${c.key}`} className="border-b border-ink-800/60 last:border-0">
                <td className="px-4 py-1 text-ink-300">
                  {f.criteria[i - 1]?.pillar !== c.pillar && <span className="text-ink-500">{pillarLabel.get(c.pillar)} · </span>}{c.label}
                </td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{share(c.live)}</td>
                <td className={`px-2 py-1 text-right font-mono ${c.backtest < c.live - 0.15 ? 'text-amber-300' : 'text-ink-400'}`}>{share(c.backtest)}</td>
                <td className={`px-2 py-1 text-right font-mono ${tone(c.rho)}`}>{rho(c.rho)}</td>
                <td className="px-4 py-1 text-right font-mono text-ink-400">{num(c.meanLive, 2)} / {num(c.meanBacktest, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="border-t border-ink-800">
        <summary className="cursor-pointer px-4 py-2 text-xs text-ink-400 hover:text-ink-200">Eingangsdaten: Yahoo gegen SEC-Nachbau</summary>
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-1.5 text-left font-normal">Feld</th>
              <th className="px-2 py-1.5 text-right font-normal">Vorhanden live</th>
              <th className="px-2 py-1.5 text-right font-normal">Backtest</th>
              <th className="px-2 py-1.5 text-right font-normal" title="Beträge innerhalb 10 %, Raten innerhalb zwei Punkten, Beta innerhalb 0,1">gleich</th>
              <th className="px-4 py-1.5 text-right font-normal">ρ</th>
            </tr>
          </thead>
          <tbody>
            {f.fields.map((x) => (
              <tr key={x.key} className="border-b border-ink-800/60 last:border-0">
                <td className="px-4 py-1 font-mono text-xs text-ink-300">{x.key}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{share(x.live)}</td>
                <td className={`px-2 py-1 text-right font-mono ${x.backtest < x.live - 0.15 ? 'text-amber-300' : 'text-ink-400'}`}>{share(x.backtest)}</td>
                <td className={`px-2 py-1 text-right font-mono ${tone(x.agree)}`}>{share(x.agree)}</td>
                <td className="px-4 py-1 text-right font-mono text-ink-400">{rho(x.rho)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="border-t border-ink-800">
        <summary className="cursor-pointer px-4 py-2 text-xs text-ink-400 hover:text-ink-200">Die größten Abstände</summary>
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-1.5 text-left font-normal">Aktie</th>
              <th className="px-2 py-1.5 text-right font-normal">live</th>
              <th className="px-2 py-1.5 text-right font-normal">Daten</th>
              <th className="px-2 py-1.5 text-right font-normal">Backtest</th>
              <th className="px-4 py-1.5 text-left font-normal">am weitesten auseinander</th>
            </tr>
          </thead>
          <tbody>
            {f.gaps.map((g) => (
              <tr key={g.symbol} className="border-b border-ink-800/60 last:border-0">
                <td className="px-4 py-1 font-mono text-ink-200">{g.symbol}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{num(g.live)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{num(g.data)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{num(g.backtest)}</td>
                <td className="px-4 py-1 text-ink-400">
                  {g.pillar && <>{g.pillar.label} <span className="font-mono">{num(g.pillar.live)} → {num(g.pillar.backtest)}</span></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
