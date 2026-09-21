/**
 * Three calls and a blend, in the order that keeps them honest.
 *
 * `analysis/score.ts` produces the number. This module produces the *words*
 * around it, and the reason it is a separate file is that words cost money and
 * can fail: every stage here degrades on its own, and a failure downgrades what
 * the verdict rests on rather than replacing it with a plausible-looking guess.
 *
 * The ordering constraints are all about contamination:
 *
 *   - The factor score is computed before any model is called, so nothing a
 *     model writes can reach it.
 *   - The two summarisers run in parallel and neither can see the other's input.
 *     The narrative one in particular is never shown a price, a multiple or a
 *     fair value — see `buildNarrativePrompt` for why that matters.
 *   - The synthesis model is told the blend arithmetic *before* it answers, so
 *     its `adjustment` is an argued exception to a stated rule rather than an
 *     opinion competing with one.
 *
 * What the pipeline can lose, and what that costs:
 *   data summary fails  → the synthesis reads the pillar table directly.
 *   narrative fails     → the headline is the factor score alone, and says so.
 *   synthesis fails     → the verdict is assembled from the findings, unchanged
 *                         in score, and marked as written without a model.
 */

import {
  DataSummaryOutputSchema, LLMAnalysis, MarketSignals, NarrativeOutput,
  NarrativeOutputSchema, ScoreCard, SearchResult, SectorMedians, StockFinancials,
  SynthesisOutput, SynthesisOutputSchema, TechnicalSignals,
} from './types.js';
import { ComputedMetrics } from './analysis/computeMetrics.js';
import { FactorScoreInput, computeFactorScore, blendScores, fairValueRange } from './analysis/score.js';
import { renderFactorCard, scoreHeadline } from './output/score-card.js';
import {
  PromptData, buildDataSummaryPrompt, buildNarrativePrompt, buildSynthesisPrompt,
} from './output/prompt.js';
import { appendSearchResults } from './providers/base.js';
import { createProviderForModel } from './providers/factory.js';
import { DistillBundle } from './data/distill.js';
import { PerplexityContext, PerplexityFindings } from './data/perplexity.js';
import { logger } from './utils/logger.js';

const SYSTEM_SUMMARISER =
  'Du bist ein Aktienanalyst und fasst zusammen. Du bewertest nicht, du erklärst. '
  + 'Antworte ausschließlich mit gültigem JSON nach dem angegebenen Schema.';

const SYSTEM_SYNTHESIS =
  'Du bist ein erfahrener Aktienanalyst. Du schreibst die Investment-These zu einem '
  + 'bereits berechneten Score. Antworte ausschließlich mit gültigem JSON nach dem '
  + 'angegebenen Schema.';

// ── Narrative confidence ─────────────────────────────────────────────────────

/**
 * How much the qualitative half is allowed to weigh, from the material itself.
 *
 * The summariser is not asked how sure it is. A self-reported confidence is one
 * more number nobody can check, and it would defeat the purpose of blending by
 * confidence in the first place. This counts what was actually there instead:
 * which sources arrived, and how old the newest of them is.
 */
export interface NarrativeMaterial {
  confidence: number;
  sources:    string[];
  /** True when there is nothing to summarise and the stage should be skipped. */
  empty:      boolean;
}

const SOURCE_WEIGHT = {
  companyDossier: 0.50,
  companyInsights: 0.30,
  perplexity:     0.30,
  sectors:        0.10,
  search:         0.10,
} as const;

/** Independent items at which a Perplexity brief earns its full weight. */
const PERPLEXITY_FULL_WEIGHT_ITEMS = 6;

/**
 * Evidence that does not come from the company's own mouth.
 *
 * Bull claims count when they were checked against something — independently
 * confirmed or contradicted. A claim resting only on management's statements is
 * exactly the thing the brief exists to discount.
 */
function independentItems(f: PerplexityFindings): number {
  return f.events.filter((e) => e.independent).length
    + f.bearEvidence.filter((e) => e.independent).length
    + f.bullClaims.filter((c) => c.evidence !== 'management-only').length;
}

/** Newest material this old, in days, scales everything down. */
function recencyFactor(ageDays: number | null): number {
  if (ageDays === null) return 0.7;   // undated material: neither fresh nor stale
  if (ageDays <= 7)  return 1.0;
  if (ageDays <= 21) return 0.85;
  if (ageDays <= 60) return 0.65;
  return 0.45;
}

function ageInDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : null;
}

export function narrativeMaterial(
  distill?: DistillBundle | null,
  perplexity?: PerplexityContext | null,
  searchResults?: SearchResult[],
): NarrativeMaterial {
  const sources: string[] = [];
  let weight = 0;

  const company = distill?.company ?? null;
  if (company?.content?.trim()) {
    weight += SOURCE_WEIGHT.companyDossier;
    sources.push('distill-company');
  } else if ((company?.insights?.items.length ?? 0) > 0) {
    weight += SOURCE_WEIGHT.companyInsights;
    sources.push('distill-company-insights');
  }

  const sectors = (distill?.sectors ?? []).filter((b) => b.content?.trim() || (b.insights?.items.length ?? 0) > 0);
  if (sectors.length > 0) {
    weight += SOURCE_WEIGHT.sectors;
    sources.push('distill-sector');
  }

  // Legacy, and nothing produces them any more — but a bundle written before
  // the dossier path still carries one, the prompt still renders it, and it is
  // company-level synthesis. Weighted only when there is no dossier to replace
  // it, otherwise the same company would be counted twice.
  if (distill?.briefing) {
    if (!sources.includes('distill-company')) weight += SOURCE_WEIGHT.companyInsights;
    sources.push('distill-briefing');
  }

  if (perplexity?.synthesis?.trim()) {
    // Weighted by what it found, not by having answered. The old free-text
    // synthesis always counted in full, so a page of press-release paraphrase
    // bought the same narrative weight as a page of dated contrary evidence.
    // A structured answer is weighed by its independent items — six or more
    // earns the full share, none earns nothing. An old unstructured row keeps
    // the flat weight until the prompt hash retires it.
    weight += perplexity.findings
      ? SOURCE_WEIGHT.perplexity * Math.min(1, independentItems(perplexity.findings) / PERPLEXITY_FULL_WEIGHT_ITEMS)
      : SOURCE_WEIGHT.perplexity;
    sources.push('perplexity');
  }

  if ((searchResults?.length ?? 0) > 0) {
    weight += SOURCE_WEIGHT.search;
    sources.push('search');
  }

  // Freshness is taken from the newest dated thing we have. The dossier window's
  // end is the right date for it: `builtAt` says when Distill last assembled the
  // tile, not how current the material in it is.
  const ages = [ageInDays(company?.periodEnd), ageInDays(perplexity?.fetchedAt)]
    .filter((a): a is number => a !== null);
  const newest = ages.length > 0 ? Math.min(...ages) : null;

  return {
    confidence: Math.min(1, weight) * recencyFactor(newest),
    sources,
    empty: weight === 0,
  };
}

// ── The pipeline ─────────────────────────────────────────────────────────────

export interface VerdictPipelineInput {
  financials:       StockFinancials;
  metrics:          ComputedMetrics;
  sectorMedians:    SectorMedians | null;
  marketSignals:    MarketSignals | null;
  technicalSignals: TechnicalSignals | null;
  promptData:       PromptData;
  distill?:         DistillBundle | null;
  perplexity?:      PerplexityContext | null;
  searchResults?:   SearchResult[];
  /** Model that writes the thesis. */
  synthesisModel:   string;
  /** Cheap model for the two summarisers. */
  summaryModel:     string;
  /** Native web search for the narrative stage, when the caller asked for it. */
  nativeSearch?:    boolean;
  narrativeMaxWeight?: number;
  adjustmentLimit?:    number;
  onStage?: (message: string) => void;
}

export interface VerdictPipelineResult {
  scoreCard:   ScoreCard;
  llmAnalysis: LLMAnalysis;
  /** Queries a native-search provider issued during the narrative stage. */
  nativeSearchQueries: string[];
}

export async function runVerdictPipeline(input: VerdictPipelineInput): Promise<VerdictPipelineResult> {
  const {
    financials: f, metrics, sectorMedians, marketSignals, technicalSignals,
    promptData, distill, perplexity, searchResults,
  } = input;
  const say = input.onStage ?? (() => {});

  // ── Stage 0: the arithmetic, before any model is involved ─────────────────
  const factor = computeFactorScore({
    financials: f, metrics, sectorMedians, marketSignals, technicalSignals,
  });
  say(`Faktor-Score ${factor.score.toFixed(1)}/10 → ${factor.verdict} (Konfidenz ${(factor.confidence * 100).toFixed(0)} %)`);

  const material = narrativeMaterial(distill, perplexity, searchResults);

  // ── Stages 1 + 2: two cheap summaries, neither seeing the other's input ────
  const summariser = createProviderForModel(input.summaryModel);
  const narrator = material.empty
    ? null
    : createProviderForModel(input.summaryModel, input.nativeSearch ?? false);

  say(`Zusammenfassungen mit ${input.summaryModel}…`);
  const [dataNote, narrativeOut] = await Promise.all([
    summariser.complete({
      label:  'data-summary',
      system: SYSTEM_SUMMARISER,
      user:   buildDataSummaryPrompt(f, renderFactorCard(factor, { criteria: true }), promptData),
      schema: DataSummaryOutputSchema,
      // Generous against the output actually wanted (a paragraph). On the
      // reasoning models this budget covers thinking too, and a stage that runs
      // out mid-JSON costs the whole call for nothing.
      maxTokens: 2500,
    }).then((r) => r.summary).catch((e) => {
      logger.warn(`${f.symbol}: data summary failed — synthesis will read the pillar table directly (${(e as Error).message})`);
      return null;
    }),

    narrator === null
      ? Promise.resolve<NarrativeOutput | null>(null)
      : narrator.complete({
          label:  'narrative',
          system: SYSTEM_SUMMARISER,
          user:   appendSearchResults(buildNarrativePrompt(f, distill ?? undefined, perplexity ?? undefined), searchResults),
          schema: NarrativeOutputSchema,
          maxTokens: 3000,
        }).catch((e) => {
          logger.warn(`${f.symbol}: narrative summary failed — headline falls back to the factor score (${(e as Error).message})`);
          return null;
        }),
  ]);

  const narrative = narrativeOut === null ? null : {
    summary:    narrativeOut.summary,
    events:     narrativeOut.events,
    score:      narrativeOut.score,
    confidence: material.confidence,
    sources:    material.sources,
    model:      input.summaryModel,
    at:         new Date().toISOString(),
  };

  if (narrative) {
    say(`Narrativ-Score ${narrative.score === null ? 'Enthaltung' : `${narrative.score.toFixed(1)}/10`} aus ${material.sources.join(', ')}`);
  }

  // ── Stage 3: the thesis, told the arithmetic before it answers ────────────
  const preview = blendScores({
    factor,
    narrativeScore:      narrative?.score ?? null,
    narrativeConfidence: narrative?.confidence ?? 0,
    adjustment:          0,
    adjustmentReason:    null,
    narrativeMaxWeight:  input.narrativeMaxWeight,
    adjustmentLimit:     input.adjustmentLimit,
  });

  const synthesisPrompt = buildSynthesisPrompt(f, {
    card:      renderFactorCard(factor),
    dataNote,
    narrative: narrative && { summary: narrative.summary, events: narrative.events, score: narrative.score, sources: narrative.sources },
    blendNote: blendNote(factor.score, narrative?.score ?? null, preview, input.adjustmentLimit ?? 1),
  });

  say(`Synthese mit ${input.synthesisModel}…`);
  const synthesis = await createProviderForModel(input.synthesisModel)
    .complete({
      label:  'synthesis',
      system: SYSTEM_SYNTHESIS,
      user:   synthesisPrompt,
      schema: SynthesisOutputSchema,
      // The largest of the three: nine bullets plus a thesis, and the longest
      // prompt. GOOGL truncated here on the first live run at 2048.
      maxTokens: 4000,
    })
    .catch((e): SynthesisOutput | null => {
      logger.warn(`${f.symbol}: synthesis failed — falling back to the computed findings (${(e as Error).message})`);
      return null;
    });

  const prose = synthesis ?? fallbackProse(factor, dataNote, narrative?.summary ?? null, f);

  const final = blendScores({
    factor,
    narrativeScore:      narrative?.score ?? null,
    narrativeConfidence: narrative?.confidence ?? 0,
    adjustment:          synthesis ? prose.adjustment : 0,
    adjustmentReason:    synthesis ? prose.adjustmentReason : null,
    narrativeMaxWeight:  input.narrativeMaxWeight,
    adjustmentLimit:     input.adjustmentLimit,
  });

  return {
    scoreCard: { factor, dataNote, narrative, final },
    llmAnalysis: {
      bullCase:          prose.bullCase,
      bearCase:          prose.bearCase,
      keyRisks:          prose.keyRisks,
      thesis:            prose.thesis,
      // Computed, not asked for — see `fairValueRange`.
      fairValueEstimate: fairValueRange(f, metrics.composite),
      // The headline is the blend, not the model's opinion of it.
      score:             final.score,
      recommendation:    final.verdict,
    },
    nativeSearchQueries: narrator?.getNativeSearchQueries() ?? [],
  };
}

/** The blend, spelled out for the model that is about to be allowed to nudge it. */
function blendNote(
  factorScore: number, narrativeScore: number | null,
  preview: ReturnType<typeof blendScores>, limit: number,
): string {
  const parts = narrativeScore === null
    ? `Es liegt kein verwertbarer Narrativ-Score vor, der Headline-Score ist daher der Faktor-Score: **${preview.blend.toFixed(1)}/10**.`
    : `Faktor-Score ${factorScore.toFixed(1)} mit Gewicht ${(preview.factorWeight * 100).toFixed(0)} %, `
      + `Narrativ-Score ${narrativeScore.toFixed(1)} mit Gewicht ${(preview.narrativeWeight * 100).toFixed(0)} % `
      + `→ **${preview.blend.toFixed(1)}/10**.`;

  return `${parts}

Die Gewichte sind die beiden Konfidenzen, nicht eine Meinung: schwache Daten
geben der Prosa Gewicht, dünne Prosa gibt es den Zahlen zurück. Dein
\`adjustment\` wird danach addiert und auf ±${limit.toFixed(1)} Punkte begrenzt;
Deckel auf der Überzeugung bleiben davon unberührt.`;
}

/**
 * A verdict without a synthesis model.
 *
 * Not a neutral placeholder — the score is the one the arithmetic produced, and
 * the bullets are its own top findings. The thesis says plainly that no model
 * wrote it, because a fallback that reads like the real thing is worse than a
 * visible gap.
 */
function fallbackProse(
  factor: ReturnType<typeof computeFactorScore>,
  dataNote: string | null,
  narrativeSummary: string | null,
  f: StockFinancials,
): SynthesisOutput {
  const pick = (kind: 'driver' | 'drag') =>
    factor.findings.filter((x) => x.kind === kind).slice(0, 3).map((x) => x.note);
  const pad = (rows: string[], filler: string) =>
    rows.length >= 2 ? rows : [...rows, filler, filler].slice(0, 2);

  const risks = factor.findings
    .filter((x) => x.kind === 'cap' || x.kind === 'gap' || x.kind === 'divergence')
    .slice(0, 3)
    .map((x) => x.note);

  return {
    bullCase: pad(pick('driver'), 'Keine Säule trug den Score nennenswert.'),
    bearCase: pad(pick('drag'),   'Keine Säule belastete den Score nennenswert.'),
    keyRisks: pad(risks, `Kein Synthese-Modell verfügbar — ${scoreHeadline(factor).replace(/\*\*/g, '')}`),
    thesis: `Ohne Synthese-Modell erzeugt: ${f.symbol} erreicht ${factor.score.toFixed(1)}/10 (${factor.verdict}) aus der reinen Rechnung.`
      + (dataNote ? ` ${dataNote.split('. ')[0]}.` : '')
      + (narrativeSummary ? ` ${narrativeSummary.split('. ')[0]}.` : ''),
    adjustment: 0,
    adjustmentReason: null,
  };
}

// ── Carrying a verdict forward ───────────────────────────────────────────────

/**
 * Today's arithmetic, yesterday's prose.
 *
 * The factor half is free to compute and changes every day the price does; the
 * narrative half costs a model call and describes a company, which changes far
 * more slowly. Recomputing only the cheap half is what turns the recorded score
 * into an actual daily series instead of a step function that moves whenever the
 * analysis step happens to run.
 *
 * The carried narrative decays. Its confidence was earned by material that was
 * fresh when it was read, and the read itself ages: at two months an unchanged
 * paragraph should not still be pulling the headline around. The synthesis
 * model's `adjustment` decays on exactly the same curve and for the same
 * reason — it was an exception argued from a specific event, not a standing
 * correction.
 *
 * Pure apart from the clock, which is injectable: the backfill re-scores three
 * months of stored snapshots by passing each row's own timestamp.
 */
export interface RescoreInput extends FactorScoreInput {
  /** The last stored card, or null for a stock that has never been analysed. */
  previous?: ScoreCard | null;
  narrativeMaxWeight?: number;
  adjustmentLimit?:    number;
  /** Epoch millis treated as "now". Defaults to the real clock. */
  now?: number;
}

export function rescore(input: RescoreInput): ScoreCard {
  const factor = computeFactorScore(input);
  const prev = input.previous ?? null;
  const now = input.now ?? Date.now();

  const narrative = prev?.narrative ?? null;
  const ageDays = narrative ? ((now - new Date(narrative.at).getTime()) / 86_400_000) : null;
  const decay = narrative ? recencyFactor(Number.isFinite(ageDays as number) ? ageDays : null) : 0;

  const final = blendScores({
    factor,
    narrativeScore:      narrative?.score ?? null,
    narrativeConfidence: (narrative?.confidence ?? 0) * decay,
    adjustment:          (prev?.final.adjustment ?? 0) * decay,
    adjustmentReason:    prev?.final.adjustmentReason ?? null,
    narrativeMaxWeight:  input.narrativeMaxWeight,
    adjustmentLimit:     input.adjustmentLimit,
  });

  return { factor, dataNote: prev?.dataNote ?? null, narrative, final };
}
