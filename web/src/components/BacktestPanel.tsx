import { useState } from 'react';
import type { BacktestResponse } from '../types';
import { recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';
import { IcTable, SignedBar, evidence, pct } from './evaluationParts';
import WeightFit from './WeightFit';
import BacktestRuns, { BacktestStatusLine, useBacktestOverview } from './BacktestRuns';
import BacktestBands from './BacktestBands';
import BacktestVariants from './BacktestVariants';
import { INSIDER_CANDIDATES } from '../../../src/analysis/insider-signals';

type Backtest = NonNullable<BacktestResponse['backtest']>;

/** How the backtest names a criterion's own signal, and a candidate's (`backtest/run.ts`). */
const CRITERION_PREFIX = 'criterion.';
const CANDIDATE_PREFIX = 'candidate.';
const CANDIDATE_TITLE = new Map(INSIDER_CANDIDATES.map((c) => [`${CANDIDATE_PREFIX}${c.key}`, c.title]));

/**
 * The factor score rebuilt at every month-end since 2013 from the SEC's filings
 * and judged on the months that followed — what the live evaluation will only
 * be able to say in a year or two, said now, with its limits in view.
 */
export default function BacktestPanel({ data }: { data: BacktestResponse }) {
  const bt = data.backtest;
  const horizons = [...new Set(bt?.evaluation.ics.map((r) => r.horizon) ?? [])].sort((a, b) => a - b);
  const [horizon, setHorizon] = useState(horizons[0] ?? 1);
  const overview = useBacktestOverview();

  if (!bt) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-6 text-center text-sm text-ink-400">
        Noch kein Backtest gerechnet. Er läuft einmal im Monat von selbst; sofort unter Administration → Backtest →
        „Jetzt rechnen“ (beim ersten Mal rund eine Stunde, danach eine Viertelstunde).
      </div>
    );
  }

  const rows = bt.evaluation.ics.filter((r) => r.horizon === horizon);
  // Each criterion's own figure, turned so that more is better, as the backtest evaluates it.
  const criterionRows = rows.filter((r) => r.key.startsWith(CRITERION_PREFIX) && (r.meanCrossSection ?? 0) >= 30)
    .sort((a, b) => (b.meanIc ?? -1) - (a.meanIc ?? -1));
  const criterionSignals = criterionRows.map((r) => ({ key: r.key, title: r.key.slice(CRITERION_PREFIX.length), pillar: false }));
  const headline = rows.find((r) => r.key === 'score.factor.score');
  const candidateRows = rows.filter((r) => r.key.startsWith(CANDIDATE_PREFIX));
  const candidateSignals = candidateRows.map((r) => ({ key: r.key, title: CANDIDATE_TITLE.get(r.key) ?? r.key, pillar: false }));
  const segmentSignals = [...data.signals, ...candidateSignals];
  const labels = bt.evaluation.labels.filter((l) => l.horizon === horizon)
    .sort((a, b) => RECOMMENDATIONS.indexOf(a.label as never) - RECOMMENDATIONS.indexOf(b.label as never));
  const monthName = (h: number) => (h === 1 ? '1 Monat' : `${h} Monate`);
  const withConsensus = bt.byYear.some((y) => y.analysts != null);

  return (
    <>
      <p className="text-xs leading-relaxed text-ink-400">
        {bt.universe ?? 'S&P 500'}, Monatsenden {bt.from} bis {bt.to} · {bt.months} Stichtage · {bt.companies} Firmen
        {bt.departed && <> (davon {bt.departed.included} der {bt.departed.departed} seither ausgeschiedenen)</>} ·
        Prämienkorrektur im Median {(bt.premium.median * 100).toFixed(2).replace('.', ',')} Pkt. ·
        gerechnet {new Date(bt.generatedAt).toLocaleDateString('de-DE')}
        {overview.data?.schedule.next && <> · nächster Lauf {new Date(overview.data.schedule.next).toLocaleDateString('de-DE')}</>}
      </p>
      {overview.data?.running && <p className="text-xs"><BacktestStatusLine o={overview.data} /></p>}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-ink-400">Horizont</span>
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

      <BacktestBands bt={bt} horizon={horizon} monthName={monthName} />
      <BacktestVariants bt={bt} horizon={horizon} monthName={monthName} />

      {candidateSignals.length > 0 && (
        <section className="rounded-lg border border-ink-700 bg-ink-900">
          <header className="border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Kandidaten — noch nicht im Score</h3>
            <p className="mt-0.5 text-xs text-ink-500">
              Signale, die keine Säule liest, auf dieselbe Probe gestellt, bevor jemand ein Gewicht für sie vorschlägt: die
              Käufe und Verkäufe der Insider am offenen Markt aus ihren Form-4-Meldungen, ab dem Tag der Meldung. Die
              meisten Werte haben in einem halben Jahr keinen Insider-Kauf; bei so vielen Gleichständen gibt es ein unteres
              Drittel nur in Monaten mit sehr vielen Käufern, und „Oben−Unten“ sagt nichts — maßgeblich ist der Rang-IC.
            </p>
          </header>
          <IcTable signals={candidateSignals} rows={candidateRows} periodLabel="Monate" />
        </section>
      )}

      {(bt.segments?.length ?? 0) > 0 && (
        <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
          <header className="border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Nach Indexgröße</h3>
            <p className="mt-0.5 text-xs text-ink-500">
              Dieselben Signale nur unter Large, Mid oder Small Caps gerankt — was die großen Werte einpreisen, kann weiter
              unten noch wirken. Rang-IC über {monthName(horizon)}, in Klammern t.
            </p>
          </header>
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-xs text-ink-400">
              <tr className="border-b border-ink-800">
                <th className="px-4 py-1.5 text-left font-normal">Signal</th>
                {bt.segments!.map((s) => (
                  <th key={s.key} className="px-2 py-1.5 text-right font-normal">{s.label} <span className="text-ink-500">({s.companies})</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {segmentSignals.map((sig) => (
                <tr key={sig.key} className="border-b border-ink-800/60 last:border-0">
                  <td className={`px-4 py-1 ${sig.pillar ? 'pl-8 text-ink-300' : 'font-medium text-ink-100'}`}>{sig.title}</td>
                  {bt.segments!.map((s) => {
                    const r = s.ics.find((x) => x.key === sig.key && x.horizon === horizon);
                    if (!r || r.days === 0) return <td key={s.key} className="px-2 py-1 text-right text-ink-600">—</td>;
                    return (
                      <td key={s.key} className={`whitespace-nowrap px-2 py-1 text-right font-mono ${evidence(r.tStat, r.independent).cls}`}>
                        {r.meanIc?.toFixed(3) ?? '—'} <span className="text-ink-500">({r.tStat?.toFixed(1) ?? '—'})</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {criterionSignals.length > 0 && (
        <section className="rounded-lg border border-ink-700 bg-ink-900">
          <header className="border-b border-ink-800 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Einzelkriterien</h3>
            <p className="mt-0.5 text-xs text-ink-500">
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
            <thead className="text-xs text-ink-400">
              <tr className="border-b border-ink-800">
                <th className="px-4 py-1.5 text-left font-normal">Jahr</th>
                <th className="px-2 py-1.5 text-right font-normal">IC</th>
                <th className="w-28 px-2 py-1.5 font-normal" />
                <th className="px-4 py-1.5 text-right font-normal">Im Sektor</th>
                {withConsensus && (
                  <th className="px-4 py-1.5 text-right font-normal" title="Anteil der Aktien-Monate mit rekonstruiertem Konsens-Kursziel">
                    Konsens
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {bt.byYear.map((y) => (
                <tr key={y.year} className="border-b border-ink-800/60 last:border-0">
                  <td className="px-4 py-1 font-mono text-ink-300">{y.year}</td>
                  <td className="px-2 py-1 text-right font-mono">{y.ic?.toFixed(3) ?? '—'}</td>
                  <td className="px-2 py-1"><SignedBar value={y.ic} scale={0.1} /></td>
                  <td className="px-4 py-1 text-right font-mono text-ink-300">{y.neutralIc?.toFixed(3) ?? '—'}</td>
                  {withConsensus && (
                    <td className="px-4 py-1 text-right font-mono text-ink-400">
                      {y.analysts != null ? `${Math.round(y.analysts * 100)} %` : '—'}
                    </td>
                  )}
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
                  <span className={`rounded px-2 py-0.5 text-center text-xs font-bold ${recommendationColor(l.label)}`}>{l.label}</span>
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

      {bt.fit && <WeightFit v={bt.fit} inForce={data.inForce} />}

      {overview.data && <BacktestRuns o={overview.data} />}

      <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-ink-500">
        {bt.caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </>
  );
}
