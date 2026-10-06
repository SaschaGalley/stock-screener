import type { MarketSignals } from '../../types';
import ReturnsChart from '../charts/ReturnsChart';
import type { Tone } from '../../../../src/analysis/chart-reading';
import { AnswerCard, Question, RangeMarker, de, pct } from './shared';

interface Reading { key: string; question: string; answer: string; tone: Tone; why: string[]; extra?: React.ReactNode }

const VIX_WORD: Record<string, string> = { low: 'niedrig', normal: 'normal', elevated: 'erhöht', high: 'hoch', unknown: '—' };
const PERIOD: Record<string, string> = { '0q': 'laufendes Quartal', '+1q': 'nächstes Quartal', '0y': 'laufendes Jahr', '+1y': 'nächstes Jahr' };

/** Everything around the chart, each as a question answered in a word. */
export function contextReadings(ms: MarketSignals): Reading[] {
  const t = ms.technicals;
  const out: Reading[] = [];

  const vol = t.hv30 ?? t.hv90;
  if (vol !== null) {
    const why = [
      ...(t.atr14Pct !== null ? [`an einem üblichen Tag ${de(t.atr14Pct * 100, 1)} % hin oder her`] : []),
      `aufs Jahr gerechnet ${de(vol * 100, 0)} %${t.hv90 !== null && t.hv30 !== null ? ` (30 Tage), ${de(t.hv90 * 100, 0)} % (90 Tage)` : ''}`,
    ];
    out.push({
      key: 'vol', question: 'Wie stark schwankt sie?',
      answer: vol < 0.2 ? 'Ruhig' : vol < 0.35 ? 'Normal' : vol < 0.55 ? 'Lebhaft' : 'Sehr unruhig',
      tone: vol >= 0.55 ? 'bear' : 'neutral', why,
    });
  }

  if (t.rsVsSPY3M !== null) {
    const rs = t.rsVsSPY3M;
    out.push({
      key: 'rs', question: 'Gegen Markt und Sektor, 3 Monate',
      answer: rs >= 0.02 ? 'Stärker als der Markt' : rs <= -0.02 ? 'Schwächer als der Markt' : 'Wie der Markt',
      tone: rs >= 0.02 ? 'bull' : rs <= -0.02 ? 'bear' : 'neutral',
      why: [
        `${pct(rs)} gegen den S&P 500`,
        ...(t.rsVsSector3M !== null ? [`${pct(t.rsVsSector3M)} gegen den Sektor${ms.macro.sectorEtfSymbol ? ` (${ms.macro.sectorEtfSymbol})` : ''}`] : []),
      ],
    });
  }

  if (t.position52WPct !== null) {
    const p = t.position52WPct;
    out.push({
      key: 'range', question: 'Wo in der Jahresspanne?',
      answer: p >= 0.9 ? 'Nahe am Jahreshoch' : p <= 0.1 ? 'Nahe am Jahrestief' : p >= 0.66 ? 'Im oberen Drittel' : p <= 0.33 ? 'Im unteren Drittel' : 'In der Mitte',
      tone: 'neutral',
      why: t.drawdownFromHighPct !== null ? [`${de(Math.abs(t.drawdownFromHighPct * 100), 1)} % unter dem Hoch des Jahres`] : [],
      extra: <div className="mt-2"><RangeMarker at={p} left="Jahrestief" right="Jahreshoch" /></div>,
    });
  }

  if (t.currentVolRatio !== null) {
    const v = t.currentVolRatio;
    out.push({
      key: 'volume', question: 'Wie viel wird gehandelt?',
      answer: v < 0.7 ? 'Wenig' : v > 1.5 ? 'Viel' : 'Üblich',
      tone: 'neutral',
      why: [`zuletzt das ${de(v, 2)}-Fache des 30-Tage-Schnitts`],
    });
  }

  const periods = (ms.revisions?.perPeriod ?? []).filter((p) => p.epsChange30dPct !== null && (p.period === '0y' || p.period === '+1y'));
  if (periods.length) {
    const up = periods.every((p) => p.epsChange30dPct! > 0.005), down = periods.every((p) => p.epsChange30dPct! < -0.005);
    out.push({
      key: 'revisions', question: 'Was tun die Analysten mit ihren Schätzungen?',
      answer: up ? 'Sie heben sie an' : down ? 'Sie senken sie' : 'Kaum Änderungen',
      tone: up ? 'bull' : down ? 'bear' : 'neutral',
      why: periods.map((p) => {
        const net = p.netRevision30d;
        return `${PERIOD[p.period]}: Gewinn je Aktie ${pct(p.epsChange30dPct)} in 30 Tagen${net ? `, ${Math.abs(net)} ${net > 0 ? 'Anhebung' : 'Senkung'}${Math.abs(net) === 1 ? '' : 'en'} mehr` : ''}`;
      }),
    });
  }

  const o = ms.options;
  if (o && (o.ivVsHv90Ratio !== null || o.putCallVolumeRatio !== null)) {
    const r = o.ivVsHv90Ratio;
    const pc = o.putCallVolumeRatio;
    out.push({
      key: 'options', question: 'Was erwartet der Optionsmarkt?',
      answer: r === null ? 'Keine Einschätzung' : r > 1.3 ? 'Mehr Bewegung als zuletzt' : r < 0.8 ? 'Weniger Bewegung als zuletzt' : 'Ähnlich viel Bewegung',
      tone: pc !== null && pc > 1.2 ? 'bear' : pc !== null && pc < 0.7 ? 'bull' : 'neutral',
      why: [
        ...(o.ivAtm30d !== null ? [`eingepreiste Schwankung ${de(o.ivAtm30d * 100, 0)} % im Jahr`] : []),
        ...(pc !== null ? [`${de(pc, 2)} Puts je Call — ${pc > 1.2 ? 'viel Absicherung gegen Verluste' : pc < 0.7 ? 'mehr Wetten auf steigende Kurse' : 'ausgeglichen'}`] : []),
        ...(o.nextEarningsImpliedMove ? [`zu den nächsten Zahlen ±${de(o.nextEarningsImpliedMove.pct * 100, 1)} % eingepreist`] : []),
      ],
    });
  }

  const m = ms.macro;
  if (m) {
    const tense = m.vixRegime === 'high' || (m.hySpreadBps ?? 0) > 600;
    const wary = m.vixRegime === 'elevated' || (m.hySpreadBps ?? 0) > 400 || (m.yieldCurve2Y10Y ?? 0) < 0;
    out.push({
      key: 'macro', question: 'Wie ist das Marktumfeld?',
      answer: tense ? 'Angespannt' : wary ? 'Vorsichtig' : 'Ruhig',
      tone: tense ? 'bear' : wary ? 'neutral' : 'bull',
      why: [
        ...(m.vix !== null ? [`VIX ${de(m.vix, 1)} — Angst am Markt ${VIX_WORD[m.vixRegime] ?? ''}`] : []),
        ...(m.spy3MReturn !== null ? [`S&P 500 ${pct(m.spy3MReturn)} in 3 Monaten${m.sectorEtfSymbol && m.sectorEtfReturn3M !== null ? `, Sektor ${pct(m.sectorEtfReturn3M)}` : ''}`] : []),
        ...(m.yieldCurve2Y10Y !== null ? [`Zinskurve ${m.yieldCurve2Y10Y < 0 ? 'invertiert' : 'normal'} (${de(m.yieldCurve2Y10Y, 0)} Bp.)`] : []),
        ...(m.hySpreadBps !== null ? [`Risikoaufschlag riskanter Anleihen ${de(m.hySpreadBps, 0)} Bp. — ${m.hySpreadBps > 600 ? 'hoch' : m.hySpreadBps > 400 ? 'erhöht' : 'niedrig'}`] : []),
      ],
    });
  }
  return out;
}

export function contextFinding(ms: MarketSignals): string | null {
  const r = contextReadings(ms);
  const pick = (k: string) => r.find((x) => x.key === k);
  return [pick('vol') && `${pick('vol')!.answer} schwankend`, pick('rs')?.answer, pick('macro') && `Umfeld ${pick('macro')!.answer.toLowerCase()}`]
    .filter(Boolean).join(' · ') || null;
}

/**
 * How the stock has done, how much it swings, against the market and its
 * sector, and the world around it — each block a question with its answer
 * in a word and the numbers as reasons, where there were six tables of
 * figures headed "HV 30", "Drift 30 T", "DXY".
 */
export default function Context({ ms }: { ms: MarketSignals }) {
  const r = ms.technicals.returns;
  const readings = contextReadings(ms);
  return (
    <div className="space-y-5">
      {r && (
        <div>
          <Question note="Kursrendite ohne Dividenden">
            Wie hat sie sich entwickelt?
            {r.y1 !== null && <span className="ml-2 font-normal text-ink-300">{pct(r.y1, 0)} in einem Jahr{r.m3 !== null ? `, ${pct(r.m3, 0)} in 3 Monaten` : ''}</span>}
          </Question>
          <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 170 }}>
            <ReturnsChart returns={r} />
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {readings.map((x) => (
          <AnswerCard key={x.key} question={x.question} answer={x.answer} tone={x.tone} why={x.why}>{x.extra}</AnswerCard>
        ))}
      </div>
    </div>
  );
}
