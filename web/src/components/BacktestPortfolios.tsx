import type { BacktestResponse } from '../types';
import { PORTFOLIO_RULES, PORTFOLIO_SIGNALS } from '../../../src/backtest/portfolio';
import ReactECharts from './charts/ECharts';
import { CHART_COLORS, baseTextStyle } from './charts/chartTheme';

type Backtest = NonNullable<BacktestResponse['backtest']>;

const pct = (v: number | null | undefined, d = 1) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const plain = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d).replace('.', ',')} %`);
const tone = (v: number | null | undefined) => (v == null ? 'text-ink-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400');
const rhythm = (m: number) => (m === 1 ? 'monatlich' : m === 3 ? 'quartalsweise' : m === 12 ? 'jährlich' : `alle ${m} Monate`);

/** Line colours: the two signals strong, the yardsticks muted. */
const PATH_COLOR: Record<string, string> = {
  'score': CHART_COLORS.green,
  'quality-momentum': CHART_COLORS.purple,
  'URTH': CHART_COLORS.blue,
  'SPY': CHART_COLORS.amber,
  'universe': CHART_COLORS.ink,
};

/**
 * The question an investor asks: would buying the top of the score have beaten
 * the index — the cap-weighted MSCI World, not the average stock — after costs?
 */
export default function BacktestPortfolios({ bt }: { bt: Backtest }) {
  const pf = bt.portfolios;
  if (!pf) return null;
  const label = (signal: string) => PORTFOLIO_SIGNALS.find((s) => s.key === signal)?.label ?? signal;

  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-ink-300">Portfolios gegen den Index · {pf.from.slice(0, 7)} bis {pf.to.slice(0, 7)}</h3>
        <p className="mt-0.5 text-xs text-ink-500">
          An jedem Umschichtungstermin die besten N Aktien nach dem Signal kaufen, zu gleichen Teilen, und bis zum nächsten Termin halten.
          Dividendenbereinigte Kurse, {plain(pf.costPerSide, 2)} Kosten je gekaufter oder verkaufter Position, ohne Steuern. Der MSCI World
          (URTH) und der S&P 500 (SPY) sind nach Börsenwert gewichtet — anders als die Durchschnittsaktie, gegen die der übrige Backtest misst.
          Firmen, die nach dem Ausscheiden übernommen wurden oder pleitegingen, fehlen; das schönt eher.
        </p>
      </header>

      <div className="flex flex-col gap-1 border-b border-ink-800 px-4 py-2 text-xs">
        {pf.verdicts.map((v) => (
          <div key={v.key} className="flex gap-2">
            <span className={`w-20 shrink-0 font-semibold ${v.holds === null ? 'text-ink-500' : v.holds ? 'text-emerald-400' : 'text-red-400'}`}>
              {v.holds === null ? 'offen' : v.holds ? 'hält' : 'hält nicht'}
            </span>
            <span className="text-ink-300">{v.claim}</span>
          </div>
        ))}
        <div className="text-ink-500">Die Regel stand vor dem ersten Lauf fest; die übrigen Größen und Rhythmen werden gezeigt, nicht bewertet.</div>
      </div>

      <div className="h-64 px-2 py-2">
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          option={{
            grid: { top: 30, left: 44, right: 16, bottom: 24 },
            legend: { top: 0, textStyle: { color: CHART_COLORS.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
            tooltip: {
              trigger: 'axis', backgroundColor: CHART_COLORS.bg, borderColor: '#1e293b',
              textStyle: { color: CHART_COLORS.text, fontSize: 12 },
              valueFormatter: (v: number) => `${v.toFixed(2).replace('.', ',')}×`,
            },
            xAxis: { type: 'time', axisLabel: { color: CHART_COLORS.ink, fontSize: 11 }, axisLine: { lineStyle: { color: '#334155' } } },
            yAxis: {
              type: 'log', axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (v: number) => `${v}×` },
              splitLine: { lineStyle: { color: CHART_COLORS.grid } },
            },
            series: pf.paths.map((p) => ({
              name: p.label, type: 'line', showSymbol: false,
              lineStyle: { width: p.key === 'universe' ? 1 : 1.75, type: p.key === 'universe' ? 'dashed' : 'solid' },
              color: PATH_COLOR[p.key] ?? CHART_COLORS.text,
              data: p.points.map((x) => [x.day, x.value]),
            })),
            textStyle: baseTextStyle,
          }}
        />
      </div>

      <table className="w-full min-w-[960px] text-sm">
        <thead className="text-xs text-ink-400">
          <tr className="border-y border-ink-800">
            <th className="min-w-[14rem] px-4 py-1.5 text-left font-normal">Portfolio</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">p. a.</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">Schwankung</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">Max. Verlust</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">vs MSCI World</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">bis 2019 / ab 2020</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal" title="Jahre vor dem MSCI World, von allen">Jahre vorn</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal" title="Die schlechtesten zwölf Monate gegen den MSCI World">Schlechteste 12 M</th>
            <th className="whitespace-nowrap px-2 py-1.5 text-right font-normal">vs S&amp;P 500</th>
            <th className="px-4 py-1.5 text-right font-normal" title="Anteil getauschter Positionen je Umschichtung · Kosten pro Jahr">Umschlag · Kosten</th>
          </tr>
        </thead>
        <tbody>
          {pf.benchmarks.map((b) => (
            <tr key={b.key} className="border-b border-ink-800/60 text-ink-400">
              <td className="px-4 py-1">{b.label}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{pct(b.cagr)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{plain(b.vol)}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{pct(b.maxDrawdown)}</td>
              <td colSpan={6} />
            </tr>
          ))}
          <tr className="border-b border-ink-800 text-ink-400">
            <td className="px-4 py-1">Durchschnittsaktie (gleichgewichtet)</td>
            <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{pct(pf.universe.cagr)}</td>
            <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{plain(pf.universe.vol)}</td>
            <td className="whitespace-nowrap px-2 py-1 text-right font-mono">{pct(pf.universe.maxDrawdown)}</td>
            <td colSpan={6} />
          </tr>
          {pf.runs.map((r) => {
            const u = r.vs.URTH;
            // The size and rhythm the rule judges.
            const judged = r.size === PORTFOLIO_RULES[0].size && r.every === PORTFOLIO_RULES[0].every;
            return (
              <tr key={`${r.signal}-${r.size}-${r.every}`} className={`border-b border-ink-800/60 last:border-0 ${judged ? 'bg-ink-800/40' : ''}`}>
                <td className={`px-4 py-1 ${judged ? 'text-ink-100' : 'text-ink-300'}`}>
                  {label(r.signal)}
                  <div className="text-2xs text-ink-500">{r.size} Aktien, {rhythm(r.every)}</div>
                </td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-200">{pct(r.cagr)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{plain(r.vol)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{pct(r.maxDrawdown)}</td>
                <td className={`whitespace-nowrap px-2 py-1 text-right font-mono ${tone(u?.excess)}`}>{pct(u?.excess)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{pct(u?.first)} / {pct(u?.second)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{u ? `${u.yearsAhead}/${u.years}` : '—'}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-ink-400">{pct(u?.worst12m)}</td>
                <td className={`whitespace-nowrap px-2 py-1 text-right font-mono ${tone(r.vs.SPY?.excess)}`}>{pct(r.vs.SPY?.excess)}</td>
                <td className="whitespace-nowrap px-4 py-1 text-right font-mono text-ink-400">{plain(r.turnover, 0)} · {plain(r.costDrag, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
