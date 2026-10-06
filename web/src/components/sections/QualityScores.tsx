import type { ComputedMetrics } from '../../types';
import { deNumber, fmt, fmtPct } from '../../format';
import Term from '../Term';
import Tip from '../Tip';
import { GLOSSARY, type GlossaryKey } from '../../glossary';

interface Props {
  metrics: ComputedMetrics;
}

export default function QualityScores({ metrics }: Props) {
  const { piotroski, altmanZ, beneish, sortino, ruleOf40, interestCoverage } = metrics;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <PiotroskiCard p={piotroski} />
      <AltmanCard a={altmanZ} />
      <BeneishCard b={beneish} />
      <SortinoCard s={sortino} />
      <RuleOf40Card r={ruleOf40} />
      <InterestCard ic={interestCoverage} />
    </div>
  );
}

function ScoreCard({
  title, term, value, subtitle, color, body,
}: { title: string; term: GlossaryKey; value: string; subtitle?: string; color: string; body?: React.ReactNode }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-3">
      <div className="text-xs font-semibold text-ink-300"><Term k={term}>{title}</Term></div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`font-mono text-xl font-bold tabular ${color}`}>{value}</span>
        {subtitle && <span className="text-xs text-ink-400">{subtitle}</span>}
      </div>
      {body && <div className="mt-2 text-xs text-ink-400">{body}</div>}
    </div>
  );
}

/** A Piotroski signal's explanation, by the key the metrics carry it under. */
function signalText(key: string): string | null {
  const k = `metrics.piotroski.signals.${key}`;
  return k in GLOSSARY ? GLOSSARY[k as GlossaryKey] : null;
}

// The interpretations arrive as the metrics' English enum values.
const PIOTROSKI_LABEL: Record<string, string> = { strong: 'stark', neutral: 'mittel', weak: 'schwach' };
const ALTMAN_ZONE: Record<string, string> = { safe: 'sicher', grey: 'Grauzone', distress: 'gefährdet', unknown: 'unbekannt' };
const BENEISH_LABEL: Record<string, string> = {
  'likely manipulator': 'auffällig', 'grey zone': 'Grauzone', 'unlikely manipulator': 'unauffällig', unknown: 'unbekannt',
};
const RATING_LABEL: Record<string, string> = {
  excellent: 'exzellent', good: 'gut', acceptable: 'akzeptabel', fair: 'ausreichend',
  poor: 'schwach', 'very poor': 'sehr schwach', critical: 'kritisch', unknown: 'unbekannt',
};
const label = (map: Record<string, string>, v: string | undefined) => (v ? map[v] ?? v : undefined);

function PiotroskiCard({ p }: { p: any }) {
  const score = p.score ?? 0;
  const max = p.maxScore ?? 8;
  const ratio = score / max;
  const color = ratio >= 0.75 ? 'text-emerald-400' : ratio <= 0.33 ? 'text-red-400' : 'text-amber-400';

  return (
    <ScoreCard
      title="Piotroski F-Score" term="metrics.piotroski.score"
      value={`${score}/${max}`}
      subtitle={label(PIOTROSKI_LABEL, p.interpretation)}
      color={color}
      body={
        <div className="flex gap-0.5">
          {Object.entries(p.signals ?? {}).map(([key, v]: [string, any], i: number) => (
            <Tip
              key={key}
              focusable={false}
              className={`block h-2 flex-1 rounded-sm ${
                v === null ? 'bg-ink-700' : v ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              content={
                <>
                  {signalText(key) ?? `F${i + 1}`}
                  <div className="mt-1 text-ink-400">{v === null ? 'Nicht berechenbar — zählt nicht mit.' : v ? 'Erfüllt.' : 'Nicht erfüllt.'}</div>
                </>
              }
            >
              {null}
            </Tip>
          ))}
        </div>
      }
    />
  );
}

function AltmanCard({ a }: { a: any }) {
  if (a.score === null) return <ScoreCard title="Altman Z-Score" term="metrics.altmanZ.score" value="—" color="text-ink-500" />;
  const color = a.zone === 'safe' ? 'text-emerald-400' : a.zone === 'distress' ? 'text-red-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Altman Z-Score" term="metrics.altmanZ.score"
      value={deNumber(a.score, 2)}
      subtitle={label(ALTMAN_ZONE, a.zone)}
      color={color}
      body={`${a.model === 'modified' ? 'Modifiziertes Modell' : 'Originalmodell'} · sicher > ${a.thresholds.safe.toLocaleString('de-DE')}, gefährdet < ${a.thresholds.distress.toLocaleString('de-DE')}`}
    />
  );
}

function BeneishCard({ b }: { b: any }) {
  if (b.score === null) return <ScoreCard title="Beneish M-Score" term="metrics.beneish.score" value="—" color="text-ink-500" body={`${b.variablesComputed}/8 Kennzahlen`} />;
  const color = b.probability === 'unlikely manipulator' ? 'text-emerald-400'
              : b.probability === 'likely manipulator'   ? 'text-red-400'
              : 'text-amber-400';
  return (
    <ScoreCard
      title="Beneish M-Score" term="metrics.beneish.score"
      value={deNumber(b.score, 2)}
      subtitle={label(BENEISH_LABEL, b.probability)}
      color={color}
      body={`${b.variablesComputed}/8 Kennzahlen berechnet`}
    />
  );
}

function SortinoCard({ s }: { s: any }) {
  if (s.ratio === null) return <ScoreCard title="Sortino-Ratio" term="metrics.sortino.ratio" value="—" color="text-ink-500" body="braucht mindestens 6 Monate Kursdaten" />;
  const color = s.ratio >= 2 ? 'text-emerald-400' : s.ratio >= 1 ? 'text-emerald-500'
              : s.ratio >= 0.5 ? 'text-amber-400' : 'text-red-400';
  return (
    <ScoreCard
      title="Sortino-Ratio" term="metrics.sortino.ratio"
      value={deNumber(s.ratio, 2)}
      subtitle={label(RATING_LABEL, s.interpretation)}
      color={color}
      body={`Rendite p. a. ${fmtPct(s.annualReturn)} · Abwärtsvolatilität ${fmtPct(s.downsideDeviation)}`}
    />
  );
}

function RuleOf40Card({ r }: { r: any }) {
  if (r.score === null) return <ScoreCard title="Rule of 40" term="metrics.ruleOf40.score" value="—" color="text-ink-500" />;
  const color = r.passes ? 'text-emerald-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Rule of 40" term="metrics.ruleOf40.score"
      value={deNumber(r.score, 1)}
      subtitle={r.passes ? 'erfüllt' : 'verfehlt'}
      color={color}
      body={`Umsatzwachstum ${fmt(r.revenueGrowthPct, ' %', 1)} + Marge ${fmt(r.profitMarginPct, ' %', 1)}`}
    />
  );
}

function InterestCard({ ic }: { ic: any }) {
  if (ic.ratio === null && ic.interpretation === 'unknown') {
    return <ScoreCard title="Zinsdeckung" term="metrics.interestCoverage.ratio" value="—" color="text-ink-500" />;
  }
  if (ic.ratio === null && ic.interpretation === 'excellent') {
    return <ScoreCard title="Zinsdeckung" term="metrics.interestCoverage.ratio" value="∞" subtitle="schuldenfrei" color="text-emerald-400" />;
  }
  const color = ic.interpretation === 'excellent' ? 'text-emerald-400'
              : ic.interpretation === 'good' ? 'text-emerald-500'
              : ic.interpretation === 'fair' ? 'text-amber-400'
              : ic.interpretation === 'poor' ? 'text-amber-500'
              : 'text-red-400';
  return (
    <ScoreCard
      title="Zinsdeckung" term="metrics.interestCoverage.ratio"
      value={`${fmt(ic.ratio, 'x', 1)}`}
      subtitle={label(RATING_LABEL, ic.interpretation)}
      color={color}
    />
  );
}
