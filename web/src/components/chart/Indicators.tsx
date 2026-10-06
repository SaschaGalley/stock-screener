import type { SignalGroup, SignalItem, TechnicalSignals } from '../../types';
import { fmt } from '../../format';
import { technicalTerm } from '../../glossary';
import Term from '../Term';
import More from '../More';
import { AnswerCard, Question } from './shared';
import type { Tone } from '../../../../src/analysis/chart-reading';

const VERDICT: Record<SignalGroup['verdict'], { word: string; tone: Tone }> = {
  'STRONG BUY':  { word: 'Klar auf Kauf', tone: 'bull' },
  BUY:           { word: 'Eher Kauf', tone: 'bull' },
  NEUTRAL:       { word: 'Unentschieden', tone: 'neutral' },
  SELL:          { word: 'Eher Verkauf', tone: 'bear' },
  'STRONG SELL': { word: 'Klar auf Verkauf', tone: 'bear' },
};
const SIGNAL: Record<SignalItem['signal'], { word: string; cls: string }> = {
  buy:     { word: 'Kauf', cls: 'text-emerald-400' },
  sell:    { word: 'Verkauf', cls: 'text-red-400' },
  neutral: { word: 'neutral', cls: 'text-ink-500' },
};

const count = (g: SignalGroup) => `${g.buy} auf Kauf, ${g.neutral} neutral, ${g.sell} auf Verkauf`;

export function indicatorFinding(s: TechnicalSignals): string {
  return `${VERDICT[s.overall.verdict].word} · ${count(s.overall)}`;
}

/**
 * The indicator vote — nineteen classic indicators, each for buy, sell or
 * neither — as three answers, and the oscillators one by one with what each
 * reads today. The twelve averages say what the trend block already says and
 * wait behind a click.
 */
export default function Indicators({ signals: s }: { signals: TechnicalSignals }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <AnswerCard question="Gleitende Durchschnitte" answer={VERDICT[s.movingAverages.verdict].word} tone={VERDICT[s.movingAverages.verdict].tone} why={[count(s.movingAverages)]} />
        <AnswerCard question="Oszillatoren" answer={VERDICT[s.oscillators.verdict].word} tone={VERDICT[s.oscillators.verdict].tone} why={[count(s.oscillators)]} />
        <AnswerCard question="Zusammen" answer={VERDICT[s.overall.verdict].word} tone={VERDICT[s.overall.verdict].tone} why={['beide Gruppen gleich gewichtet']} />
      </div>
      <div>
        <Question note="ob der Kurs zu weit oder zu schnell gelaufen ist"><Term k="tech.oscillators">Die Oszillatoren einzeln</Term></Question>
        <IndicatorTable items={s.oscillators.items} />
      </div>
      <More label={`alle ${s.movingAverages.items.length} gleitenden Durchschnitte`}>
        <IndicatorTable items={s.movingAverages.items} />
      </More>
    </div>
  );
}

function IndicatorTable({ items }: { items: SignalItem[] }) {
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-ink-800">
        {items.map((it) => (
          <tr key={it.name}>
            <td className="whitespace-nowrap py-1.5 pr-3 text-ink-200"><Term k={technicalTerm(it.name) ?? undefined}>{it.name}</Term></td>
            <td className="py-1.5 pr-3 text-ink-400">{it.hint && it.hint !== '—' ? it.hint : <span className="font-mono">{it.value !== null ? fmt(it.value, '', 2) : '—'}</span>}</td>
            <td className={`whitespace-nowrap py-1.5 text-right ${SIGNAL[it.signal].cls}`}>{SIGNAL[it.signal].word}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
