import { useMoney } from '../../currency';
import { deNumber, fmtPct } from '../../format';
import Term from '../Term';
import { AnswerCard } from '../chart/shared';
import type { Tone } from '../../../../src/analysis/chart-reading';

interface Props {
  financials: any;
}

const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Who owns the stock and who is moving: how much is sold short, how much the
 * institutions hold, and whether the insiders bought or sold in the last six
 * months — three questions answered in a word, the figures as reasons. They
 * were three small tables of "Trans.", "Stk." and a share count.
 */
export default function OwnershipFlow({ financials: f }: Props) {
  const { fmtBig, fmtCount } = useMoney();

  const short = ok(f.shortPercentOfFloat) ? f.shortPercentOfFloat : null;
  const shortChange = ok(f.sharesShort) && ok(f.sharesShortPriorMonth) && f.sharesShortPriorMonth > 0
    ? f.sharesShort / f.sharesShortPriorMonth - 1 : null;

  const inst = ok(f.institutionsPercentHeld) ? f.institutionsPercentHeld : null;
  const insiders = ok(f.insidersPercentHeld) ? f.insidersPercentHeld : null;

  const buys = f.insiderBuyCount ?? 0, sells = f.insiderSellCount ?? 0;
  const net = (f.insiderBuyValue ?? 0) - (f.insiderSellValue ?? 0);
  const insiderTone: Tone = buys + sells === 0 ? 'neutral' : net > 0 ? 'bull' : net < 0 ? 'bear' : 'neutral';

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <AnswerCard
        question="Wetten viele auf fallende Kurse?"
        answer={short === null ? 'Keine Daten' : short < 0.03 ? 'Kaum jemand' : short < 0.08 ? 'Wenige' : short < 0.2 ? 'Einige' : 'Viele'}
        tone={short === null ? 'neutral' : short >= 0.2 ? 'bear' : short < 0.08 ? 'bull' : 'neutral'}
        why={short === null ? [] : [
          `${fmtPct(short, 1)} des Streubesitzes leerverkauft${ok(f.sharesShort) ? ` (${fmtCount(f.sharesShort)} Aktien)` : ''}`,
          ...(ok(f.shortRatio) ? [`zurückzukaufen in etwa ${deNumber(f.shortRatio, 1)} Handelstagen`] : []),
          ...(shortChange !== null ? [`${shortChange >= 0 ? '+' : '−'}${deNumber(Math.abs(shortChange * 100), 0)} % gegen den Vormonat`] : []),
        ]}
      />
      <AnswerCard
        question="Wem gehört die Aktie?"
        answer={inst === null ? 'Keine Daten' : inst >= 0.7 ? 'Vor allem Fonds und Banken' : inst >= 0.4 ? 'Gemischt' : 'Vor allem Privatanleger'}
        tone="neutral"
        why={[
          ...(inst !== null ? [`Institutionen ${fmtPct(inst, 1)}${f.institutionsCount ? `, ${Number(f.institutionsCount).toLocaleString('de-DE')} Halter` : ''}`] : []),
          ...(insiders !== null ? [`Insider ${fmtPct(insiders, 1)}`] : []),
        ]}
      />
      <AnswerCard
        question={<Term k="concept.insiderActivity">Kaufen oder verkaufen die Insider?</Term>}
        answer={buys + sells === 0 ? 'Keine Geschäfte' : net > 0 ? 'Sie kaufen' : net < 0 ? 'Sie verkaufen' : 'Ausgeglichen'}
        tone={insiderTone}
        why={[
          ...(buys > 0 ? [`${buys} ${buys === 1 ? 'Kauf' : 'Käufe'} für ${fmtBig(f.insiderBuyValue)}`] : []),
          ...(sells > 0 ? [`${sells} ${sells === 1 ? 'Verkauf' : 'Verkäufe'} für ${fmtBig(f.insiderSellValue)}`] : []),
          'in den letzten sechs Monaten; Verkäufe sind oft geplant oder für Steuern',
        ]}
      />
    </div>
  );
}
