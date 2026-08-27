/**
 * Which Distill sector entities a stock belongs to.
 *
 * Distill keeps sectors as entities of their own (`sector:information_technology`)
 * with their own rolling dossiers, so a stock's context is its company dossier
 * *plus* the dossiers of the sectors it sits in. Distill cannot work out that
 * membership itself — the `sector` field on a search hit is a different
 * taxonomy and is often empty — so the classification comes from us.
 *
 * Ours is Yahoo's, and the correspondence is declared here rather than looked
 * up. Distill does carry our sector names as aliases and they all resolve
 * correctly today — but aliases there can also arrive from reconciliation, and
 * a reconciliation that lands wrong is invisible from the outside. This module
 * has already measured three of them (see `HANDLE_BY_INDUSTRY`), and a single
 * bad alias on `Technology` would silently misfile fifteen of forty stocks.
 * A wrong entry here, by contrast, is a diff.
 *
 * So the table decides, and Distill's search *checks* it: `auditSectorAliases`
 * asks Distill what each of our terms resolves to and reports every
 * disagreement. That is the direction that catches a bad alias instead of
 * obeying it — and it is what turned up `consumer defensive` pointing at
 * `consumer_discretionary`.
 *
 * The result is a *set*, not a value: a stock can belong to more than one
 * Distill sector, and the moment it does, a single field would have to be
 * torn open.
 */

import {
  acceptsAutomatically,
  getDistillEntityTypes,
  searchDistillEntities,
} from './data/distill-entities.js';
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
 * Industry labels that name a Distill *sector*.
 *
 * Kept by hand, deliberately, because looking industries up the way sectors are
 * looked up is unsafe — and that is measured, not feared. Searching our industry
 * strings against `type=sector` returns confident, unambiguous, alias-tier hits
 * that mean something else:
 *
 *   Semiconductors        → materials               (they are Information Technology)
 *   Consumer Electronics  → consumer_discretionary  (Apple is Technology to us)
 *   Entertainment         → consumer_discretionary  (Netflix is Communication Services)
 *
 * Those are real aliases on Distill's side; they simply describe a different
 * level of its taxonomy than our industry labels do, and `ambiguous: false`
 * offers no protection because nothing is competing — the hit is just wrong for
 * our purpose. Sector *names* have no such collision: all eleven resolve
 * correctly. So sectors are derived and industries are declared.
 *
 * `aerospace_defense` is the only entry: it is a sector in Distill and an
 * industry in Yahoo, and it is what makes the mapping a set — Airbus is both
 * `industrials` (from its sector) and `aerospace_defense` (from its industry).
 */
const HANDLE_BY_INDUSTRY: Readonly<Record<string, string>> = {
  'aerospace & defense': 'aerospace_defense',
};

/**
 * Our sector vocabulary — Yahoo's eleven — and the Distill handle each names.
 *
 * Eleven of Distill's twelve are reachable from here; the twelfth,
 * `aerospace_defense`, comes from the industry table above, which is what makes
 * the result a set.
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

// ── The live vocabulary ──────────────────────────────────────────────────────

export type SectorVocabulary = ReadonlyMap<string, string>;

/** Re-read hourly: the list is a project setting, not a constant, but it also
 *  does not move often enough to justify a request per symbol. */
const VOCABULARY_TTL_MS = 60 * 60 * 1000;
let cachedVocabulary: { at: number; value: SectorVocabulary } | null = null;

/** Term → handle, for the life of the process. Sector aliases do not churn, and
 *  a watchlist has a handful of distinct sector strings between forty stocks. */
const handleByTerm = new Map<string, string | null>();
const warned = new Set<string>();

/** Forget everything cached — for tests and for a deliberate re-read. */
export function clearSectorCache(): void {
  cachedVocabulary = null;
  handleByTerm.clear();
  warned.clear();
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
  if (cachedVocabulary && Date.now() - cachedVocabulary.at < VOCABULARY_TTL_MS) {
    return cachedVocabulary.value;
  }

  const types = await getDistillEntityTypes(apiKey, baseUrl);
  const sector = types.find((t) => t.type === SECTOR_TYPE);
  const value: SectorVocabulary = new Map(Object.entries(sector?.canonicalValues ?? {}));

  if (!sector) logger.warn('Distill project has no `sector` entity type — no sector dossiers will be fetched.');
  else if (sector.dossierEligible === false) {
    logger.warn('Distill\'s `sector` type is not dossier-eligible — sector dossiers cannot be switched on.');
  }

  cachedVocabulary = { at: Date.now(), value };
  return value;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Our sector name → Distill's handle, by asking Distill.
 *
 * The accept policy is the same one company resolution uses, deliberately: the
 * question "may I take this hit without a human looking at it" has one answer
 * in this codebase, and a `name`-tier match is not it. That guard matters here —
 * before Distill aliased it, `Aerospace & Defense` matched only on the name of
 * an unrelated entity.
 *
 * Null means "we could not say", and the caller drops the sector rather than
 * guessing. Cached per term, including the misses, so an unmappable sector is
 * one request per process and not one per symbol.
 */
export async function resolveSectorHandle(
  term: string, apiKey: string, baseUrl: string,
): Promise<string | null> {
  const key = norm(term);
  if (!key) return null;

  const seen = handleByTerm.get(key);
  if (seen !== undefined) return seen;

  let handle: string | null = null;
  try {
    const result = await searchDistillEntities(term, apiKey, baseUrl, { type: SECTOR_TYPE, limit: 5 });
    const top = result.hits[0];
    if (top && acceptsAutomatically(top, result)) handle = top.handle || null;
  } catch (e) {
    // Not cached: a transport failure is not an answer, and the next sync
    // should ask again rather than inherit a shrug.
    logger.debug(`Distill sector lookup for "${term}" failed: ${(e as Error).message}`);
    return null;
  }

  handleByTerm.set(key, handle);
  if (!handle && !warned.has(key)) {
    warned.add(key);
    logger.warn(
      `Distill has no unambiguous sector for "${term}" — stocks in it get no sector dossier. `
      + 'Add it as an alias on the right sector entity in the Distill admin.',
    );
  }
  return handle;
}

/**
 * Every Distill sector handle a stock belongs to. Empty when we cannot say.
 *
 * The sector comes from Distill's aliases, the industry from the table above,
 * and a handle neither the vocabulary knows nor Distill returned is dropped.
 */
export async function sectorHandlesForSymbol(
  symbol: string, apiKey: string, baseUrl: string,
): Promise<string[]> {
  const financials = await readFinancialsLax(symbol);
  if (!financials) return [];

  const vocabulary = await loadSectorVocabulary(apiKey, baseUrl);
  if (vocabulary.size === 0) return [];

  const out = new Set<string>();
  for (const handle of [
    HANDLE_BY_SECTOR[norm(financials.sector)],
    HANDLE_BY_INDUSTRY[norm(financials.industry)],
  ]) {
    if (!handle) continue;
    if (vocabulary.has(handle)) out.add(handle);
    else warnOnce(handle, `Distill's vocabulary has no sector "${handle}" — check the table in src/distill-sectors.ts.`);
  }

  if (financials.sector && !HANDLE_BY_SECTOR[norm(financials.sector)]) {
    warnOnce(financials.sector, `No Distill sector mapped for "${financials.sector}" — ${symbol} and anything else in it get no sector dossier.`);
  }

  return [...out].sort();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface SectorAliasFinding {
  /** The term we asked Distill about. */
  term:     string;
  /** What our table says it is. */
  expected: string;
  /** What Distill's search answered, or null when it could not say. */
  actual:   string | null;
  /** How the hit was found — `name` never counts as an answer. */
  matchedOn: string | null;
}

/**
 * Ask Distill what each of our terms resolves to, and report every case where
 * it disagrees with the table.
 *
 * This is the direction that finds a bad alias rather than obeying one. A
 * disagreement is not automatically Distill's fault — our table can be the
 * stale one — but it is always worth a human's eye, and it is the artefact to
 * hand back to Distill when an alias arrived from a reconciliation that landed
 * wrong.
 */
export async function auditSectorAliases(
  apiKey: string, baseUrl: string,
): Promise<SectorAliasFinding[]> {
  const terms: [string, string][] = [
    ...Object.entries(HANDLE_BY_SECTOR),
    ...Object.entries(HANDLE_BY_INDUSTRY),
  ];

  const findings: SectorAliasFinding[] = [];
  for (const [term, expected] of terms) {
    let actual: string | null = null;
    let matchedOn: string | null = null;
    try {
      const result = await searchDistillEntities(term, apiKey, baseUrl, { type: SECTOR_TYPE, limit: 5 });
      const top = result.hits[0];
      if (top) {
        matchedOn = top.matchedOn;
        if (acceptsAutomatically(top, result)) actual = top.handle || null;
      }
    } catch (e) {
      logger.debug(`Distill sector audit for "${term}" failed: ${(e as Error).message}`);
      continue;
    }
    if (actual !== expected) findings.push({ term, expected, actual, matchedOn });
  }
  return findings;
}

/** Say what the audit found, once per sync, and only when it found something. */
export function reportSectorAliases(findings: readonly SectorAliasFinding[]): void {
  for (const f of findings) {
    logger.warn(
      `Distill's alias for "${f.term}" resolves to ${f.actual ?? 'nothing'}`
      + `${f.matchedOn ? ` (${f.matchedOn} tier)` : ''}, we map it to "${f.expected}". `
      + 'The table decides; this is worth reporting to Distill.',
    );
  }
}
