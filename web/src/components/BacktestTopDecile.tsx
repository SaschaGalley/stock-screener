import type { BacktestResponse } from '../types';
import { TOP_FEATURES, type SplitStat, type TopSplit } from '../../../src/backtest/top-decile';

type Backtest = NonNullable<BacktestResponse['backtest']>;

/** How each feature reads: a return or a share in per cent, a size in billions, a ratio or a pillar as it is. */
const FORMAT: Record<string, (v: number) => string> = {
  mom12: (v) => `${(v * 100).toFixed(0)} %`,
  mom3: (v) => `${(v * 100).toFixed(1)} %`,
  nearHigh: (v) => `${(v * 100).toFixed(0)} %`,
  size: (v) => `${(v / 1e9).toFixed(1)} Mrd.`,
  upside: (v) => `${(v * 100).toFixed(0)} %`,
  growth: (v) => `${(v * 100).toFixed(1)} %`,
  ps: (v) => `${v.toFixed(1)}×`,
  pe: (v) => `${v.toFixed(1)}×`,
};
const fmt = (key: string, v: number | null) => (v === null ? '—' : (FORMAT[key] ?? ((x: number) => x.toFixed(2)))(v));
const pct = (s: SplitStat) => (s.mean === null ? '—' : `${s.mean >= 0 ? '+' : ''}${(s.mean * 100).toFixed(2)} %`);
const SEGMENT: Record<string, string> = { sp500: '500', sp400: '400', sp600: '600' };

const same = (a: SplitStat, b: SplitStat) => a.mean !== null && b.mean !== null && Math.sign(a.mean) === Math.sign(b.mean);

/** One tenth split at its own median of each feature, in both halves of the years, and the same split in the tenth beside it. */
function SplitTable({ splits, h, monthName, where, beside }: {
  splits: TopSplit[]; h: number; monthName: (h: number) => string; where: string; beside: string;
}) {
  const rows = splits.filter((x) => x.horizon === h).sort((a, b) => Math.abs(b.diff.t ?? 0) - Math.abs(a.diff.t ?? 0));
  return (
    <>
      <div className="border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
        Innerhalb {where} an seinem Median geteilt, {monthName(h)} danach gegen die Durchschnittsaktie:
      </div>
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Merkmal</th>
            <th className="px-2 py-1.5 text-right font-normal">Obere Hälfte</th>
            <th className="px-2 py-1.5 text-right font-normal">Untere Hälfte</th>
            <th className="px-2 py-1.5 text-right font-normal">Unterschied (t)</th>
            <th className="px-2 py-1.5 text-right font-normal">2013–2019</th>
            <th className="px-2 py-1.5 text-right font-normal">2020–2026</th>
            <th className="px-4 py-1.5 text-right font-normal" title="Dieselbe Teilung im Zehntel daneben">{beside}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const steady = same(x.first, x.second) && Math.abs(x.diff.t ?? 0) >= 1.5;
            return (
              <tr key={x.feature} className={`border-b border-ink-800/60 last:border-0 ${steady ? 'bg-ink-800/40' : ''}`}>
                <td className={`px-4 py-1 ${steady ? 'text-ink-100' : 'text-ink-300'}`}>{x.label}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.high)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-300">{pct(x.low)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-100">{pct(x.diff)} <span className="text-ink-500">({x.diff.t?.toFixed(1) ?? '—'})</span></td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{pct(x.first)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-400">{pct(x.second)}</td>
                <td className="px-4 py-1 text-right font-mono text-ink-400">{pct(x.ninth)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * What the top tenth of the score is made of, and which half of it falls
 * back — and which half of the bottom tenth recovers.
 */
export default function BacktestTopDecile({ bt, horizon, monthName }: { bt: Backtest; horizon: number; monthName: (h: number) => string }) {
  const study = bt.topDecile;
  if (!study) return null;
  const h = [1, 3, 6].includes(horizon) ? horizon : 6;

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">
          Oberstes und unterstes Zehntel{bt.studiesAt && <span className="font-normal normal-case text-ink-500"> · Studie vom {new Date(bt.studiesAt).toLocaleDateString('de-DE')}</span>}
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Woraus die höchsten Scores bestehen, im Median zum Zeitpunkt der Bildung — und welche Hälfte davon zurückfällt. Siebzehn
          Merkmale an drei Horizonten sind viele Gelegenheiten für Zufall; als Spur gilt nur, was in beiden Hälften der Jahre in
          dieselbe Richtung zeigt (hervorgehoben).
        </p>
      </header>
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Median</th>
            {study.profiles.map((g) => <th key={g.group} className="px-2 py-1.5 text-right font-normal">{g.group}</th>)}
          </tr>
        </thead>
        <tbody>
          {TOP_FEATURES.map((f) => (
            <tr key={f.key} className="border-b border-ink-800/60">
              <td className="px-4 py-1 text-ink-300">{f.label}</td>
              {study.profiles.map((g) => (
                <td key={g.group} className={`px-2 py-1 text-right font-mono ${g.group === 'D10' ? 'text-ink-100' : 'text-ink-400'}`}>
                  {fmt(f.key, g.medians[f.key] ?? null)}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <td className="px-4 py-1 text-ink-300">Indizes</td>
            {study.profiles.map((g) => (
              <td key={g.group} className="px-2 py-1 text-right text-xs text-ink-400">
                {Object.entries(g.segments).sort().map(([k, x]) => `${SEGMENT[k] ?? k} ${Math.round(x * 100)} %`).join(' · ')}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      <SplitTable splits={study.splits} h={h} monthName={monthName} where="des obersten Zehntels" beside="Im 9. Zehntel" />
      {study.bottom && (
        <SplitTable splits={study.bottom} h={h} monthName={monthName} where="des untersten Zehntels — dort stehen SELL und STRONG SELL —" beside="Im 2. Zehntel" />
      )}
    </section>
  );
}
