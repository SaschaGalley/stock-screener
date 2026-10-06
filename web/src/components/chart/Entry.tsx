import type { OverviewRow, TimingReadings } from '../../types';
import { SETUPS, type Setup } from '../../../../src/analysis/setups';
import { BOUNCE } from '../../../../src/analysis/timing';
import { rsiWord } from '../../../../src/analysis/chart-reading';
import { TimingEvidence } from '../TimingCell';
import { SetupPlan } from '../SetupBadge';
import { useVerdictEvidence } from '../VerdictEvidence';
import More from '../More';
import { Question, RangeMarker, TONE_TEXT, de, pct } from './shared';

/** The readings keep distances in logs; the page says them in percent. */
const fromLog = (v: number | null) => (v === null ? null : Math.exp(v) - 1);
const side = (d: number) => `${de(Math.abs(d * 100), 1)} % ${d >= 0 ? 'darüber' : 'darunter'}`;

function monthWord(m1: number): string {
  return m1 >= 0.1 ? 'kräftig gestiegen' : m1 >= 0.03 ? 'gestiegen' : m1 > -0.03 ? 'kaum bewegt' : m1 > -0.1 ? 'gefallen' : 'kräftig gefallen';
}

/** The headline fair value's gap, ln(fair / price), as the setups read it. */
function fairGapOf(row: OverviewRow | null): number | null {
  return row?.compositeFairValue && row.price && row.compositeFairValue > 0 && row.price > 0
    ? Math.log(row.compositeFairValue / row.price) : null;
}

export function entryFinding(t: TimingReadings | null, row: OverviewRow | null): string | null {
  if (!t) return null;
  const firing = SETUPS.filter((s) => s.fires({ t, fairGap: fairGapOf(row) }));
  return firing.length ? `Setup aktiv: ${firing.map((s) => s.title).join(', ')}` : 'Kein Setup aktiv';
}

/**
 * Is now a good moment to buy, by the chart? The readings the list shows in a
 * word — the last month, the RSI, the distance to the averages, the place in
 * the channel — each with what it means, and the five setups tested in the
 * backtest as a checklist: which of their conditions hold today.
 */
export default function Entry({ t, row }: { t: TimingReadings; row: OverviewRow | null }) {
  const evidence = useVerdictEvidence();
  const fairGap = fairGapOf(row);
  const firing = SETUPS.filter((s) => s.fires({ t, fairGap }));
  const rsi = t.rsi14 !== null ? rsiWord(t.rsi14) : null;
  const sma50 = fromLog(t.distSma50), sma200 = fromLog(t.distSma200), high = fromLog(t.fromHigh252), low = fromLog(t.fromLow126);
  const bounced = t.lowAgo >= BOUNCE.minAgo && t.lowAgo <= BOUNCE.maxAgo && t.fromLow126 >= BOUNCE.minRise;

  const rows: { label: string; value: string; reading: string; tone?: 'bull' | 'bear' | 'neutral' }[] = [
    { label: 'Letzter Monat', value: pct(t.m1), reading: monthWord(t.m1), tone: t.m1 >= 0.03 ? 'bull' : t.m1 <= -0.03 ? 'bear' : 'neutral' },
    ...(sma50 !== null ? [{ label: '50-Tage-Linie', value: side(sma50), reading: Math.abs(sma50) > 0.1 ? 'weit weg' : Math.abs(sma50) > 0.03 ? 'mit Abstand' : 'nahe dran' }] : []),
    ...(sma200 !== null ? [{ label: '200-Tage-Linie', value: side(sma200), reading: sma200 >= 0 ? 'langfristig im Aufwärtstrend' : 'langfristig im Abwärtstrend', tone: (sma200 >= 0 ? 'bull' : 'bear') as 'bull' | 'bear' }] : []),
    ...(high !== null ? [{ label: 'Jahreshoch', value: high >= -0.01 ? 'erreicht' : `${de(Math.abs(high * 100), 1)} % darunter`, reading: high >= -0.05 ? 'nahe am Hoch' : high >= -0.2 ? 'etwas zurückgefallen' : 'weit vom Hoch' }] : []),
    { label: '6-Monats-Tief', value: `${de(low! * 100, 0)} % darüber`, reading: bounced ? `vor ${t.lowAgo} Tagen abgeprallt` : `zuletzt vor ${t.lowAgo} Handelstagen` },
  ];

  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      <div>
        <Question note="die Lesungen, die die Liste in einem Wort zeigt">Wo steht der Kurs gerade?</Question>
        {rsi && t.rsi14 !== null && (
          <div className="mb-4">
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="text-ink-300">RSI 14 · Schwung</span>
              <span><span className={TONE_TEXT[rsi.tone]}>{rsi.word}</span> <span className="font-mono text-ink-400">{de(t.rsi14, 0)}</span></span>
            </div>
            <RangeMarker
              at={t.rsi14 / 100}
              left="0 · überverkauft" middle="50" right="überkauft · 100"
              zones={[{ from: 0, to: 0.3, cls: 'bg-emerald-500/20' }, { from: 0.7, to: 1, cls: 'bg-red-500/20' }]}
            />
          </div>
        )}
        <dl className="divide-y divide-ink-800 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[7.5rem_7.5rem_minmax(0,1fr)] items-baseline gap-3 py-1.5">
              <dt className="text-ink-400">{r.label}</dt>
              <dd className="whitespace-nowrap text-ink-200">{r.value}</dd>
              <dd className={r.tone ? TONE_TEXT[r.tone] : 'text-ink-300'}>{r.reading}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <More label="was der Backtest zu diesen Lesungen sagt">
            <div className="text-xs"><TimingEvidence t={t} verdict={row?.recommendation ?? null} evidence={evidence} /></div>
          </More>
        </div>
      </div>

      <div>
        <Question note="fünf vorab festgelegte Einstiege, im Backtest geprüft">Schlägt ein Setup an?</Question>
        <ul className="space-y-2.5">
          {SETUPS.map((s) => <SetupRow key={s.key} s={s} t={t} fairGap={fairGap} on={firing.includes(s)} />)}
        </ul>
        {firing.length > 0 && row && (
          <div className="mt-4 rounded border border-ink-700 bg-ink-950 p-3 text-xs">
            <SetupPlan row={row} t={t} setups={firing} study={evidence?.setups ?? null} />
          </div>
        )}
      </div>
    </div>
  );
}

function SetupRow({ s, t, fairGap, on }: { s: Setup; t: TimingReadings; fairGap: number | null; on: boolean }) {
  return (
    <li className={`rounded border px-3 py-2 ${on ? 'border-emerald-700 bg-emerald-950/40' : 'border-ink-800'}`}>
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${on ? 'text-emerald-300' : 'text-ink-200'}`}>{s.title}</span>
        {on && <span className="rounded bg-emerald-900 px-1.5 text-2xs font-semibold text-emerald-300">aktiv</span>}
      </div>
      <ul className="mt-1 space-y-0.5 text-[13px]">
        {s.conditions.map((c) => {
          const met = c.met({ t, fairGap });
          return (
            <li key={c.label} className={met ? 'text-ink-200' : 'text-ink-500'}>
              <span className={`mr-1.5 inline-block w-3 ${met ? 'text-emerald-400' : 'text-ink-600'}`}>{met ? '✓' : '✗'}</span>{c.label}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
