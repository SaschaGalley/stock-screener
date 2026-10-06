import { useState, type ReactNode } from 'react';
import type { CompositeFairValue } from '../types';
import type { CoverageView } from '../../../src/stock-history-service';
import { CoverageStrip, CoverageTable } from './AnalystCoverage';
import { deNumber, mosColor, recommendationBarColor, relativeTime } from '../format';
import { useMoney } from '../currency';
import RecommendationBadge from './RecommendationBadge';
import VerdictEvidence, { FairValueEvidence } from './VerdictEvidence';
import Term from './Term';
import Tip from './Tip';
import { deProse } from './prose';
import type { GlossaryKey } from '../glossary';

interface Props {
  price: number;
  composite: CompositeFairValue;
  llm?: {
    score: number;
    recommendation: string;
    thesis: string;
    /** Reasons a cap held the label below its band; empty when none did. */
    capReasons?: string[];
  } | null;
  /** When the shown verdict was generated (ISO), or null when none is cached. */
  llmGeneratedAt?: string | null;
  /** Model that produced it — the verdict is only interpretable with both. */
  llmModel?: string | null;
  /** The flag combination on show, as the modal spells it. */
  flagsLabel: string;
  /** Open the picker: switch to another stored analysis, or compute one. */
  onOpenAnalysis: () => void;
  /**
   * How the score came about, full width under the three cards — part of the
   * verdict rather than a section of its own further down.
   */
  breakdown?: ReactNode;
  /** When the verdict last changed band, under the verdict it changed. */
  verdictChanges?: ReactNode;
  /** Each firm's newest target and grade, behind the consensus card's figures. */
  coverage?: CoverageView | null;
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

/** What a verdict tells a reader to do, under its badge. */
const VERDICT_MEANING: Record<string, string> = {
  'STRONG BUY':  'Klar kaufenswert',
  BUY:           'Kaufenswert',
  HOLD:          'Halten — weder klar kaufen noch verkaufen',
  SELL:          'Eher verkaufen',
  'STRONG SELL': 'Klar meiden',
};

/** "1,7 % unter dem Kurs" */
const vsPrice = (v: number, price: number) => {
  const d = v / price - 1;
  return Math.abs(d) < 0.005 ? 'auf Kurshöhe' : `${deNumber(Math.abs(d * 100), 1)} % ${d > 0 ? 'über' : 'unter'} dem Kurs`;
};

/**
 * The verdict and the two figures it is weighed against. The verdict runs
 * the page's width, so its reasoning reads as a paragraph rather than a
 * column of twelve lines; under it what the models and the analysts say the
 * stock is worth, each answered in a figure and a phrase before its detail.
 */
export default function VerdictHero({
  price, composite, llm, llmGeneratedAt, llmModel, flagsLabel, onOpenAnalysis, analyst, breakdown, verdictChanges,
  coverage = null,
}: Props) {
  const { fmtPrice } = useMoney();
  const [showFirms, setShowFirms] = useState(false);
  const p = composite.primary;
  const compositeMoS = p.median !== null ? (p.median - price) / price : null;
  const analystMoS = analyst.targetMeanPrice !== null ? (analyst.targetMeanPrice - price) / price : null;

  return (
    <section className="space-y-3">
      <Card
        // Not "AI Verdict" any more, and the rename is the honest part: the
        // score is arithmetic blended with a prose read, and only the sentence
        // underneath it was written by a model.
        title="Urteil"
        info="card.verdict"
        // Which stored analysis this is — the one question the card cannot
        // answer on its own — and the way to change it.
        meta={
          <span className="flex min-w-0 items-center gap-2">
            {llm && llmGeneratedAt && (
              <Tip focusable={false} content={`Erstellt am ${new Date(llmGeneratedAt).toLocaleString('de-DE')}${llmModel ? ` mit ${llmModel}` : ''}`}>
                <time className="shrink-0" dateTime={llmGeneratedAt}>{relativeTime(llmGeneratedAt)}</time>
              </Tip>
            )}
            <Tip focusable={false} content="Gespeicherte Analysen ansehen oder neu rechnen">
              <button
                onClick={onOpenAnalysis}
                className="flex max-w-[18rem] items-center gap-1 truncate rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-2xs text-ink-300 transition hover:border-ink-600 hover:bg-ink-800 hover:text-ink-100"
              >
                <span className="truncate">{flagsLabel}</span>
                <span aria-hidden className="shrink-0 text-ink-500">▾</span>
              </button>
            </Tip>
          </span>
        }
      >
        {llm ? (
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-[12rem_minmax(0,1fr)]">
            <div>
              <RecommendationBadge rec={llm.recommendation} score={llm.score} heldBack={llm.capReasons ?? []} />
              <div className="mt-2 flex items-center gap-2">
                <ScoreBar score={llm.score} recommendation={llm.recommendation} />
                <span className="font-mono text-sm font-semibold text-ink-100">{deNumber(llm.score, 1)} von 10</span>
              </div>
              <p className="mt-1.5 text-sm text-ink-400">{VERDICT_MEANING[llm.recommendation] ?? ''}</p>
            </div>
            <div className="min-w-0">
              <p className="max-w-3xl text-[15px] leading-relaxed text-ink-100">{deProse(llm.thesis)}</p>
              <VerdictEvidence verdict={llm.recommendation} />
              {verdictChanges}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-4 text-center">
            <p className="text-sm text-ink-500">Für diese Kombination liegt noch keine Analyse vor.</p>
            <button
              onClick={onOpenAnalysis}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-dark"
            >
              Analyse starten…
            </button>
            {verdictChanges}
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Was ist sie wert?" info="card.composite">
          {p.median !== null ? (
            <div className="flex h-full flex-col">
              <Headline value={fmtPrice(p.median)} note={vsPrice(p.median, price)} mos={compositeMoS} />
              <p className="mt-1 text-sm text-ink-400">
                <Term k="concept.modelRange">Mitte aus {p.models.length} marktnahen Modellen</Term>
                {p.min !== null && p.max !== null && <> — sie reichen von <span className="font-mono text-ink-200">{fmtPrice(p.min)}</span> bis <span className="font-mono text-ink-200">{fmtPrice(p.max)}</span>.</>}
              </p>
              <ModelRange price={price} t={p} fmtPrice={fmtPrice} />
              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                {composite.conservative.median !== null && (
                  <Line label={<Term k="metrics.composite.conservative.median">Vorsichtig gerechnet</Term>}>
                    <span className="font-mono text-ink-100">{fmtPrice(composite.conservative.median)}</span>
                    <span className="ml-2 text-ink-400">{vsPrice(composite.conservative.median, price)}</span>
                  </Line>
                )}
                <Line label={<Term k="metrics.composite.confidence">Verlässlichkeit</Term>}>
                  <span className="text-ink-100">{Number.isFinite(composite.confidence) ? deNumber(composite.confidence, 1) : '—'} von 10</span>
                  {composite.pctPrimaryUndervalued != null && (
                    <span className="ml-2 text-ink-400">
                      <Term k="metrics.composite.pctPrimaryUndervalued">{Math.round(composite.pctPrimaryUndervalued * 100)} % der Modelle über dem Kurs</Term>
                    </span>
                  )}
                </Line>
              </dl>
              <div className="mt-auto"><FairValueEvidence price={price} primary={p} /></div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink-500">Kein marktnahes Modell anwendbar</div>
          )}
        </Card>

        <Card title="Was sagen die Analysten?" info="card.analysts">
          {analyst.targetMeanPrice ? (
            <div className="flex h-full flex-col">
              <Headline value={fmtPrice(analyst.targetMeanPrice)} note={vsPrice(analyst.targetMeanPrice, price)} mos={analystMoS} />
              <p className="mt-1 text-sm text-ink-400">
                <Term k="financials.targetMeanPrice">Mittleres Kursziel</Term>{analyst.analystCount ? ` von ${analyst.analystCount} Analysten` : ''}
                {analyst.analystTargetLow !== null && analyst.analystTargetHigh !== null && (
                  <> — die Ziele reichen von <span className="font-mono text-ink-200">{fmtPrice(analyst.analystTargetLow)}</span> bis <span className="font-mono text-ink-200">{fmtPrice(analyst.analystTargetHigh)}</span><TargetDispersion a={analyst} />.</>
                )}
              </p>
              {coverage && <CoverageStrip coverage={coverage} price={price} mean={analyst.targetMeanPrice} />}
              <div className="mt-auto pt-3">
                <RatingBar a={analyst} />
                {coverage && (
                  <button
                    onClick={() => setShowFirms((x) => !x)}
                    aria-expanded={showFirms}
                    className="mt-2 text-xs text-ink-400 transition hover:text-ink-100"
                  >
                    {showFirms ? 'Häuser ausblenden ▴' : `Alle ${coverage.firms.length} Häuser einzeln ▾`}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-ink-500">Keine Analysten-Abdeckung</div>
          )}
        </Card>
      </div>

      {coverage && showFirms && <CoverageTable coverage={coverage} price={price} analystCount={analyst.analystCount} />}

      {breakdown}
    </section>
  );
}

/** A figure and how it stands against the price, the answer of a card. */
function Headline({ value, note, mos }: { value: string; note: string; mos: number | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-mono text-2xl font-bold text-ink-50 tabular">{value}</span>
      <Term k="concept.upside" className={`text-sm font-semibold ${mosColor(mos)}`}>{note}</Term>
    </div>
  );
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-ink-400">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The models' spread as a line, their middle half as a band, the middle and the price as ticks — each named. */
function ModelRange({ price, t, fmtPrice }: { price: number; t: CompositeFairValue['primary']; fmtPrice: (n: number | null) => string }) {
  if (t.min === null || t.max === null || t.median === null || !(price > 0)) return null;
  const lo = Math.min(t.min, price), hi = Math.max(t.max, price);
  const x = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  return (
    <div className="mt-4 mb-1">
      <div className="relative h-3">
        <div className="absolute inset-y-[5px] rounded bg-ink-600" style={{ left: `${x(t.min)}%`, right: `${100 - x(t.max)}%` }} />
        {t.p25 !== null && t.p75 !== null && (
          <div className="absolute inset-y-[2px] rounded bg-emerald-600/60" style={{ left: `${x(t.p25)}%`, right: `${100 - x(t.p75)}%` }} />
        )}
        <div className="absolute -inset-y-0.5 w-0.5 bg-emerald-400" style={{ left: `${x(t.median)}%` }} />
        <div className="absolute -inset-y-1 w-0.5 bg-ink-50" style={{ left: `${x(price)}%` }} />
      </div>
      <div className="relative mt-1 h-4 text-2xs">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-ink-200" style={{ left: `${Math.min(90, Math.max(10, x(price)))}%` }}>▲ Kurs</span>
      </div>
      <div className="flex justify-between text-2xs text-ink-500">
        <span className="font-mono">{fmtPrice(t.min)}</span>
        <span className="hidden xl:inline">grün die mittlere Hälfte, Strich die Mitte</span>
        <span className="font-mono">{fmtPrice(t.max)}</span>
      </div>
    </div>
  );
}

/** `meta` sits right-aligned in the header — provenance, not content. */
function Card({ title, info, meta, children }: { title: string; info?: GlossaryKey; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-ink-700 bg-ink-900 p-4">
      {/* Wraps, so a long analysis label moves under the title on a phone instead of widening every card. */}
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h3 className="text-[15px] font-semibold text-ink-50"><Term k={info}>{title}</Term></h3>
        {meta && <span className="min-w-0 text-2xs text-ink-500">{meta}</span>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * Ten segments filled to the score, coloured by the recommendation.
 *
 * The colour deliberately does NOT come from the score: the two are separate
 * LLM outputs with no enforced relationship, so a score-derived colour could
 * contradict the badge right next to it (a BUY at 6.8 rendering amber). One
 * rounding, one colour source — the bar can only ever restate the verdict.
 */
function ScoreBar({ score, recommendation }: { score: number; recommendation: string }) {
  const filled = Math.round(score);
  const fill   = recommendationBarColor(recommendation);
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className={`h-3 w-1.5 rounded-sm ${i < filled ? fill : 'bg-ink-700'}`} />
      ))}
    </div>
  );
}

/**
 * How far apart the analysts are. A mean target of $145 means one thing when
 * every analyst sits between $135 and $155 and another when they range from $72
 * to $248 — the second is a consensus in name only. Range over mean, because
 * Yahoo gives the extremes but not the spread of the targets between them.
 */
function TargetDispersion({ a }: { a: Props['analyst'] }) {
  const { analystTargetHigh: hi, analystTargetLow: lo, targetMeanPrice: mean } = a;
  if (hi === null || lo === null || mean === null || mean <= 0 || (a.analystCount ?? 0) < 3) return null;
  const spread = (hi - lo) / mean;
  const [word, cls] = spread <= 0.35 ? ['recht einig', 'text-emerald-400']
    : spread <= 0.7 ? ['uneins', 'text-amber-400']
    : ['weit auseinander', 'text-red-400'];
  return (
    <>, <Term k="concept.targetDispersion" extra={`Die Spanne ist ${Math.round(spread * 100)} % des mittleren Ziels.`} className={cls}>{word}</Term></>
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
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-300">Was sie raten</span>
        <span className={buyPct >= 60 ? 'text-emerald-400' : buyPct >= 40 ? 'text-amber-400' : 'text-red-400'}>
          {Math.round(buyPct)} % raten zum Kauf
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded bg-ink-800">
        {sb > 0 && <div style={{ width: `${(sb / total) * 100}%` }} className="bg-emerald-500" />}
        {b  > 0 && <div style={{ width: `${(b  / total) * 100}%`, opacity: 0.7 }} className="bg-emerald-500" />}
        {h  > 0 && <div style={{ width: `${(h  / total) * 100}%` }} className="bg-amber-500" />}
        {s  > 0 && <div style={{ width: `${(s  / total) * 100}%`, opacity: 0.7 }} className="bg-red-500" />}
        {ss > 0 && <div style={{ width: `${(ss / total) * 100}%` }} className="bg-red-500" />}
      </div>
      <Term k="concept.ratingCounts" className="block text-xs text-ink-400">
        Kaufen {sb + b}{sb ? ` (davon ${sb} stark)` : ''} · Halten {h} · Verkaufen {s + ss}{ss ? ` (davon ${ss} stark)` : ''}
      </Term>
    </div>
  );
}
