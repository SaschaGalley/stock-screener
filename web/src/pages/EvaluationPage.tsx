import ReviewStats from '../components/ReviewStats';
import Tip from '../components/Tip';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { BacktestResponse, EvaluationResponse } from '../types';
import Page, { HeaderButton } from '../components/Page';
import BacktestPanel from '../components/BacktestPanel';
import LiveExpectations from '../components/LiveExpectations';
import VerdictRecordPanel from '../components/VerdictRecordPanel';
import { SignedBar, WeightsTable, evidence, pct } from '../components/evaluationParts';
import { deNumber, fmt, recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';

/**
 * Does a high score come before a better return?
 *
 * The page shows what `pnpm run evaluate` prints, for the one reader who will
 * never open a terminal. It leans hard on the caveats, because the numbers
 * look authoritative long before they are: with a few dozen stocks one day's
 * IC has a standard error near ±0.17, and until there are many independent
 * windows every column here describes the past rather than testing the model.
 *
 * Two cross-sections: the watchlist with every signal, and the universe —
 * watchlist plus reference stocks — with the signals computed from numbers
 * alone, which is where a factor can be measured on hundreds of stocks. And the
 * backtest, which rebuilt the factor score at every month-end since 2013 and
 * so does not have to wait for the months to pass.
 */

const HORIZONS = [5, 20, 60];

type Scope = 'watchlist' | 'universe' | 'backtest' | 'calls' | 'decisions';
/** The scopes that are panels of their own, not views of the score's evaluation. */
const OWN_PANEL: Scope[] = ['calls', 'decisions'];

export default function EvaluationPage() {
  const [data, setData] = useState<EvaluationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState(20);
  // `#/evaluation/decisions` opens on my decisions — the review links there.
  const [scope, setScope] = useState<Scope>(() => (/\/decisions$/.test(window.location.hash) ? 'decisions' : 'watchlist'));
  const [bt, setBt] = useState<BacktestResponse | null>(null);

  useEffect(() => {
    api.getBacktest().then(setBt).catch(() => { /* no backtest is no error */ });
  }, []);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getEvaluation(HORIZONS, fresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const universe = scope === 'universe' && data?.universe ? data.universe : null;
  const ev = universe ?? data?.evaluation;
  const rows = ev?.ics.filter((r) => r.horizon === horizon) ?? [];
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const labels = (ev?.labels.filter((l) => l.horizon === horizon) ?? [])
    .sort((a, b) => RECOMMENDATIONS.indexOf(a.label as never) - RECOMMENDATIONS.indexOf(b.label as never));
  const closedHorizons = new Set(ev?.ics.filter((r) => r.days > 0).map((r) => r.horizon));
  // The universe has no prose, so its headline is the factor score.
  const headlineKey = universe ? 'score.factor.score' : 'score.final.score';
  const headlineTitle = data?.signals.find((s) => s.key === headlineKey)?.title ?? headlineKey;
  const headline = rowOf.get(headlineKey);
  // One day's rank IC over n stocks, under no relationship: about 1/√(n−1),
  // with n the stocks a day actually ranked rather than all that ever scored.
  const perDay = Math.round(headline?.meanCrossSection ?? ev?.symbols ?? 0);
  const dailyNoise = perDay > 1 ? 1 / Math.sqrt(perDay - 1) : null;

  return (
    <Page
      title="Auswertung"
      subtitle={ev ? <>
        Scores {ev.from ?? '—'} bis {ev.to ?? '—'} · {ev.symbols} Aktien
        {data && ` · berechnet ${new Date(data.computedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`}
      </> : 'Sagt der Score die spätere Rendite voraus?'}
      actions={
        <HeaderButton onClick={() => void load(true)} disabled={loading}>
          {loading ? 'Rechne …' : 'Neu berechnen'}
        </HeaderButton>
      }
    >

      {!OWN_PANEL.includes(scope) && <p className="text-sm leading-relaxed text-ink-300">
        Sortiert an jedem Handelstag alle Aktien nach dem Score, den sie <em>vorher</em> hatten, und nach
        ihrer Rendite gegenüber dem S&amp;P 500 in den folgenden Handelstagen — in Dollar, damit eine
        Euro-Aktie nicht mit dem Wechselkurs punktet — und misst, wie gut die beiden Reihenfolgen
        übereinstimmen (Rang-IC: +1 perfekt, 0 kein Zusammenhang, −1 umgekehrt). Ein brauchbarer Faktor
        liegt bei 0,03–0,08.{dailyNoise !== null && ` Mit ${perDay} Aktien je Tag schwankt ein einzelner Tag um etwa ±${deNumber(dailyNoise, 2)}`}
        {' '}— belastbar wird das erst nach vielen unabhängigen Zeitfenstern, also nach Monaten.
        „Im Sektor“ vergleicht jede Aktie nur mit ihrem eigenen Sektor: was dort bleibt, ist Aktienauswahl
        statt einer Wette auf die Branche.
      </p>}

      {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
      {!data && loading && scope !== 'backtest' && !OWN_PANEL.includes(scope) && (
        <div className="p-8 text-center text-sm text-ink-500">
          Lade Kurse und rechne — mit dem Referenzuniversum dauert der erste Aufruf ein bis zwei Minuten…
        </div>
      )}

      {(data || bt || OWN_PANEL.includes(scope)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-400">Aktien</span>
          {([
            ...(data ? [['watchlist', `Watchlist (${data.evaluation.symbols})`, 'Alle Signale, auch Text und alter LLM-Score']] : []),
            ...(data?.universe ? [['universe', `Universum (${data.universe.symbols})`, 'Watchlist + Referenzaktien, nur die aus Zahlen berechneten Signale']] : []),
            ...(bt ? [['backtest', `Backtest (${bt.backtest?.universe ?? 'S&P 500'} seit 2013)`, 'Faktor-Score an jedem Monatsende aus den SEC-Abschlüssen nachgerechnet']] : []),
            ['calls', 'Unsere Urteile', 'Jeder Urteilswechsel gegen den Index danach: Trefferquote nach 1, 3, 6 und 12 Monaten'],
            ['decisions', 'Meine Entscheidungen', 'Meine Käufe und Verkäufe in Gruppen gegen den Index danach: nach einem Sprung, gegen das Modell, ohne Begründung'],
          ] as [Scope, string, string][]).map(([s, label, hint]) => (
            <Tip key={s} focusable={false} content={hint}>
              <button
                onClick={() => setScope(s)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  s === scope ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
                }`}
              >
                {label}
              </button>
            </Tip>
          ))}
        </div>
      )}

      {scope === 'backtest' && bt && <BacktestPanel data={bt} />}
      {scope === 'calls' && <VerdictRecordPanel />}
      {scope === 'decisions' && <ReviewStats />}

      {scope !== 'backtest' && !OWN_PANEL.includes(scope) && ev && (
        <>
          {universe && data?.monthly && <LiveExpectations monthly={data.monthly} bt={bt?.backtest ?? null} />}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-ink-400">Horizont</span>
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  h === horizon ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
                } ${closedHorizons.has(h) ? '' : 'opacity-50'}`}
                title={closedHorizons.has(h) ? undefined : 'Noch kein Zeitfenster dieser Länge abgeschlossen'}
              >
                {h} Handelstage
              </button>
            ))}
          </div>

          {headline && headline.days > 0 && (
            <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-ink-200">
              {headlineTitle} über {horizon} Handelstage: Rang-IC <span className="font-mono">{fmt(headline.meanIc, '', 2)}</span>
              {headline.neutralIc !== null && <>, im Sektor <span className="font-mono">{deNumber(headline.neutralIc, 2)}</span></>},
              im oberen Drittel {pct(headline.spread)} gegenüber dem unteren ·{' '}
              <span className={evidence(headline.tStat, headline.independent).cls}>
                {evidence(headline.tStat, headline.independent).label}
              </span>{' '}
              <span className="text-ink-500">({headline.independent} unabhängige Fenster)</span>
            </div>
          )}

          <section className="rounded-lg border border-ink-700 bg-ink-900">
            <header className="border-b border-ink-800 px-4 py-2.5">
              <h3 className="text-xs font-semibold text-ink-300">Signale</h3>
              <p className="mt-0.5 text-xs text-ink-500">
                IC gemittelt über alle Tage · t nur aus nicht überlappenden Fenstern · Im Sektor = IC gegen den eigenen Sektor ·
                Treffer = Anteil der Tage mit positivem IC · Oben−Unten = Mehrrendite oberes minus unteres Drittel
              </p>
            </header>
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
                    <th className="px-2 py-2 text-right font-normal">Tage / unabh.</th>
                    <th className="px-4 py-2 text-left font-normal">Aussagekraft</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.signals.map((s) => {
                    const r = rowOf.get(s.key);
                    if (!r || r.days === 0) return null;
                    const e = evidence(r.tStat, r.independent);
                    return (
                      <tr key={s.key} className="border-b border-ink-800/60 last:border-0">
                        <td className={`px-4 py-1.5 ${s.pillar ? 'pl-8 text-ink-300' : 'font-medium text-ink-100'}`}>{s.title}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmt(r.meanIc, '', 2)}</td>
                        <td className="px-2 py-1.5"><SignedBar value={r.meanIc} scale={0.3} /></td>
                        <td className="px-2 py-1.5 text-right font-mono text-ink-300">{fmt(r.tStat, '', 1)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-300">
                          {r.neutralIc === null ? '—' : deNumber(r.neutralIc, 2)}
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
              {rows.every((r) => r.days === 0) && (
                <div className="p-6 text-center text-sm text-ink-500">
                  Noch kein Zeitfenster von {horizon} Handelstagen abgeschlossen.
                </div>
              )}
            </div>
          </section>

          {labels.length > 0 && (
            <section className="rounded-lg border border-ink-700 bg-ink-900">
              <header className="border-b border-ink-800 px-4 py-2.5">
                <h3 className="text-xs font-semibold text-ink-300">Mehrrendite nach Urteil</h3>
                <p className="mt-0.5 text-xs text-ink-500">
                  Durchschnittliche Rendite gegenüber dem S&amp;P 500 über {horizon} Handelstage, nur nicht überlappende Fenster ·
                  in Klammern die Zahl der Aktien-Fenster
                </p>
              </header>
              <div className="space-y-2 p-4">
                {labels.map((l) => (
                  <div key={l.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
                    <span className={`rounded px-2 py-0.5 text-center text-xs font-bold ${recommendationColor(l.label)}`}>{l.label}</span>
                    <SignedBar value={l.meanExcess} scale={0.1} />
                    <span className="whitespace-nowrap text-right font-mono text-ink-300">
                      {pct(l.meanExcess)} <span className="text-ink-500">({l.count})</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data && data.weights.length > 0 && (
            <section className="rounded-lg border border-ink-700 bg-ink-900">
              <header className="border-b border-ink-800 px-4 py-2.5">
                <h3 className="text-xs font-semibold text-ink-300">Säulengewichte: was die Daten nahelegen</h3>
                <p className="mt-0.5 text-xs text-ink-500">
                  IC jeder Säule über {data.weightHorizon} Handelstage{data.universe ? ' im Universum' : ''}, um seinen Standardfehler
                  zur Null geschrumpft; ein Gewicht kippt um den geschrumpften IC geteilt durch 0,05. Nur ein Vorschlag —
                  geändert werden die Gewichte im Code, nicht hier.
                </p>
              </header>
              <WeightsTable weights={data.weights} />
            </section>
          )}

          <p className="text-xs leading-relaxed text-ink-500">
            Die Scores vor dem Einbau des aktuellen Modells sind mit den heutigen Regeln nachgerechnet: die Daten sind
            die damaligen.{' '}
            {bt?.inForce.fit
              ? `Die Gewichte sind an den Renditen des Backtests bis ${new Date(bt.inForce.fit.to).toLocaleDateString('de-DE')} `
                + 'angepasst — für die Monate davor ist dies kein unabhängiger Test, erst die danach sind es.'
              : 'Die Regeln sind nicht an Renditen angepasst — sobald sie das werden, ist dies kein Test mehr.'}{' '}
            Eine Reihe, die endet (z. B. der alte LLM-Score), zählt nur zehn Tage über ihren letzten Wert hinaus.
          </p>
        </>
      )}
    </Page>
  );
}
