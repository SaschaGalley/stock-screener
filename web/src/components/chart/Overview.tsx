import type { ChartAnalysis, PriceLevel } from '../../../../src/analysis/chart';
import { levelWhy } from '../../../../src/analysis/chart';
import { chartAnswers, notableFindings } from '../../../../src/analysis/chart-reading';
import PriceLadder, { type LadderBand, type LadderMark } from './PriceLadder';
import { AnswerCard, Question, TONE_MARK, TONE_TEXT, de } from './shared';
import Term from '../Term';

/** The four answers under the chart: which way, where in it, how much room, how much push. */
export function ChartAnswers({ a, lastMonth }: { a: ChartAnalysis; lastMonth: number | null }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {chartAnswers(a, lastMonth).map((x) => <AnswerCard key={x.key} question={x.question} answer={x.answer} tone={x.tone} why={x.why} />)}
    </div>
  );
}

const strengthWord = (s: number) => (s >= 0.66 ? 'stark' : s >= 0.33 ? 'mittel' : 'schwach');
const LEVEL_NAME: Record<PriceLevel['source'], string | null> = { swing: null, high52: 'Jahreshoch', low52: 'Jahrestief', poc: 'Volumenschwerpunkt' };

/** The chart's levels, averages, channel and gaps as marks on the ladder. */
export function chartMarks(a: ChartAnalysis): { marks: LadderMark[]; bands: LadderBand[] } {
  const marks: LadderMark[] = a.levels.map((l) => ({
    price: l.price,
    kind: l.kind,
    label: LEVEL_NAME[l.source] ?? (l.kind === 'support' ? 'Unterstützung' : 'Widerstand'),
    note: strengthWord(l.strength),
    strength: l.strength,
    tip: (
      <div className="max-w-xs">
        <div className="font-semibold text-ink-100">{l.kind === 'support' ? 'Unterstützung' : 'Widerstand'} {de(l.price)}</div>
        <div className="text-ink-300">{levelWhy(l)}.</div>
        {l.distanceAtr !== null && (
          <div className="text-ink-400">Etwa {de(Math.abs(l.distanceAtr), 1)} übliche Tagesbewegungen entfernt.</div>
        )}
      </div>
    ),
  }));
  const ma: [number | null, string][] = [[a.ma.sma20, '20-Tage-Linie'], [a.ma.sma50, '50-Tage-Linie'], [a.ma.sma200, '200-Tage-Linie']];
  for (const [v, label] of ma) if (v !== null) marks.push({ price: v, kind: 'average', label });
  if (a.profile && !a.levels.some((l) => l.source === 'poc')) {
    marks.push({ price: a.profile.poc, kind: 'neutral', label: 'Volumenschwerpunkt', tip: 'Der Kurs, zu dem im letzten Jahr am meisten gehandelt wurde.' });
  }
  const bands: LadderBand[] = [];
  const q = a.channels.find((c) => c.sessions === 63);
  if (q) bands.push({ from: q.lower[1], to: q.upper[1], kind: 'channel', label: '3-Monats-Kanal' });
  for (const g of a.gaps.slice(0, 2)) bands.push({ from: g.low, to: g.high, kind: 'gap', label: 'Lücke' });
  return { marks, bands };
}

/** The ladder beside what else the chart shows. */
export function LevelsAndNotables({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  const { marks, bands } = chartMarks(a);
  const notes = notableFindings(a);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div>
        <Question note="Kanal blau, Kurslücken gelb; Details beim Überfahren"><Term k="tech.levels">Wo liegen Böden und Decken?</Term></Question>
        <PriceLadder price={a.close} marks={marks} bands={bands} fmt={fmtPrice} />
      </div>
      <div>
        <Question>Was außerdem auffällt</Question>
        {notes.length === 0 ? (
          <p className="text-sm text-ink-500">Sonst nichts Besonderes: kein Ausbruch, keine Lücke, keine Divergenz.</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((f) => (
              <li key={f.key} className="flex gap-2.5">
                <span className={`mt-0.5 w-3 shrink-0 text-center text-sm ${f.tone === 'neutral' ? 'text-ink-500' : TONE_TEXT[f.tone]}`}>{TONE_MARK[f.tone]}</span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink-100">{f.title}</div>
                  <div className="text-[13px] leading-snug text-ink-400">{f.text}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
