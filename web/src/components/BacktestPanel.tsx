import { useState } from 'react';
import type { BacktestResponse } from '../types';
import { recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';
import { IcTable, SignedBar, WeightsTable, evidence, pct } from './evaluationParts';

type Backtest = NonNullable<BacktestResponse['backtest']>;

/** How the backtest names a criterion's own signal (`backtest/run.ts`). */
const CRITERION_PREFIX = 'criterion.';

/** Pillar titles for the weight table, from the signal list the server sends. */
function withTitles(weights: Backtest['weights'], signals: BacktestResponse['signals']) {
  return weights.map((w) => ({
    ...w, title: signals.find((s) => s.key === `score.factor.pillars.${w.key}.score`)?.title ?? w.key,
  }));
}

/**
 * The factor score rebuilt at every month-end since 2013 from the SEC's filings
 * and judged on the months that followed — what the live evaluation will only
 * be able to say in a year or two, said now, with its limits in view.
 */
export default function BacktestPanel({ data }: { data: BacktestResponse }) {
  const bt = data.backtest;
  const horizons = [...new Set(bt?.evaluation.ics.map((r) => r.horizon) ?? [])].sort((a, b) => a - b);
  const [horizon, setHorizon] = useState(horizons[0] ?? 1);

  if (!bt) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-6 text-center text-sm text-ink-400">
        Noch kein Backtest gerechnet — <span className="font-mono">pnpm run backtest</span> rechnet ihn
        (einmalig einige Minuten, danach aus dem Cache).
      </div>
    );
  }

  const rows = bt.evaluation.ics.filter((r) => r.horizon === horizon);
  // Each criterion's own figure, turned so that more is better, as the backtest evaluates it.
  const criterionRows = rows.filter((r) => r.key.startsWith(CRITERION_PREFIX) && (r.meanCrossSection ?? 0) >= 30)
    .sort((a, b) => (b.meanIc ?? -1) - (a.meanIc ?? -1));
  const criterionSignals = criterionRows.map((r) => ({ key: r.key, title: r.key.slice(CRITERION_PREFIX.length), pillar: false }));
  const headline = rows.find((r) => r.key === 'score.factor.score');
  const labels = bt.evaluation.labels.filter((l) => l.horizon === horizon)
    .sort((a, b) => RECOMMENDATIONS.indexOf(a.label as never) - RECOMMENDATIONS.indexOf(b.label as never));
  const monthName = (h: number) => (h === 1 ? '1 Monat' : `${h} Monate`);

  return (
    <>
      <p className="text-[11px] leading-relaxed text-ink-400">
        S&amp;P 500, Monatsenden {bt.from} bis {bt.to} · {bt.months} Stichtage · {bt.companies} Firmen ·
        Prämienkorrektur im Median {(bt.premium.median * 100).toFixed(2).replace('.', ',')} Pkt. ·
        gerechnet {new Date(bt.generatedAt).toLocaleDateString('de-DE')}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-ink-400">Horizont</span>
        {horizons.map((h) => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className={`rounded px-2.5 py-1 text-xs transition ${
              h === horizon ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
            }`}
          >
            {monthName(h)}
          </button>
        ))}
      </div>

      {headline && headline.days > 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-ink-200">
          Faktor-Score über {monthName(horizon)}: Rang-IC <span className="font-mono">{headline.meanIc?.toFixed(3)}</span>
          {headline.neutralIc !== null && <>, im Sektor <span className="font-mono">{headline.neutralIc.toFixed(3)}</span></>},
          oberes Drittel {pct(headline.spread)} gegenüber dem unteren je Monat ·{' '}
          <span className={evidence(headline.tStat, headline.independent).cls}>
            {evidence(headline.tStat, headline.independent).label}
          </span>{' '}
          <span className="text-ink-500">(t {headline.tStat?.toFixed(1) ?? '—'}, {headline.independent} unabhängige Fenster)</span>
        </div>
      )}

      <section className="rounded-lg border border-ink-700 bg-ink-900">
        <header className="border-b border-ink-800 px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Signale im Backtest</h3>
        </header>
        <IcTable signals={data.signals} rows={rows} periodLabel="Monate" />
      </section>

      {criterionSignals.length > 0 && (
        <section className="rounded-lg border border-ink-700 bg-ink-900">
          <header className="border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Einzelkriterien</h3>
            <p className="mt-0.5 text-[11px] text-ink-500">
              Jede Kennzahl für sich, so gedreht, dass mehr besser ist — ein positiver IC heißt: das Kriterium wirkt in die
              Richtung, in der der Score es liest. Nur Kriterien mit mindestens 30 Aktien je Stichtag.
            </p>
          </header>
          <IcTable signals={criterionSignals} rows={criterionRows} periodLabel="Monate" />
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-ink-700 bg-ink-900">
          <header className="border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Faktor-Score je Jahr (1 Monat)</h3>
          </header>
          <table className="w-full text-sm">
            <thead className="text-[11px] text-ink-400">
              <tr className="border-b border-ink-800">
                <th className="px-4 py-1.5 text-left font-normal">Jahr</th>
                <th className="px-2 py-1.5 text-right font-normal">IC</th>
                <th className="w-28 px-2 py-1.5 font-normal" />
                <th className="px-4 py-1.5 text-right font-normal">Im Sektor</th>
              </tr>
            </thead>
            <tbody>
              {bt.byYear.map((y) => (
                <tr key={y.year} className="border-b border-ink-800/60 last:border-0">
                  <td className="px-4 py-1 font-mono text-ink-300">{y.year}</td>
                  <td className="px-2 py-1 text-right font-mono">{y.ic?.toFixed(3) ?? '—'}</td>
                  <td className="px-2 py-1"><SignedBar value={y.ic} scale={0.1} /></td>
                  <td className="px-4 py-1 text-right font-mono text-ink-300">{y.neutralIc?.toFixed(3) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {labels.length > 0 && (
          <section className="rounded-lg border border-ink-700 bg-ink-900">
            <header className="border-b border-ink-800 px-4 py-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Mehrrendite nach Faktor-Urteil</h3>
            </header>
            <div className="space-y-2 p-4">
              {labels.map((l) => (
                <div key={l.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
                  <span className={`rounded px-2 py-0.5 text-center text-[11px] font-bold ${recommendationColor(l.label)}`}>{l.label}</span>
                  <SignedBar value={l.meanExcess} scale={0.03} />
                  <span className="whitespace-nowrap text-right font-mono text-ink-300">
                    {pct(l.meanExcess)} <span className="text-ink-500">({l.count})</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <section className="rounded-lg border border-ink-700 bg-ink-900">
        <header className="border-b border-ink-800 px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Säulengewichte laut Backtest</h3>
          <p className="mt-0.5 text-[11px] text-ink-500">
            IC über {monthName(bt.weightHorizon)}, um seinen Standardfehler geschrumpft. Konsens und Erwartungen sind im Backtest
            nicht messbar und behalten ihr Gewicht. Nur ein Vorschlag — geändert wird im Code.
          </p>
        </header>
        <WeightsTable weights={withTitles(bt.weights, data.signals)} />
      </section>

      <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-ink-500">
        {bt.caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </>
  );
}
