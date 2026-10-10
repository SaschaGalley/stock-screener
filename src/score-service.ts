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
  NarrativeOutputSchema, NarrativeTheses, ScoreCard, SearchResult, SectorMedians, StockFinancials,
  SynthesisOutput, SynthesisOutputSchema, TechnicalSignals,
} from './types.js';
import { ComputedMetrics } from './analysis/computeMetrics.js';
import {
  FactorScoreInput, NARRATIVE_SAMPLES, blendScores, combineNarrativeReads, computeFactorScore, fairValueRange,
  narrativeScoreFrom,
} from './analysis/score.js';
import { renderFactorCard, scoreHeadline } from './output/score-card.js';
import {
  PromptData, buildDataSummaryPrompt, buildNarrativePrompt, buildSynthesisPrompt,
} from './output/prompt.js';
import { appendSearchResults } from './providers/base.js';
import { providerForTask } from './providers/factory.js';
import { DistillBundle } from './data/distill.js';
import {
  EVIDENCE_LABEL, PerplexityClaim, PerplexityContext, PerplexityFinding, PerplexityFindings, sourceLabel,
} from './data/perplexity.js';
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

/**
 * What each source may add to the narrative's confidence, at most.
 *
 * Set on 10 October 2026 by what each was measured to carry
 * (`measurements/quellen/BERICHT.md`). Read alone and in combination over ten
 * stocks, the brief and deep research set the narrative score; deep research
 * was the source that mattered most for eight of the nine that had one, and
 * moved the score by up to one and a half points. A Distill dossier moved it by
 * no more than three reads of one source spread among themselves, and carried
 * the most for none. Until then a dossier counted 0.5 for being there — a line
 * saying nothing was reported included — the brief at most 0.3, and deep
 * research only as the better of the two reports, so the source that carried
 * least set most of the narrative's weight. Distill reaches the stage only
 * when the administration lets it (`scoring.distill`).
 */
export const SOURCE_WEIGHT = {
  perplexity:      0.60,
  deepResearch:    0.30,
  companyDossier:  0.20,
  companyInsights: 0.10,
  sectors:         0.05,
  search:          0.10,
} as const;

/** Independent items at which a Perplexity report earns its full weight. */
const PERPLEXITY_FULL_WEIGHT_ITEMS = 6;

/**
 * A Perplexity report's share of its source weight: by its independent items
 * when it is structured — six or more earn all of it, none earns nothing — and
 * half when it is prose, which can be neither counted nor checked. The old
 * free-text brief counted in full, so a page of press-release paraphrase
 * bought the same weight as a page of dated contrary evidence.
 */
function reportShare(p: PerplexityContext): number {
  return p.findings ? Math.min(1, independentItems(p.findings) / PERPLEXITY_FULL_WEIGHT_ITEMS) : 0.5;
}

/**
 * Evidence that does not come from the company's own mouth.
 *
 * Bull claims count when they were checked against something — independently
 * confirmed or contradicted. A claim resting only on management's statements is
 * exactly the thing the brief exists to discount, and so is one resting only on
 * analysts' or commentators' views (`opinion`, a bull grade since 10 October
 * 2026).
 *
 * Bear claims do not count. They were added for the bull and bear case, not for
 * the weight, and whatever evidences them is already in `bearEvidence` —
 * counting both would raise the narrative's share of the headline merely by
 * asking one more question.
 */
function independentItems(f: PerplexityFindings): number {
  return f.events.filter((e) => e.independent).length
    + f.bearEvidence.filter((e) => e.independent).length
    + f.bullClaims.filter((c) => c.evidence === 'independent' || c.evidence === 'contradicted').length;
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
  deepResearch?: PerplexityContext | null,
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

  // Deep research is the same kind of source as the brief, searched harder, and
  // counts beside it rather than instead of it: side by side it found the
  // regulation, the competitors and the corrections the brief had missed. It
  // counts for less, because much of what it holds the brief holds too.
  if (perplexity?.synthesis?.trim()) {
    weight += SOURCE_WEIGHT.perplexity * reportShare(perplexity);
    sources.push('perplexity');
  }
  if (deepResearch?.synthesis?.trim()) {
    weight += SOURCE_WEIGHT.deepResearch * reportShare(deepResearch);
    sources.push('perplexity-deep');
  }

  if ((searchResults?.length ?? 0) > 0) {
    weight += SOURCE_WEIGHT.search;
    sources.push('search');
  }

  // Freshness is taken from the newest dated thing we have. The dossier window's
  // end is the right date for it: `builtAt` says when Distill last assembled the
  // tile, not how current the material in it is.
  const ages = [ageInDays(company?.periodEnd), ageInDays(perplexity?.fetchedAt), ageInDays(deepResearch?.fetchedAt)]
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
  /** A deep research report bought by hand, read beside the regular brief. */
  deepResearch?:    PerplexityContext | null;
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
    promptData, distill, perplexity, deepResearch, searchResults,
  } = input;
  const say = input.onStage ?? (() => {});

  // ── Stage 0: the arithmetic, before any model is involved ─────────────────
  const factor = computeFactorScore({
    financials: f, metrics, sectorMedians, marketSignals, technicalSignals,
  });
  say(`Faktor-Score ${factor.score.toFixed(1)}/10 → ${factor.verdict} (Konfidenz ${(factor.confidence * 100).toFixed(0)} %)`);

  const material = narrativeMaterial(distill, perplexity, searchResults, deepResearch);

  // ── Stages 1 + 2: two cheap summaries, neither seeing the other's input ────
  const summariser = providerForTask('summary', input.summaryModel);
  const narrator = material.empty
    ? null
    : providerForTask('summary', input.summaryModel, input.nativeSearch ?? false);

  say(`Zusammenfassungen mit ${input.summaryModel}…`);
  const [dataNote, narrativeReads] = await Promise.all([
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
      ? Promise.resolve<NarrativeOutput[]>([])
      // Several independent reads of the same prompt; see NARRATIVE_SAMPLES.
      // A read that fails is dropped rather than failing the others.
      : Promise.all(Array.from({ length: NARRATIVE_SAMPLES }, () => narrator.complete({
          label:  'narrative',
          system: SYSTEM_SUMMARISER,
          user:   appendSearchResults(buildNarrativePrompt(f, distill ?? undefined, perplexity ?? undefined, deepResearch ?? undefined), searchResults),
          schema: NarrativeOutputSchema,
          // Up to eight theses on top of the summary, events and five notes.
          maxTokens: 4000,
        }).catch((e): null => {
          logger.warn(`${f.symbol}: one narrative read failed (${(e as Error).message})`);
          return null;
        }))).then((reads) => reads.filter((r): r is NarrativeOutput => r !== null)),
  ]);

  // The score is computed from the dimensions, never taken from the model.
  const combined = combineNarrativeReads(
    narrativeReads.map((r) => ({ ...r, score: narrativeScoreFrom(r.dimensions) })),
  );
  if (narrator !== null && combined === null) {
    logger.warn(`${f.symbol}: every narrative read failed — headline falls back to the factor score`);
  }

  const narrative = combined === null ? null : {
    summary:    combined.read.summary,
    events:     combined.read.events,
    theses:     combined.read.theses,
    score:      combined.score,
    dimensions: combined.read.dimensions,
    confidence: material.confidence * combined.confidenceFactor,
    spread:     combined.spread,
    runs:       combined.runs,
    sources:    material.sources,
    // The model that read it, as the proxy routed it, where one did.
    model:      narrator?.usedModel ?? input.summaryModel,
    at:         new Date().toISOString(),
  };

  if (narrative) {
    const agreement = narrative.spread == null ? '' : ` (Median aus ${narrative.runs} Lesungen, Spanne ${narrative.spread.toFixed(1)})`;
    say(`Narrativ-Score ${narrative.score === null ? 'Enthaltung' : `${narrative.score.toFixed(1)}/10`}${agreement} aus ${material.sources.join(', ')}`);
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
    research:  [
      perplexity?.findings ? researchDigest(perplexity.findings) : '',
      deepResearch?.findings
        ? `Aus der Tiefenrecherche vom ${deepResearch.fetchedAt.slice(0, 10)} (bei Widerspruch gilt die neuere Quelle):\n\n${researchDigest(deepResearch.findings)}`
        : '',
    ].filter(Boolean).join('\n\n') || null,
    narrative: narrative && {
      summary: narrative.summary, events: narrative.events, score: narrative.score,
      sources: narrative.sources, theses: narrative.theses,
    },
    blendNote: blendNote(factor.score, narrative?.score ?? null, preview, input.adjustmentLimit ?? 1),
  });

  say(`Synthese mit ${input.synthesisModel}…`);
  const synthesis = await providerForTask('analysis', input.synthesisModel)
    .complete({
      label:  'synthesis',
      system: SYSTEM_SYNTHESIS,
      user:   synthesisPrompt,
      schema: SynthesisOutputSchema,
      // The largest of the three: two sides of up to nine points each and a
      // thesis over the longest prompt. GOOGL truncated at 2048 on the first
      // live run; the longer bullets, and since October their headlines, need
      // the headroom.
      maxTokens: 7000,
    })
    .catch((e): SynthesisOutput | null => {
      logger.warn(`${f.symbol}: synthesis failed — falling back to the computed findings (${(e as Error).message})`);
      return null;
    });

  const prose = synthesis ?? fallbackProse(factor, dataNote, narrative, f);

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

/**
 * The Perplexity findings the thesis may cite, compact.
 *
 * The synthesis used to see only the narrative summariser's paragraph, so its
 * bull and bear cases leaned on the one input it had in full: the pillar table.
 * These few lines are what makes a bull point about a checked claim, or a bear
 * point about a dated event, possible at all — without reopening the whole
 * prose the pipeline was built to keep out.
 */
function researchDigest(findings: PerplexityFindings): string {
  const line = (x: PerplexityFinding) =>
    `- ${x.date ? `${x.date} · ` : ''}${sourceLabel(x)} — ${x.what}`;
  // The argument travels with the claim: the theses are written from these,
  // and "AI adds wallet share — management-only" cannot be argued from.
  const claimLine = (c: PerplexityClaim) => [
    `- ${c.claim}${c.proponents ? ` (${c.proponents})` : ''} — ${EVIDENCE_LABEL[c.evidence] ?? c.evidence}: ${c.detail}`,
    c.mechanism && `  Wirkung: ${c.mechanism}`,
    c.stake     && `  Einsatz: ${c.stake}`,
    c.counter   && `  Dagegen: ${c.counter}`,
  ].filter(Boolean).join('\n');
  const claims = (title: string, list: PerplexityClaim[] | undefined) => list?.length
    ? `${title}:\n${list.slice(0, 5).map(claimLine).join('\n')}`
    : '';
  return [
    findings.debate?.length
      ? `Kerndebatte:\n${findings.debate.map((d) => `- ${d.question} ${d.why}${d.settles ? ` Entscheidet: ${d.settles}${d.when ? ` (${d.when})` : ''}` : ''}`).join('\n')}`
      : '',
    findings.events.length ? `Ereignisse:\n${findings.events.slice(0, 5).map(line).join('\n')}` : '',
    findings.bearEvidence.length ? `Belege gegen die Bullen-These:\n${findings.bearEvidence.slice(0, 5).map(line).join('\n')}` : '',
    claims('Geprüfte Bullen-Thesen', findings.bullClaims),
    claims('Geprüfte Bären-Thesen', findings.bearClaims),
    findings.kpis?.length
      ? `Operative Kennzahlen:\n${findings.kpis.map((k) => `- ${k.name}: ${k.values.map((v) => `${v.period} ${v.value}`).join(' → ')}${k.read ? ` — ${k.read}` : ''}`).join('\n')}`
      : '',
    findings.catalysts?.length
      ? `Termine:\n${findings.catalysts.map((c) => `- ${c.date ?? 'ohne Datum'}: ${c.event}${c.watch ? ` — ${c.watch}` : ''}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
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
\`adjustment\` wird danach addiert und auf ±${limit.toFixed(1)} Punkte begrenzt —
jenseits von 8 bzw. unter 2 wirkt es schwächer, weil sich die Skala dort ihren
Enden nur annähert. Deckel auf der Überzeugung bleiben davon unberührt.`;
}

/**
 * A verdict without a synthesis model.
 *
 * Not a neutral placeholder — the score is the one the arithmetic produced, the
 * figures are its own top findings, and the theses are the arguments the
 * narrative stage collected from the sources, unedited. The thesis says plainly
 * that no model wrote it, because a fallback that reads like the real thing is
 * worse than a visible gap.
 */
function fallbackProse(
  factor: ReturnType<typeof computeFactorScore>,
  dataNote: string | null,
  narrative: { summary: string; theses?: NarrativeTheses } | null,
  f: StockFinancials,
): SynthesisOutput {
  const pick = (kind: 'driver' | 'drag') =>
    factor.findings.filter((x) => x.kind === kind).slice(0, 3).map((x) => x.note);
  const atLeastOne = (rows: string[], filler: string) => (rows.length > 0 ? rows : [filler]);

  // Risks belong to the bear side now — caps, gaps and divergences with it.
  const risks = factor.findings
    .filter((x) => x.kind === 'cap' || x.kind === 'gap' || x.kind === 'divergence')
    .slice(0, 2)
    .map((x) => x.note);

  return {
    bullCase: {
      theses:   atLeastOne(narrative?.theses?.bull ?? [], 'Ohne Synthese und ohne Thesen aus den Quellen.'),
      figures:  atLeastOne(pick('driver'), 'Keine Säule trug den Score nennenswert.'),
      triggers: [],
    },
    bearCase: {
      theses:   atLeastOne([...(narrative?.theses?.bear ?? []), ...risks], 'Ohne Synthese und ohne Thesen aus den Quellen.'),
      figures:  atLeastOne(pick('drag'), 'Keine Säule belastete den Score nennenswert.'),
      triggers: [],
    },
    thesis: `Ohne Synthese-Modell erzeugt: ${f.symbol} erreicht ${factor.score.toFixed(1)}/10 (${factor.verdict}) aus der reinen Rechnung.`
      + (dataNote ? ` ${dataNote.split('. ')[0]}.` : '')
      + (narrative?.summary ? ` ${narrative.summary.split('. ')[0]}.` : ''),
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
    // The request, not what it amounted to: the applied figure was already
    // bent by `saturate`, and bending it again would shrink it twice.
    adjustment:          (prev?.final.adjustmentRequested ?? prev?.final.adjustment ?? 0) * decay,
    adjustmentReason:    prev?.final.adjustmentReason ?? null,
    narrativeMaxWeight:  input.narrativeMaxWeight,
    adjustmentLimit:     input.adjustmentLimit,
  });

  return { factor, dataNote: prev?.dataNote ?? null, narrative, final };
}
