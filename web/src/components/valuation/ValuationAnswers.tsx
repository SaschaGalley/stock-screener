import type { ComputedMetrics } from '../../types';
import { useMoney } from '../../currency';
import { AnswerCard, de, pct } from '../chart/shared';
import type { Tone } from '../../../../src/analysis/chart-reading';
import More from '../More';

/** "34 % über dem Kurs" */
const vsPrice = (v: number, price: number) => {
  const d = v / price - 1;
  return Math.abs(d) < 0.005 ? 'auf Kurshöhe' : `${de(Math.abs(d * 100), 0)} % ${d > 0 ? 'über' : 'unter'} dem Kurs`;
};
const toneOf = (mos: number | null): Tone => (mos === null ? 'neutral' : mos >= 0.15 ? 'bull' : mos <= -0.15 ? 'bear' : 'neutral');

/**
 * Three answers over the models' chart: what they say it is worth, how far
 * they agree, and what the cautious view leaves of it.
 */
export function FairValueAnswers({ m, price }: { m: ComputedMetrics; price: number }) {
  const { fmtPrice } = useMoney();
  const p = m.composite.primary, c = m.composite.conservative;
  const spread = p.min !== null && p.max !== null && p.median ? (p.max - p.min) / p.median : null;
  // The highest model over the lowest, against the middle: half the middle apart is close for valuation models.
  const agree = spread === null ? null : spread < 0.5 ? 'Ziemlich einig' : spread < 1 ? 'Teils uneins' : 'Weit auseinander';
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-3">
      {p.median !== null && (
        <AnswerCard
          question="Was sind die Modelle wert?"
          answer={<>{fmtPrice(p.median)} <span className="text-sm font-normal text-ink-400">{vsPrice(p.median, price)}</span></>}
          tone={toneOf(p.marginOfSafety)}
          why={[`Mitte aus ${p.models.length} marktnahen Modellen`, ...(m.composite.pctPrimaryUndervalued !== null ? [`${Math.round(m.composite.pctPrimaryUndervalued * 100)} % davon sehen die Aktie unter Wert`] : [])]}
        />
      )}
      {agree && p.min !== null && p.max !== null && (
        <AnswerCard
          question="Wie einig sind sie sich?"
          answer={agree}
          tone="neutral"
          why={[`von ${fmtPrice(p.min)} bis ${fmtPrice(p.max)}`, `Konfidenz ${de(m.composite.confidence, 1)} von 10`]}
        />
      )}
      {c.median !== null && (
        <AnswerCard
          question="Was bleibt im vorsichtigen Blick?"
          answer={<>{fmtPrice(c.median)} <span className="text-sm font-normal text-ink-400">{vsPrice(c.median, price)}</span></>}
          tone={toneOf(c.marginOfSafety)}
          why={['ohne Wachstum gerechnet, aus Gewinn, Buchwert und Dividende', `${c.models.length} Modelle`]}
        />
      )}
    </div>
  );
}

const BASIS: Record<string, string> = { current: 'heute', history: 'in den eigenen Jahren', peers: 'bei den Peers' };
const SOURCE: Record<string, string> = { 'analyst consensus': 'Analystenkonsens', 'trailing twelve months': 'letzte zwölf Monate', 'steady state': 'langfristiges Wachstum' };

export function impliesFinding(m: ComputedMetrics): string | null {
  const r = m.reverseDCF, im = r.impliedMargin;
  return [
    r.isPossible && r.impliedGrowthRate !== null && `${pct(r.impliedGrowthRate)} Umsatzwachstum${r.consensusGrowth !== null ? ` (Konsens ${pct(r.consensusGrowth)})` : ''}`,
    im && `${de(im.requiredMargin * 100, 1)} % operative Marge${im.achievableMargin !== null ? ` (gezeigt ${de(im.achievableMargin * 100, 1)} %)` : ''}`,
  ].filter(Boolean).join(' · ') || null;
}

/**
 * The valuation run backwards: what growth and what margin today's price
 * takes for granted, each against what the business or the analysts have
 * to show for it. It was a box at the bottom of the models' table; it is the
 * question a reader can check against their own view.
 */
export function PriceImplies({ m }: { m: ComputedMetrics }) {
  const { fmtBig } = useMoney();
  const r = m.reverseDCF, im = r.impliedMargin;
  const g = r.isPossible ? r.impliedGrowthRate : null;
  const gTone: Tone = g === null || r.consensusGrowth === null ? 'neutral'
    : g <= r.consensusGrowth ? 'bull' : g > r.consensusGrowth * 1.3 + 0.02 ? 'bear' : 'neutral';
  const mTone: Tone = !im || im.ratio === null ? 'neutral' : im.ratio <= 1 ? 'bull' : im.ratio <= 1.25 ? 'neutral' : 'bear';
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <AnswerCard
          question="Welches Wachstum verlangt der Kurs?"
          answer={g !== null ? `${pct(g)} Umsatz im Jahr` : 'Nicht zu bestimmen'}
          tone={gTone}
          why={[
            ...(g !== null && r.consensusGrowth !== null ? [`die Analysten erwarten ${pct(r.consensusGrowth)} — ${g <= r.consensusGrowth ? 'der Kurs verlangt weniger' : 'der Kurs verlangt mehr'}`] : []),
            r.interpretation,
          ]}
        />
        <AnswerCard
          question="Welche Marge verlangt der Kurs?"
          answer={im ? `${de(im.requiredMargin * 100, 1)} % operativ` : 'Nicht zu bestimmen'}
          tone={mTone}
          why={im ? [
            ...(im.achievableMargin !== null ? [`die beste gezeigte Marge: ${de(im.achievableMargin * 100, 1)} % ${BASIS[im.achievableBasis ?? ''] ?? ''}`] : []),
            im.interpretation,
          ] : ['braucht Umsatz und Aktienzahl']}
        />
      </div>
      <More label="wie das gerechnet ist">
        <div className="space-y-2 text-[13px] text-ink-400">
          {im && (
            <p>
              Ausgehend von {fmtBig(im.revenueBase)} Umsatz der letzten zwölf Monate, der um {pct(im.revenueGrowth)} im Jahr wächst
              ({SOURCE[im.growthSource] ?? im.growthSource}) und dann zum langfristigen Wachstum ausläuft, abgezinst mit {de(im.discountRate * 100, 1)} %:
              das DCF-Modell rückwärts, einmal nach der Marge gelöst, einmal nach dem Wachstum der ersten zwei Jahre.
            </p>
          )}
          {m.dcf.fairValue !== null && <p>Annahmen des DCF: {m.dcf.assumptions}</p>}
        </div>
      </More>
    </div>
  );
}
