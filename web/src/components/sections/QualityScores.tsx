import type { ComputedMetrics } from '../../types';
import { fmt, fmtPct } from '../../format';

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
  title, value, subtitle, color, body,
}: { title: string; value: string; subtitle?: string; color: string; body?: React.ReactNode }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{title}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`font-mono text-xl font-bold tabular ${color}`}>{value}</span>
        {subtitle && <span className="text-[11px] text-ink-400">{subtitle}</span>}
      </div>
      {body && <div className="mt-2 text-[11px] text-ink-400">{body}</div>}
    </div>
  );
}

function PiotroskiCard({ p }: { p: any }) {
  const score = p.score ?? 0;
  const max = p.maxScore ?? 8;
  const ratio = score / max;
  const color = ratio >= 0.75 ? 'text-emerald-400' : ratio <= 0.33 ? 'text-red-400' : 'text-amber-400';

  return (
    <ScoreCard
      title="Piotroski F-Score"
      value={`${score}/${max}`}
      subtitle={p.interpretation?.toUpperCase()}
      color={color}
      body={
        <div className="flex gap-0.5">
          {Object.values(p.signals ?? {}).map((v: any, i: number) => (
            <div
              key={i}
              className={`h-2 flex-1 rounded-sm ${
                v === null ? 'bg-ink-700' : v ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              title={`F${i + 1}`}
            />
          ))}
        </div>
      }
    />
  );
}

function AltmanCard({ a }: { a: any }) {
  if (a.score === null) return <ScoreCard title="Altman Z-Score" value="N/A" color="text-ink-500" />;
  const color = a.zone === 'safe' ? 'text-emerald-400' : a.zone === 'distress' ? 'text-red-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Altman Z-Score"
      value={a.score.toFixed(2)}
      subtitle={`${a.zone} zone`}
      color={color}
      body={`${a.model} model · safe >${a.thresholds.safe}, distress <${a.thresholds.distress}`}
    />
  );
}

function BeneishCard({ b }: { b: any }) {
  if (b.score === null) return <ScoreCard title="Beneish M-Score" value="N/A" color="text-ink-500" body={`${b.variablesComputed}/8 indices`} />;
  const color = b.probability === 'unlikely manipulator' ? 'text-emerald-400'
              : b.probability === 'likely manipulator'   ? 'text-red-400'
              : 'text-amber-400';
  return (
    <ScoreCard
      title="Beneish M-Score"
      value={b.score.toFixed(2)}
      subtitle={b.probability}
      color={color}
      body={`${b.variablesComputed}/8 indices computed`}
    />
  );
}

function SortinoCard({ s }: { s: any }) {
  if (s.ratio === null) return <ScoreCard title="Sortino Ratio" value="N/A" color="text-ink-500" body="needs ≥6 months of data" />;
  const color = s.ratio >= 2 ? 'text-emerald-400' : s.ratio >= 1 ? 'text-emerald-500'
              : s.ratio >= 0.5 ? 'text-amber-400' : 'text-red-400';
  return (
    <ScoreCard
      title="Sortino Ratio"
      value={s.ratio.toFixed(2)}
      subtitle={s.interpretation}
      color={color}
      body={`Annual ${fmtPct(s.annualReturn)} · downside dev ${fmtPct(s.downsideDeviation)}`}
    />
  );
}

function RuleOf40Card({ r }: { r: any }) {
  if (r.score === null) return <ScoreCard title="Rule of 40" value="N/A" color="text-ink-500" />;
  const color = r.passes ? 'text-emerald-400' : 'text-amber-400';
  return (
    <ScoreCard
      title="Rule of 40"
      value={r.score.toFixed(1)}
      subtitle={r.passes ? 'PASSES' : 'fails'}
      color={color}
      body={`Rev growth ${r.revenueGrowthPct?.toFixed(1)}% + margin ${r.profitMarginPct?.toFixed(1)}%`}
    />
  );
}

function InterestCard({ ic }: { ic: any }) {
  if (ic.ratio === null && ic.interpretation === 'unknown') {
    return <ScoreCard title="Interest Coverage" value="N/A" color="text-ink-500" />;
  }
  if (ic.ratio === null && ic.interpretation === 'excellent') {
    return <ScoreCard title="Interest Coverage" value="∞" subtitle="debt-free" color="text-emerald-400" />;
  }
  const color = ic.interpretation === 'excellent' ? 'text-emerald-400'
              : ic.interpretation === 'good' ? 'text-emerald-500'
              : ic.interpretation === 'fair' ? 'text-amber-400'
              : ic.interpretation === 'poor' ? 'text-amber-500'
              : 'text-red-400';
  return (
    <ScoreCard
      title="Interest Coverage"
      value={`${fmt(ic.ratio, 'x', 1)}`}
      subtitle={ic.interpretation}
      color={color}
    />
  );
}
