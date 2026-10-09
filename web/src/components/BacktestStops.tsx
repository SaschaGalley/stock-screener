import { useState } from 'react';
import type { BacktestResponse } from '../types';
import Tip from './Tip';
import { STOP_GROUPS, STOP_HORIZONS, STOP_RULES, type StopRow } from '../../../src/analysis/stop-study';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const pct = (v: number | null | undefined, d = 1) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const share = (v: number) => `${Math.round(v * 100)} %`;
/** A difference of returns, in points. */
const pts = (v: number | null | undefined) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).replace('.', ',')} Prozentpunkte`);
const num = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1).replace('.', ',').replace('-', '−'));
const VERDICT: Record<string, string> = {
  'bringt mehr': 'text-emerald-400', 'kostet': 'text-red-400', 'trägt': 'text-emerald-400', 'falsch herum': 'text-red-400', 'nicht belegt': 'text-ink-400',
};
const LIST_LABEL = {
  reduce: { title: 'Reduzieren ansehen', among: 'Score unter 5', chosen: 'Chart fällt', right: 'die Hälfte mit fallendem Chart läuft schlechter' },
  buy:    { title: 'Kaufen ansehen', among: 'BUY und STRONG BUY', chosen: 'Chart steigt', right: 'die Hälfte mit steigendem Chart läuft besser' },
} as const;

/** One sentence per exit over all stocks: what it did to the average and to the worst outcomes. */
function lead(rows: StopRow[], h: number): string[] {
  return STOP_RULES.flatMap((rule) => {
    const x = rows.find((r) => r.rule === rule.key && r.group === 'all' && r.horizon === h);
    if (!x || x.diff.mean === null) return [];
    const avg = x.verdict === 'nicht belegt'
      ? `im Schnitt ${pts(x.diff.mean)} gegenüber Halten, nicht von Zufall zu unterscheiden`
      : `im Schnitt ${pts(x.diff.mean)} gegenüber Halten (t ${num(x.diff.t)}, in beiden Hälften der Jahre)`;
    const viaIndex = x.diffIndex?.mean != null ? `, mit dem Geld danach im Index ${pts(x.diffIndex.mean)}` : '';
    return [`${rule.label}, ausgelöst bei ${share(x.stopped)} der Positionen: ${avg}${viaIndex}; das schlechteste Zwanzigstel `
      + `${pct(x.p05Hold, 0)} → ${pct(x.p05Rule, 0)}, Verluste ab 20 % bei ${share(x.deepHold)} → ${share(x.deepRule)} der Positionen.`];
  });
}

/**
 * The depot check's stops and lists put to the backtest: what each exit did
 * to holding, on average and at the bad end, and whether the two lists pick
 * the half they claim to.
 */
export default function BacktestStops({ bt }: { bt: Backtest }) {
  const st = bt.stops;
  const [h, setH] = useState<(typeof STOP_HORIZONS)[number]>(6);
  if (!st) return null;
  const rows = st.rows.filter((r) => r.horizon === h);
  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xs font-semibold text-ink-300">Stops und die Listen des Depot-Checks</h3>
          <div className="flex gap-1">
            {STOP_HORIZONS.map((x) => (
              <button
                key={x}
                onClick={() => setH(x)}
                className={`rounded px-2 py-0.5 text-2xs ${x === h ? 'bg-accent text-ink-950' : 'border border-ink-700 text-ink-300 hover:bg-ink-800'}`}
              >
                {x} Monate
              </button>
            ))}
          </div>
        </div>
        <ul className="mt-1.5 space-y-0.5 text-xs text-ink-200">
          {lead(st.rows, h).map((x) => <li key={x}>{x}</li>)}
        </ul>
        <p className="mt-1 text-xs text-ink-500">
          An jedem dritten Monatsende ist jede Aktie eine gehaltene Position ({st.records.toLocaleString('de-DE')} insgesamt), mit den Marken, die der
          Depot-Check an dem Tag gegeben hätte. Ausgestoppt liegt das Geld bis zum Ende des Fensters bar. Nur Schlusskurse: Ein Stop greift beim
          ersten Schluss auf oder unter der Marke, zu diesem Schluss. Dividenden eingerechnet. „bringt mehr“ oder „kostet“: Unterschied zu Halten mit
          |t| ≥ 2 und in beiden Hälften der Jahre gleich gerichtet, gemessen nur an jedem {h === 6 ? 'sechsten' : 'dritten'} Monat, damit sich die
          Fenster nicht überlappen — vor dem ersten Lauf so festgelegt.
        </p>
      </header>
      <table className="w-full min-w-[1040px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Ausstieg · Gruppe</th>
            <th className="px-2 py-1.5 text-right font-normal">Positionen</th>
            <th className="px-2 py-1.5 text-right font-normal"><Tip content="Anteil, den die Regel vorzeitig schloss, und nach wie vielen Handelstagen im Schnitt"><span>ausgestoppt</span></Tip></th>
            <th className="px-2 py-1.5 text-right font-normal">Halten</th>
            <th className="px-2 py-1.5 text-right font-normal">mit Regel</th>
            <th className="px-2 py-1.5 text-right font-normal"><Tip content="Regel minus Halten, Mittel der Monate, mit t"><span>Unterschied (t)</span></Tip></th>
            <th className="px-2 py-1.5 text-right font-normal">bis 2019 / ab 2020</th>
            <th className="px-2 py-1.5 text-right font-normal"><Tip content="Derselbe Unterschied, wenn das Geld nach dem Stop bis zum Ende des Fensters im Index liegt (SPY, mit Dividenden). Nach dem ersten Lauf ergänzt, um die Kosten des Stops vom verpassten Markt zu trennen; gezeigt, nicht bewertet."><span>danach Index</span></Tip></th>
            <th className="px-2 py-1.5 text-right font-normal"><Tip content="Rendite des schlechtesten Zwanzigstels der Positionen, Halten → mit Regel"><span>schlechteste 5 %</span></Tip></th>
            <th className="px-2 py-1.5 text-right font-normal"><Tip content="Anteil der Positionen mit 20 % Verlust oder mehr, Halten → mit Regel"><span>−20 % und tiefer</span></Tip></th>
            <th className="px-4 py-1.5 text-right font-normal">Urteil</th>
          </tr>
        </thead>
        <tbody>
          {STOP_RULES.map((rule) => (
            <RuleRows key={rule.key} label={rule.label} idea={rule.idea} rows={rows.filter((r) => r.rule === rule.key)} />
          ))}
        </tbody>
      </table>

      <div className="border-t border-ink-800 px-4 py-2.5">
        <h4 className="text-xs font-semibold text-ink-300">Die beiden Listen</h4>
        <p className="mt-0.5 text-xs text-ink-500">
          Innerhalb der Gruppe die Hälfte, die die Liste wählt, gegen den Rest, in Mehrrendite gegenüber der durchschnittlichen Aktie des Monats.
          Der Chart ist die gerechnete Trend-Lesung, die auch der Wächter nutzt; die Lesung des Modells im Depot-Check hat keine Geschichte.
        </p>
      </div>
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Liste</th>
            <th className="px-2 py-1.5 text-right font-normal">nach</th>
            <th className="px-2 py-1.5 text-right font-normal">gewählt</th>
            <th className="px-2 py-1.5 text-right font-normal">Rest</th>
            <th className="px-2 py-1.5 text-right font-normal">Unterschied (t)</th>
            <th className="px-2 py-1.5 text-right font-normal">bis 2019 / ab 2020</th>
            <th className="px-4 py-1.5 text-right font-normal">Urteil</th>
          </tr>
        </thead>
        <tbody>
          {st.lists.map((x) => {
            const l = LIST_LABEL[x.rule];
            return (
              <tr key={`${x.rule}-${x.horizon}`} className="border-b border-ink-800/60 last:border-0">
                <td className="px-4 py-1 text-ink-200">
                  {l.title} <span className="text-2xs text-ink-500">· {l.among}, {l.chosen}; richtig, wenn {l.right}</span>
                </td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{x.horizon} M</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.chosen.mean, 2)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.rest.mean, 2)}</td>
                <td className={`px-2 py-1 text-right font-mono ${Math.abs(x.diff.t ?? 0) >= 2 ? 'font-semibold text-ink-100' : 'text-ink-300'}`}>
                  {pct(x.diff.mean, 2)} <span className="text-2xs font-normal text-ink-500">({num(x.diff.t)}, {x.diff.months} M)</span>
                </td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{pct(x.first.mean, 2)} / {pct(x.second.mean, 2)}</td>
                <td className={`px-4 py-1 text-right ${VERDICT[x.verdict]}`}>{x.verdict}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function RuleRows({ label, idea, rows }: { label: string; idea: string; rows: StopRow[] }) {
  return (
    <>
      <tr className="border-b border-ink-800/60 bg-ink-950/40">
        <td colSpan={11} className="px-4 py-1 text-xs font-semibold text-ink-200">{label} <span className="font-normal text-ink-500">· {idea}</span></td>
      </tr>
      {STOP_GROUPS.map((g) => {
        const x = rows.find((r) => r.group === g.key);
        if (!x || x.trades === 0) return null;
        return (
          <tr key={g.key} className="border-b border-ink-800/60 last:border-0">
            <td className="px-4 py-1 pl-6 text-ink-300">{g.label}</td>
            <td className="px-2 py-1 text-right font-mono text-ink-400">{x.trades.toLocaleString('de-DE')}</td>
            <td className="px-2 py-1 text-right font-mono text-ink-400">{share(x.stopped)} <span className="text-2xs text-ink-500">nach {x.sessions?.toFixed(0) ?? '—'} T</span></td>
            <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.hold)}</td>
            <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.ruled)}</td>
            <td className={`px-2 py-1 text-right font-mono ${Math.abs(x.diff.t ?? 0) >= 2 ? 'font-semibold text-ink-100' : 'text-ink-300'}`}>
              {pct(x.diff.mean, 2)} <span className="text-2xs font-normal text-ink-500">({num(x.diff.t)})</span>
            </td>
            <td className="px-2 py-1 text-right font-mono text-ink-400">{pct(x.first.mean, 2)} / {pct(x.second.mean, 2)}</td>
            <td className="px-2 py-1 text-right font-mono text-ink-400">
              {x.diffIndex ? <>{pct(x.diffIndex.mean, 2)} <span className="text-2xs text-ink-500">({num(x.diffIndex.t)})</span></> : '—'}
            </td>
            <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.p05Hold, 0)} → {pct(x.p05Rule, 0)}</td>
            <td className="px-2 py-1 text-right font-mono text-ink-300">{share(x.deepHold)} → {share(x.deepRule)}</td>
            <td className={`px-4 py-1 text-right ${VERDICT[x.verdict]}`}>{x.verdict}</td>
          </tr>
        );
      })}
    </>
  );
}
