import type { ComputedMetrics } from '../../types';
import { fmt, fmtPct } from '../../format';
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
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500"><Term k={term}>{title}</Term></div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`font-mono text-xl font-bold tabular ${color}`}>{value}</span>
        {subtitle && <span className="text-[11px] text-ink-400">{subtitle}</span>}
      </div>
      {body && <div className="mt-2 text-[11px] text-ink-400">{body}</div>}
    </div>
  );
}

/** A Piotroski signal's explanation, by the key the metrics carry it under. */
function signalText(key: string): string | null {
  const k = `metrics.piotroski.signals.${key}`;
  return k in GLOSSARY ? GLOSSARY[k as GlossaryKey] : null;
}

function PiotroskiCard({ p }: { p: any }) {
  const score = p.score ?? 0;
  const max = p.maxScore ?? 8;
  const ratio = score / max;
  const color = ratio >= 0.75 ? 'text-emerald-400' : ratio <= 0.33 ? 'text-red-400' : 'text-amber-400';

  return (
    <ScoreCard
      title="Piotroski F-Score" term="metrics.piotroski.score"
      value={`${score}/${max}`}
      subtitle={p.interpretation?.toUpperCase()}
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
  if (a.score === null) return <ScoreCard title="Altman Z-Score" term="metrics.altmanZ.score" value="N/A" color="text-ink-500" />;
  const color = a.zone === 'safe' ? 'text-emerald-400' : a.zone === 'distress' ? 'text-red-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Altman Z-Score" term="metrics.altmanZ.score"
      value={a.score.toFixed(2)}
      subtitle={`${a.zone} zone`}
      color={color}
      body={`${a.model} model · safe >${a.thresholds.safe}, distress <${a.thresholds.distress}`}
    />
  );
}

function BeneishCard({ b }: { b: any }) {
  if (b.score === null) return <ScoreCard title="Beneish M-Score" term="metrics.beneish.score" value="N/A" color="text-ink-500" body={`${b.variablesComputed}/8 indices`} />;
  const color = b.probability === 'unlikely manipulator' ? 'text-emerald-400'
              : b.probability === 'likely manipulator'   ? 'text-red-400'
              : 'text-amber-400';
  return (
    <ScoreCard
      title="Beneish M-Score" term="metrics.beneish.score"
      value={b.score.toFixed(2)}
      subtitle={b.probability}
      color={color}
      body={`${b.variablesComputed}/8 indices computed`}
    />
  );
}

function SortinoCard({ s }: { s: any }) {
  if (s.ratio === null) return <ScoreCard title="Sortino Ratio" term="metrics.sortino.ratio" value="N/A" color="text-ink-500" body="needs ≥6 months of data" />;
  const color = s.ratio >= 2 ? 'text-emerald-400' : s.ratio >= 1 ? 'text-emerald-500'
              : s.ratio >= 0.5 ? 'text-amber-400' : 'text-red-400';
  return (
    <ScoreCard
      title="Sortino Ratio" term="metrics.sortino.ratio"
      value={s.ratio.toFixed(2)}
      subtitle={s.interpretation}
      color={color}
      body={`Annual ${fmtPct(s.annualReturn)} · downside dev ${fmtPct(s.downsideDeviation)}`}
    />
  );
}

function RuleOf40Card({ r }: { r: any }) {
  if (r.score === null) return <ScoreCard title="Rule of 40" term="metrics.ruleOf40.score" value="N/A" color="text-ink-500" />;
  const color = r.passes ? 'text-emerald-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Rule of 40" term="metrics.ruleOf40.score"
      value={r.score.toFixed(1)}
      subtitle={r.passes ? 'PASSES' : 'fails'}
      color={color}
      body={`Rev growth ${r.revenueGrowthPct?.toFixed(1)}% + margin ${r.profitMarginPct?.toFixed(1)}%`}
    />
  );
}

function InterestCard({ ic }: { ic: any }) {
  if (ic.ratio === null && ic.interpretation === 'unknown') {
    return <ScoreCard title="Interest Coverage" term="metrics.interestCoverage.ratio" value="N/A" color="text-ink-500" />;
  }
  if (ic.ratio === null && ic.interpretation === 'excellent') {
    return <ScoreCard title="Interest Coverage" term="metrics.interestCoverage.ratio" value="∞" subtitle="debt-free" color="text-emerald-400" />;
  }
  const color = ic.interpretation === 'excellent' ? 'text-emerald-400'
              : ic.interpretation === 'good' ? 'text-emerald-500'
              : ic.interpretation === 'fair' ? 'text-amber-400'
              : ic.interpretation === 'poor' ? 'text-amber-500'
              : 'text-red-400';
  return (
    <ScoreCard
      title="Interest Coverage" term="metrics.interestCoverage.ratio"
      value={`${fmt(ic.ratio, 'x', 1)}`}
      subtitle={ic.interpretation}
      color={color}
    />
  );
}
