/**
 * Which Distill sector entities a stock belongs to.
 *
 * Distill keeps sectors as entities of their own (`sector:information_technology`)
 * with their own rolling dossiers, so a stock's context is its company dossier
 * *plus* the dossiers of the sectors it sits in. Distill cannot work out that
 * membership itself — the `sector` field on a search hit is a different
 * taxonomy and is often empty — so the classification has to come from us.
 *
 * Ours is Yahoo's. Two vocabularies, and nothing to derive one from the other
 * with, so the correspondence below is a translation table rather than a
 * generated one. It is the only place that correspondence is stated, and
 * `auditSectorMapping` checks it against the live vocabulary on every sync, so a
 * renamed or added handle shows up as a warning instead of a silent miss.
 *
 * The mapping is deliberately a *set*, not a value: a stock can belong to more
 * than one Distill sector, and the moment it does, a single field would have to
 * be torn open.
 */

import { getDistillEntityTypes } from './data/distill-entities.js';
import { readFinancialsLax } from './db/store.js';
import { logger } from './utils/logger.js';

/** Distill's entity type whose canonical values are the sector vocabulary. */
const SECTOR_TYPE = 'sector';

/** `sector:<handle>` — the ref form Distill accepts alongside the UUID. */
export function sectorRef(handle: string): string {
  return `${SECTOR_TYPE}:${handle}`;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * Yahoo sector → Distill handle. Eleven of Distill's twelve are reachable this
 * way; the twelfth is below.
 */
const HANDLE_BY_SECTOR: Readonly<Record<string, string>> = {
  'basic materials':        'materials',
  'communication services': 'communication_services',
  'consumer cyclical':      'consumer_discretionary',
  'consumer defensive':     'consumer_staples',
  'energy':                 'energy',
  'financial services':     'financials',
  'healthcare':             'health_care',
  'industrials':            'industrials',
  'real estate':            'real_estate',
  'technology':             'information_technology',
  'utilities':              'utilities',
};

/**
 * Handles that are an *industry* in our taxonomy but a *sector* in Distill's.
 *
 * `aerospace_defense` is the only one today, and it is the reason this mapping
 * is a set: Yahoo files Airbus under sector Industrials, industry "Aerospace &
 * Defense", so the handle can only come from the industry field — and it comes
 * *in addition to* the sector's own handle, never instead of it.
 *
 * The limit of deriving this from Yahoo is worth knowing: Honeywell is
 * "Conglomerates" there, so its aerospace business is invisible to this table.
 * Widening it means hand-maintaining exceptions, which is a different trade.
 */
const HANDLE_BY_INDUSTRY: Readonly<Record<string, string>> = {
  'aerospace & defense': 'aerospace_defense',
};

export interface SectorInputs {
  sector?:   string | null;
  industry?: string | null;
}

/** Every Distill sector handle a stock belongs to. Empty when we cannot say. */
export function sectorHandlesFor(inputs: SectorInputs): string[] {
  const out = new Set<string>();
  const bySector   = HANDLE_BY_SECTOR[norm(inputs.sector)];
  const byIndustry = HANDLE_BY_INDUSTRY[norm(inputs.industry)];
  if (bySector)   out.add(bySector);
  if (byIndustry) out.add(byIndustry);
  return [...out].sort();
}

/** Every handle the table can ever produce — the audit's left-hand side. */
export function mappedHandles(): string[] {
  return [...new Set([
    ...Object.values(HANDLE_BY_SECTOR),
    ...Object.values(HANDLE_BY_INDUSTRY),
  ])].sort();
}

// ── The live vocabulary ──────────────────────────────────────────────────────

export type SectorVocabulary = ReadonlyMap<string, string>;

/** Re-read hourly: the list is a project setting, not a constant, but it also
 *  does not move often enough to justify a request per symbol. */
const VOCABULARY_TTL_MS = 60 * 60 * 1000;
let cached: { at: number; value: SectorVocabulary } | null = null;

/** Forget the cached vocabulary — for tests and for a deliberate re-read. */
export function clearSectorVocabulary(): void {
  cached = null;
}

/**
 * The project's sector vocabulary, `handle → display name`.
 *
 * Returns an empty map when the project has no sector type at all, which is a
 * legitimate configuration rather than a failure: the caller then simply has no
 * sector dossiers to fetch.
 */
export async function loadSectorVocabulary(
  apiKey: string,
  baseUrl: string,
): Promise<SectorVocabulary> {
  if (cached && Date.now() - cached.at < VOCABULARY_TTL_MS) return cached.value;

  const types = await getDistillEntityTypes(apiKey, baseUrl);
  const sector = types.find((t) => t.type === SECTOR_TYPE);
  const value: SectorVocabulary = new Map(Object.entries(sector?.canonicalValues ?? {}));

  if (!sector) logger.warn('Distill project has no `sector` entity type — no sector dossiers will be fetched.');
  else if (sector.dossierEligible === false) {
    logger.warn('Distill\'s `sector` type is not dossier-eligible — sector dossiers cannot be switched on.');
  }

  cached = { at: Date.now(), value };
  return value;
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface SectorMappingAudit {
  /** We map onto these, but Distill's vocabulary has no such handle — our table
   *  is stale, and every stock routed here would silently get no sector. */
  unknownTargets: string[];
  /** Distill has these, and no rule of ours can ever produce them. Not our bug
   *  to fix — it is the list the handover asks us to report back. */
  unreachable:    string[];
}

export function auditSectorMapping(vocabulary: SectorVocabulary): SectorMappingAudit {
  const ours = mappedHandles();
  return {
    unknownTargets: ours.filter((h) => !vocabulary.has(h)),
    unreachable:    [...vocabulary.keys()].filter((h) => !ours.includes(h)).sort(),
  };
}

/** Say what the audit found, once per sync, and only when it found something. */
export function reportSectorMapping(audit: SectorMappingAudit): void {
  if (audit.unknownTargets.length > 0) {
    logger.warn(
      `Distill sector mapping targets handles the registry does not have: ${audit.unknownTargets.join(', ')}. `
      + 'Stocks routed to them get no sector dossier — fix the table in src/distill-sectors.ts.',
    );
  }
  if (audit.unreachable.length > 0) {
    logger.debug(`Distill sectors our classification cannot produce: ${audit.unreachable.join(', ')}.`);
  }
}

/**
 * The sector handles one stock sits in, filtered to what the project defines.
 *
 * Lives here rather than next to either consumer because both the switch sync
 * and the prose assembly need it, and routing one through the other would close
 * an import cycle. A handle our table produces that the vocabulary lacks is
 * dropped — `auditSectorMapping` already names it, and asking Distill about a
 * sector it does not define would only add a 404 per run.
 */
export async function sectorHandlesForSymbol(
  symbol: string, apiKey: string, baseUrl: string,
): Promise<string[]> {
  const financials = await readFinancialsLax(symbol);
  if (!financials) return [];
  const vocabulary = await loadSectorVocabulary(apiKey, baseUrl);
  return sectorHandlesFor({ sector: financials.sector, industry: financials.industry })
    .filter((handle) => vocabulary.has(handle));
}
