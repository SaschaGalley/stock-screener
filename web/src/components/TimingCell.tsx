import type { OverviewRow, TimingReadings } from '../types';
import SetupBadge from './SetupBadge';
import { TIMING_CANDIDATES, TIMING_GROUPS, timingGroup } from '../../../src/analysis/timing';
import type { VerdictEvidence } from '../../../src/backtest/result';
import Tip from './Tip';

/**
 * Where a stock sits on its own chart, beside — never inside — the verdict.
 *
 * The verdict says whether a stock is worth owning; this says where the price
 * stands on its recent path: which way its three-month channel runs and at
 * which edge it is, the last month, the RSI. On hover each reading stands
 * beside what the backtest found when stocks of the same verdict were bought
 * deeper in such a dip rather than higher up, so a reading is never shown as
 * advice it has not earned.
 */

const pct = (v: number | null, digits = 1) =>
  (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(digits).replace('.', ',')} %`);
/** The readings keep distances in logs; the page says them in percent. */
const fromLog = (v: number | null) => (v === null ? null : Math.exp(v) - 1);
const num = (v: number | null, digits = 1) => (v === null ? '—' : v.toFixed(digits).replace('.', ',').replace('-', '−'));

/** A channel rising or falling by less than this a year is going sideways. */
const FLAT_SLOPE = 0.15;
/** Further than this from the line, in the residuals' deviations, is an edge. */
const EDGE_Z = 1;

function direction(t: TimingReadings): { arrow: string; word: string } {
  if (t.channelSlope === null) return { arrow: '·', word: 'ohne Kanal' };
  if (t.channelSlope > FLAT_SLOPE) return { arrow: '↗', word: 'steigend' };
  if (t.channelSlope < -FLAT_SLOPE) return { arrow: '↘', word: 'fallend' };
  return { arrow: '→', word: 'seitwärts' };
}

function place(t: TimingReadings): string {
  if (t.channelZ === null) return '—';
  return t.channelZ <= -EDGE_Z ? 'unten' : t.channelZ >= EDGE_Z ? 'oben' : 'Mitte';
}

const bounce = TIMING_CANDIDATES.find((c) => c.key === 'timing.bounce')!;

/** Each candidate's reading for this stock, as short as a tooltip column allows. */
function today(key: string, t: TimingReadings): string {
  switch (key) {
    case 'timing.reversal-1m': return pct(t.m1);
    case 'timing.rsi':         return num(t.rsi14, 0);
    case 'timing.sma50':       return pct(fromLog(t.distSma50));
    case 'timing.sma200':      return pct(fromLog(t.distSma200));
    case 'timing.channel':     return `${direction(t).arrow} ${place(t)} ${num(t.channelZ)}σ`;
    case 'timing.support':     return `${pct(fromLog(t.fromLow126), 0)}, vor ${t.lowAgo} T`;
    case 'timing.bounce':      return bounce.read(t) ? 'ja' : 'nein';
    default:                   return '—';
  }
}

/**
 * The horizons beside each reading. The tooltip has room for two, and these
 * two are the contrast that matters: a month, where a dip may still bounce,
 * and half a year, where the trend has had time to win.
 */
const SHOWN_HORIZONS = [1, 6];

/** The readings beside the backtest — the list's hover, and the stock page's timing block. */
export function TimingEvidence({ t, verdict, evidence }: { t: TimingReadings; verdict: string | null; evidence: VerdictEvidence | null }) {
  const study = evidence?.timing ?? null;
  const group = verdict ? timingGroup(verdict) : 'all';
  const label = TIMING_GROUPS.find((g) => g.key === group)!.label;
  const horizons = study ? SHOWN_HORIZONS.filter((h) => study.splits.some((s) => s.horizon === h)) : [];
  const split = (key: string, h: number) => study?.splits.find((s) => s.candidate === key && s.group === group && s.horizon === h);
  const shown = study?.splits.filter((s) => s.group === group && horizons.includes(s.horizon)) ?? [];
  const held = shown.filter((s) => s.holds);
  const tests = shown.length;

  return (
    <div className="max-w-md">
      <div className="font-semibold text-ink-100">Wo der Kurs in seinem Chart steht</div>
      <table className="mt-1 w-full text-2xs">
        <thead className="text-ink-500">
          <tr>
            <th className="pr-2 text-left font-normal" />
            <th className="pr-2 text-left font-normal">heute</th>
            {horizons.map((h) => <th key={h} className="pl-1 text-right font-normal">{h} M</th>)}
          </tr>
        </thead>
        <tbody>
          {TIMING_CANDIDATES.map((c) => (
            <tr key={c.key}>
              <td className="whitespace-nowrap pr-2 text-ink-400">{c.short}</td>
              <td className="whitespace-nowrap pr-2 font-mono text-ink-200">{today(c.key, t)}</td>
              {horizons.map((h) => {
                const s = split(c.key, h);
                const v = s?.diff.mean ?? null;
                return (
                  <td
                    key={h}
                    className={`whitespace-nowrap pl-1 text-right font-mono ${
                      s?.holds ? `font-semibold ${v! >= 0 ? 'text-emerald-400' : 'text-red-400'}` : 'text-ink-500'
                    }`}
                  >
                    {pct(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {study ? (
        <p className="mt-1.5 text-ink-400">
          Rechts der Backtest ({evidence!.universe} {evidence!.from.slice(0, 4)}–{evidence!.to.slice(0, 4)}) für {label}: die Hälfte
          tiefer im Dip minus die Hälfte weiter oben, gegen die Durchschnittsaktie. Plus: der Rücksetzer hat sich gelohnt. Minus: der
          Trend lief weiter.{' '}
          {held.length
            ? `Farbig (${held.length} von ${tests}): zwei Standardfehler von null und in beiden Hälften der Jahre gleich gerichtet — das schafft auch Zufall etwa jeder dreißigste Test.`
            : `Keiner der ${tests} Werte liegt zwei Standardfehler von null und in beiden Hälften der Jahre gleich gerichtet.`}
        </p>
      ) : (
        <p className="mt-1.5 text-ink-400">Der neueste Backtest hat das Timing noch nicht geprüft.</p>
      )}
      <p className="mt-1 text-ink-500">Fließt nicht in Score und Urteil ein.</p>
    </div>
  );
}

export default function TimingCell({ row, evidence, compact = false }: {
  row: OverviewRow; evidence: VerdictEvidence | null;
  /** One line — direction and place — with the month and the RSI left to the hover, for the list. */
  compact?: boolean;
}) {
  const timing = row.timing;
  if (!timing) return <span className="text-xs text-ink-500">—</span>;
  const d = direction(timing);
  // Two hovers side by side, not one inside the other: the chart's readings, and a setup's plan.
  return (
    <div>
      <div className="flex items-center whitespace-nowrap text-xs leading-4 text-ink-300">
        <Tip focusable={false} content={<TimingEvidence t={timing} verdict={row.recommendation} evidence={evidence} />}>
          <span className="font-mono">{d.arrow}</span> {place(timing)}
        </Tip>
        <SetupBadge row={row} study={evidence?.setups ?? null} />
      </div>
      {!compact && (
        <Tip focusable={false} className="block" content={<TimingEvidence t={timing} verdict={row.recommendation} evidence={evidence} />}>
          <span className="whitespace-nowrap font-mono text-2xs leading-4 text-ink-500">1M {pct(timing.m1, 0)} · RSI {num(timing.rsi14, 0)}</span>
        </Tip>
      )}
    </div>
  );
}

/** The channel's direction and the price's place in it, as the list says them — for the stock page's summary. */
export { direction as channelDirection, place as channelPlace };
