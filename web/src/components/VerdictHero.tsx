import type { CompositeFairValue } from '../types';
import { fmtPrice, fmtSignedPct, mosColor, mosBgColor, recommendationColor } from '../format';

interface Props {
  price: number;
  composite: CompositeFairValue;
  llm?: {
    score: number;
    recommendation: string;
    thesis: string;
  } | null;
  analyst: {
    targetMeanPrice: number | null;
    analystTargetLow: number | null;
    analystTargetHigh: number | null;
    analystTargetMedian: number | null;
    analystCount: number | null;
    analystStrongBuy: number | null;
    analystBuy: number | null;
    analystHold: number | null;
    analystSell: number | null;
    analystStrongSell: number | null;
  };
}

export default function VerdictHero({ price, composite, llm, analyst }: Props) {
  const compositeMoS = composite.primary.median !== null
    ? (composite.primary.median - price) / price
    : null;

  const analystMoS = analyst.targetMeanPrice !== null
    ? (analyst.targetMeanPrice - price) / price
    : null;

  return (
    <section className="grid gap-3 lg:grid-cols-3">
      {/* AI Verdict */}
      <Card title="AI Verdict">
        {llm ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-3">
              <span className={`rounded px-2.5 py-1 text-xs font-bold ${recommendationColor(llm.recommendation)}`}>
                {llm.recommendation}
              </span>
              <div className="flex items-center gap-1">
                <ScoreBar score={llm.score} />
                <span className="ml-1 font-mono text-sm font-semibold text-ink-100">{llm.score}/10</span>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-300">
              {llm.thesis}
            </p>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            No LLM analysis cached for these settings — use the right sidebar.
          </div>
        )}
      </Card>

      {/* Composite Intrinsic Value — Primary tier headline + Conservative sub-line */}
      <Card title="Composite Intrinsic Value">
        {composite.primary.median !== null ? (
          <div className="flex h-full flex-col">
            <div className={`rounded border px-3 py-2 ${mosBgColor(compositeMoS)}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] uppercase tracking-wider text-ink-400">
                  Primary · {composite.primary.models.length} models
                </span>
                <span className={`font-mono text-sm font-semibold ${mosColor(compositeMoS)}`}>
                  {fmtSignedPct(compositeMoS)}
                </span>
              </div>
              <div className="mt-1 font-mono text-2xl font-bold text-ink-50 tabular">
                {fmtPrice(composite.primary.median)}
              </div>
              <div className="mt-1 text-[11px] text-ink-400">
                Range: <span className="font-mono">{fmtPrice(composite.primary.min)} – {fmtPrice(composite.primary.max)}</span>
              </div>
            </div>

            {composite.conservative.median !== null && (
              <div className="mt-2 flex items-baseline justify-between rounded border border-ink-700 bg-ink-950 px-3 py-1.5 text-xs">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-ink-500">Conservative lens</span>
                  <span className="ml-1 text-ink-600">·</span>
                  <span className="ml-1 text-[10px] text-ink-500">{composite.conservative.models.length} models</span>
                </div>
                <span className="font-mono text-ink-300">{fmtPrice(composite.conservative.median)}</span>
              </div>
            )}

            <div className="mt-auto pt-2 flex items-center gap-1.5 text-[11px] text-ink-500">
              <span>conf {composite.confidence.toFixed(1)}/10</span>
              {composite.pctPrimaryUndervalued !== null && (
                <>
                  <span>·</span>
                  <span>{(composite.pctPrimaryUndervalued * 100).toFixed(0)}% of primary bullish</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            No applicable primary models
          </div>
        )}
      </Card>

      {/* Analyst Consensus */}
      <Card title="Analyst Consensus">
        {analyst.targetMeanPrice ? (
          <div className="flex h-full flex-col">
            <div className={`rounded border px-3 py-2 ${mosBgColor(analystMoS)}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] uppercase tracking-wider text-ink-400">Avg Target</span>
                <span className={`font-mono text-sm font-semibold ${mosColor(analystMoS)}`}>
                  {fmtSignedPct(analystMoS)}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold text-ink-50 tabular">
                  {fmtPrice(analyst.targetMeanPrice)}
                </span>
                {analyst.analystCount && (
                  <span className="text-[11px] text-ink-500">{analyst.analystCount} analysts</span>
                )}
              </div>
            </div>
            {analyst.analystTargetLow !== null && analyst.analystTargetHigh !== null && (
              <div className="mt-2 text-xs text-ink-400">
                Range: <span className="font-mono">{fmtPrice(analyst.analystTargetLow)}</span> – <span className="font-mono">{fmtPrice(analyst.analystTargetHigh)}</span>
                {analyst.analystTargetMedian && <> · median <span className="font-mono">{fmtPrice(analyst.analystTargetMedian)}</span></>}
              </div>
            )}
            <div className="mt-auto pt-2">
              <RatingBar a={analyst} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-500">
            No analyst coverage
          </div>
        )}
      </Card>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-ink-800 bg-ink-900 p-4">
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="font-mono text-xs text-ink-200">{value}</div>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className={`h-3 w-1.5 rounded-sm ${
            i < Math.round(score)
              ? score >= 7 ? 'bg-emerald-500' : score >= 4 ? 'bg-amber-500' : 'bg-red-500'
              : 'bg-ink-700'
          }`}
        />
      ))}
    </div>
  );
}

function RatingBar({ a }: { a: Props['analyst'] }) {
  const sb = a.analystStrongBuy  ?? 0;
  const b  = a.analystBuy        ?? 0;
  const h  = a.analystHold       ?? 0;
  const s  = a.analystSell       ?? 0;
  const ss = a.analystStrongSell ?? 0;
  const total = sb + b + h + s + ss;
  if (total === 0) return null;

  const buyPct = ((sb + b) / total) * 100;

  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded bg-ink-800">
        {sb > 0 && <div style={{ width: `${(sb / total) * 100}%` }} className="bg-emerald-500" />}
        {b  > 0 && <div style={{ width: `${(b  / total) * 100}%` }} className="bg-emerald-600" />}
        {h  > 0 && <div style={{ width: `${(h  / total) * 100}%` }} className="bg-amber-500" />}
        {s  > 0 && <div style={{ width: `${(s  / total) * 100}%` }} className="bg-red-500" />}
        {ss > 0 && <div style={{ width: `${(ss / total) * 100}%` }} className="bg-red-700" />}
      </div>
      <div className="flex justify-between text-[10px] text-ink-500">
        <span>SB {sb} · B {b} · H {h} · S {s} · SS {ss}</span>
        <span className={buyPct >= 60 ? 'text-emerald-400' : buyPct >= 40 ? 'text-amber-400' : 'text-red-400'}>
          {Math.round(buyPct)}% bullish
        </span>
      </div>
    </div>
  );
}
