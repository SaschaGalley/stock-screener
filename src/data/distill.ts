import { logger } from '../utils/logger.js';
import type { DistillEntityRef } from './distill-entities.js';
import type { DistillDossierContentState, DistillInsightWindow } from './distill-dossier.js';

// Re-exported so callers keep importing Distill's failure modes from one place.
export {
  DistillEntityGoneError,
  DistillEntityUnresolvedError,
  DistillUnauthorizedError,
} from './distill-errors.js';
export type { DistillUnresolvedReason } from './distill-errors.js';
export type {
  DistillDossierContentState,
  DistillInsight,
  DistillInsightWindow,
} from './distill-dossier.js';

/**
 * One briefing as returned by Distill's `GET /api/v1/briefings`. We only keep
 * the fields the analyser actually consumes — created_at, body, format, and
 * the briefing-type label are enough to render a section and weight it in the
 * LLM prompt.
 */
export interface DistillBriefing {
  id:                 string;
  briefingTypeId:     string;
  briefingTypeName:   string;
  title:              string;
  body:               string;
  format:             'plain' | 'markdown';
  language:           string;
  entityRefs:         string[];
  insightCount:       number;
  model:              string;
  /** USD cost of the LLM call that produced this briefing. Null for old rows. */
  costUsd:            number | null;
  createdAt:          string;
}

/**
 * One dossier, with enough provenance that the analysis prompt can label it.
 *
 * `kind` is not decoration. A sector dossier read as company-specific is the
 * observed failure mode, not a hypothetical one, so every block says out loud
 * what it is about and the prompt renders that label.
 */
export interface DistillDossierBlock {
  kind:        'company' | 'sector';
  /** `company:apple` / `sector:information_technology` — provenance in one string. */
  ref:         string;
  entityId:    string;
  displayName: string;
  state:       DistillDossierContentState;
  /** Half-open: the last moment covered lies *before* `periodEnd`. */
  periodStart: string | null;
  periodEnd:   string | null;
  builtAt:     string | null;
  stale:       boolean;
  /** Null unless `state` is `ready`. */
  content:     string | null;
  /**
   * What the dossier does not reproduce — raw, unsynthesised, and valid in
   * every state. When there is no dossier prose these *are* the material.
   * Never filter them: the membership rule is Distill's and is about
   * provenance, not dates (see `DistillInsightWindow`).
   */
  insights:    DistillInsightWindow | null;
}

/**
 * Bundle persisted per symbol and consumed by the prompt.
 *
 * The rolling dossiers are the payload: the company's own, the ones for the
 * sectors it sits in, and the raw insights none of them reproduce. Together
 * they cover everything up to the moment of the request, for free.
 */
export interface DistillBundle {
  ticker:    string;
  baseUrl:   string;
  /**
   * The rolling dossier prose — the company's own, and the sectors it sits in.
   * This is the primary payload: it is free where a briefing costs an LLM call,
   * and it carries a 30-day window rather than a point-in-time summary.
   * Absent in bundles written before the dossier path existed.
   */
  company?:  DistillDossierBlock | null;
  sectors?:  DistillDossierBlock[];
  /** The registry entity this bundle was fetched for — the UUID we called
   *  with, plus how the symbol mapped onto it. Absent only in bundles written
   *  before entity resolution existed, which the server may still serve from
   *  disk via its version-lax read. */
  entity?:   DistillEntityRef | null;
  /**
   * Legacy. Bundles written before the dossier path carry a briefing here and
   * the UI still renders one if it finds it; nothing produces them any more.
   * Deliberately not carried forward on write — a briefing from May pinned into
   * every future bundle would age silently into a lie.
   */
  briefing?: DistillBriefing | null;
  fetchedAt: string;
}

/** We only need the single currently-relevant briefing per ticker — no
 *  history, no list. limit=1 keeps the response tiny and matches the UI's
 *  single-briefing rendering. */
const DEFAULT_LIMIT = 1;


interface DistillBriefingRow {
  id:                 string;
  project_id?:        string;
  briefing_type_id:   string;
  briefing_type_name: string;
  entity_refs:        string[];
  title:              string;
  body:               string;
  format:             string;
  language:           string;
  insight_count:      number;
  model:              string;
  cost_usd:           number | string | null;
  created_at:         string;
}

interface DistillListResponse {
  data:   DistillBriefingRow[];
  total:  number;
  limit:  number;
  offset: number;
}

/** Numeric coercion for cost_usd — Postgres NUMERIC arrives as string over JSON. */
function toCost(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function normaliseBriefing(b: DistillBriefingRow): DistillBriefing {
  return {
    id:               b.id,
    briefingTypeId:   b.briefing_type_id,
    briefingTypeName: b.briefing_type_name,
    title:            b.title,
    body:             b.body,
    format:           b.format === 'markdown' ? 'markdown' : 'plain',
    language:         b.language,
    entityRefs:       b.entity_refs ?? [],
    insightCount:     b.insight_count ?? 0,
    model:            b.model,
    costUsd:          toCost(b.cost_usd),
    createdAt:        b.created_at,
  };
}
