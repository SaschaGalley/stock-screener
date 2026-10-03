import type { BacktestResponse, EvaluationResponse } from '../types';
import { recommendationColor } from '../format';
import { RECOMMENDATIONS } from '../../../src/verdict';
import { DECISIVE_T, EXPECTATIONS_REGISTERED, MIN_UNIVERSE_STOCKS, MIN_WINDOWS } from '../../../src/backtest/expectations';

type Monthly = NonNullable<EvaluationResponse['monthly']>;
type Backtest = NonNullable<BacktestResponse['backtest']>;

const num = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d).replace('.', ',').replace('-', '−'));
const pct = (v: number | null | undefined, d = 1) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
/** An IC reads as a coefficient, everything else as a return. */
const value = (measure: string, v: number | null | undefined) => (measure === 'ic' ? num(v, 3) : pct(v));

const STATUS: Record<string, string> = {
  'zu früh':   'text-ink-500',
  offen:       'text-amber-300',
  bestätigt:   'text-emerald-400',
  widerlegt:   'text-red-400',
};

function years(months: number): string {
  return months < 24 ? `${months} Monate` : `≈ ${Math.round(months / 12)} Jahre`;
}

/**
 * The live universe at month-ends, beside the backtest: the expectations
 * written down before these months came in, each judged by the rule fixed
 * with it, and the verdicts' bands live and rebuilt.
 */
export default function LiveExpectations({ monthly, bt }: { monthly: Monthly; bt: Backtest | null }) {
  const horizons = [...new Set(monthly.ics.map((r) => r.horizon))].sort((a, b) => a - b);
  const btIc = (h: number) => bt?.evaluation.ics.find((r) => r.key === 'score.factor.score' && r.horizon === h);
  const liveBand = (v: string, h: number) => monthly.verdicts.find((r) => r.bucket === v && r.horizon === h);
  const btBand = (v: string, h: number) => bt?.bands?.verdicts.find((r) => r.bucket === v && r.horizon === h);
  const registered = new Date(EXPECTATIONS_REGISTERED).toLocaleDateString('de-DE');

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">
          Live gegen Backtest
          <span className="font-normal normal-case text-ink-500"> · {monthly.months.length} {monthly.months.length === 1 ? 'Monatsende' : 'Monatsenden'} mit dem Universum</span>
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Was der Backtest erwarten lässt, festgeschrieben am {registered}, bevor einer der Monate abgeschlossen war, die es prüfen.
          Es zählen nur Monatsenden, an denen mindestens {MIN_UNIVERSE_STOCKS} Aktien bewertet waren, nicht die Watchlist allein.
          Die Regel steht mit fest: unter {MIN_WINDOWS} unabhängigen Fenstern zu früh, {DECISIVE_T} Standardfehler in der erwarteten
          Richtung bestätigt, {DECISIVE_T} dagegen widerlegt, dazwischen offen. „Frühestens“ ist, wie lange ein Effekt in der Größe des
          Backtests bei dessen Streuung braucht — das Live-Universum ist kleiner, eher länger. Schneller als bestätigen kann es
          widersprechen.
        </p>
      </header>

      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Erwartung</th>
            <th className="px-2 py-1.5 text-right font-normal">Backtest</th>
            <th className="px-2 py-1.5 text-right font-normal">Live</th>
            <th className="px-2 py-1.5 text-right font-normal" title="95-%-Intervall des Live-Mittels">Intervall</th>
            <th className="px-2 py-1.5 text-left font-normal">Stand</th>
            <th className="px-4 py-1.5 text-right font-normal">frühestens</th>
          </tr>
        </thead>
        <tbody>
          {monthly.expectations.map((e) => (
            <tr key={e.key} className="border-b border-ink-800/60 align-top last:border-0">
              <td className="px-4 py-1.5 text-ink-200">{e.claim}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-400">
                {value(e.measure, e.backtest.value)} <span className="text-ink-500">(t {num(e.backtest.t, 1)})</span>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-300">
                {value(e.measure, e.live.mean)}{' '}
                <span className="text-ink-500">({e.live.windows} Fenster)</span>
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-ink-500">
                {e.live.low === null ? '—' : `${value(e.measure, e.live.low)} … ${value(e.measure, e.live.high)}`}
              </td>
              <td className="px-2 py-1.5">
                <span className={`whitespace-nowrap ${STATUS[e.live.status] ?? 'text-ink-300'}`}>{e.live.status}</span>
                {e.live.consistent === false && <div className="text-2xs text-red-400">Backtest-Wert außerhalb des Intervalls</div>}
              </td>
              <td className="whitespace-nowrap px-4 py-1.5 text-right text-ink-400">{years(e.live.monthsToDecide)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
        Faktor-Score und Faktor-Urteil an Monatsenden, gegen die Durchschnittsaktie desselben Monats — live, darunter der Backtest:
      </div>
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal" />
            {horizons.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">{h === 1 ? '1 Monat' : `${h} Monate`}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-ink-800/60">
            <td className="px-4 py-1 text-ink-300">Rang-IC</td>
            {horizons.map((h) => {
              const live = monthly.ics.find((r) => r.horizon === h);
              return (
                <td key={h} className="px-2 py-1 text-right font-mono">
                  <div className="text-ink-200">{live && live.days > 0 ? num(live.meanIc, 3) : '—'}<span className="text-ink-500"> ({live?.independent ?? 0})</span></div>
                  <div className="text-2xs text-ink-500">{num(btIc(h)?.meanIc, 3)}</div>
                </td>
              );
            })}
          </tr>
          {RECOMMENDATIONS.map((v) => (
            <tr key={v} className="border-b border-ink-800/60 last:border-0">
              <td className="px-4 py-1">
                <span className={`rounded px-1.5 py-0.5 text-2xs font-bold ${recommendationColor(v)}`}>{v}</span>
              </td>
              {horizons.map((h) => {
                const live = liveBand(v, h);
                return (
                  <td key={h} className="px-2 py-1 text-right font-mono">
                    <div className="text-ink-200" title={live ? `${live.count} Fälle in ${live.months} Monaten` : 'noch kein Fenster'}>
                      {pct(live?.meanExcess, 2)}<span className="text-ink-500"> ({live?.months ?? 0})</span>
                    </div>
                    <div className="text-2xs text-ink-500">{pct(btBand(v, h)?.meanExcess, 2)}</div>
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
