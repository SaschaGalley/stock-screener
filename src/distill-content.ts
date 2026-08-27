/**
 * Assemble the Distill prose a stock's analysis gets: its company dossier plus
 * the dossiers of the sectors it sits in.
 *
 * This replaces the briefing call as the normal path, for two reasons that both
 * matter. `GET /entities/{ref}/dossier/content` is **free**, where
 * `POST /briefings/refresh` spends an LLM call per symbol per night on Distill's
 * instance. And it returns a rolling 30-day window instead of a point-in-time
 * summary, which is a better fit for a screener that re-reads the same forty
 * stocks every night.
 *
 * What the dossier path cannot give is *today*: the window closes at the start
 * of the current day by construction. The briefing therefore stays, demoted to
 * a fallback for the entity that has no dossier yet — a stock just added, or a
 * sector switched on this afternoon.
 *
 * Sits above `distill-service.ts` (entity resolution), `distill-sectors.ts`
 * (classification) and `distill-dossiers.ts` (the switch), and is imported by
 * none of them — which is what keeps those three free of each other.
 */

import { getConfig } from './config.js';
import type { DistillMode } from './app-config.js';
import { readDistillLax, writeDistill } from './db/store.js';
import {
  DistillBundle,
  DistillDossierBlock,
  triggerDistillRefresh,
} from './data/distill.js';
import { getDistillDossierContent } from './data/distill-dossier.js';
import { DistillEntityGoneError } from './data/distill-errors.js';
import {
  DistillEntityHints,
  DistillEntityRef,
  withResolvedEntity,
} from './distill-service.js';
import { dossiersFollow } from './distill-dossiers.js';
import { loadSectorVocabulary, sectorHandlesForSymbol, sectorRef } from './distill-sectors.js';
import { logger } from './utils/logger.js';

/** What we asked Distill for, before we know whether it had anything. */
interface DossierTarget {
  kind:        'company' | 'sector';
  /** UUID for a company (we hold identifiers, not handles); `sector:x` otherwise. */
  ref:         string;
  /** The ledger's key for this target — a ticker, or a bare sector handle.
   *  Distinct from `ref`, which is what Distill is addressed by, and from
   *  `displayName`, which is what a human reads. */
  subject:     string;
  displayName: string;
}

/**
 * Read one dossier and turn it into a block.
 *
 * The four states are four different situations and only one of them is a
 * problem worth acting on here:
 *
 *   ready       take the prose
 *   empty       built, nothing happened in the window — not a failure, skip
 *   not_built   switched on, sweep has not reached it — the fallback's job
 *   not_enabled the switch is off, which should not happen once the sync has
 *               run. Self-heal by switching it on through the ledger, so the
 *               state stays honest, and let the fallback cover tonight.
 *
 * Never throws: Distill prose is optional context, and a stock must still be
 * analysable when its dossier is missing.
 */
async function readBlock(
  target: DossierTarget, apiKey: string, baseUrl: string,
): Promise<DistillDossierBlock | null> {
  let content;
  try {
    content = await getDistillDossierContent(target.ref, apiKey, baseUrl);
  } catch (e) {
    // A 404 here means Distill does not know the entity at all. For a company
    // that is the resolver's problem and already recorded; for a sector it
    // means the vocabulary and the registry disagree.
    const why = e instanceof DistillEntityGoneError ? 'unknown to Distill' : (e as Error).message;
    logger.debug(`Distill dossier for ${target.ref}: ${why}`);
    return null;
  }

  if (content.state === 'not_enabled') {
    logger.info(`Distill dossier for ${target.ref} was off — switching it on; tonight's build will fill it.`);
    // Through the ledger rather than a bare PUT, so the switch we just set is
    // the switch the next sync sees.
    await dossiersFollow([{ kind: target.kind, subject: target.subject, enabled: true }])
      .catch(() => { /* dossiersFollow records its own failures */ });
  }

  const body = content.dossier;
  return {
    kind:        target.kind,
    ref:         content.ref || target.ref,
    entityId:    content.id,
    displayName: target.displayName,
    state:       content.state,
    periodStart: body?.periodStart ?? null,
    periodEnd:   body?.periodEnd ?? null,
    builtAt:     body?.builtAt ?? null,
    stale:       body?.stale ?? false,
    content:     body?.content ?? null,
  };
}

/** Did this block actually bring prose? */
export function hasProse(block: DistillDossierBlock | null | undefined): boolean {
  return !!block?.content?.trim();
}

/**
 * Everything Distill has to say about one stock.
 *
 * The company is resolved through the existing UUID cache; the sectors come
 * from our own classification, because Distill cannot derive that membership.
 * A failure on any one target costs that target and nothing else.
 */
export async function loadDistillDossiers(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
): Promise<{ company: DistillDossierBlock | null; sectors: DistillDossierBlock[]; entity: DistillEntityRef | null }> {
  // The company block goes through `withResolvedEntity` so a 404 on a cached id
  // re-resolves via `GET /entities/{id}` — which follows merges — and retries
  // once, instead of quietly reporting "no dossier" for an entity that merely
  // moved. The sectors need none of that: their handle came from Distill.
  let entity: DistillEntityRef | null = null;
  let companyBlock: DistillDossierBlock | null = null;
  try {
    const resolved = await withResolvedEntity(hints, apiKey, baseUrl, (e) =>
      readBlock(
        { kind: 'company', ref: e.id, subject: hints.symbol, displayName: e.displayName || hints.symbol },
        apiKey, baseUrl,
      ));
    entity       = resolved.entity;
    companyBlock = resolved.value;
  } catch (e) {
    // Unresolvable is a state the switch sync already records; here it simply
    // means no company dossier this run.
    logger.debug(`Distill: no company dossier for ${hints.symbol} — ${(e as Error).message}`);
  }

  const vocabulary = await loadSectorVocabulary(apiKey, baseUrl).catch(() => new Map<string, string>());
  const handles = await sectorHandlesForSymbol(hints.symbol, apiKey, baseUrl).catch(() => [] as string[]);

  const sectorBlocks = await Promise.all(handles.map((handle) => readBlock(
    { kind: 'sector', ref: sectorRef(handle), subject: handle, displayName: vocabulary.get(handle) ?? handle },
    apiKey, baseUrl,
  )));

  return {
    entity,
    company: companyBlock,
    sectors: sectorBlocks.filter((b): b is DistillDossierBlock => b !== null),
  };
}

export interface DistillSyncResult {
  bundle:         DistillBundle;
  mode:           DistillMode;
  distillCostUsd: number;
  /** One line for the run log. */
  detail:         string;
}

/**
 * Bring a symbol's stored Distill context up to date and write it.
 *
 * `mode` keeps the admin page's two words and changes what they buy, because
 * the expensive half moved:
 *
 *   fetch    dossiers only. Free, and covers everything up to yesterday.
 *   refresh  dossiers, plus one `POST /briefings/refresh` when the company has
 *            no dossier prose at all — a stock added today, or one whose switch
 *            was flipped this afternoon. Costs an LLM call upstream, so it
 *            fires on absence, never as a top-up.
 *
 * The fallback is company-only on purpose: `entity_ref` is singular, so covering
 * the sectors too would mean one paid call per sector per stock, and a sector
 * with no dossier yet is a gap that closes by itself tonight.
 */
export async function buildDistillBundle(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
  briefingTypeId: string | undefined,
  mode: DistillMode,
): Promise<DistillSyncResult> {
  const { company, sectors, entity } = await loadDistillDossiers(hints, apiKey, baseUrl);
  const prior = await readDistillLax(hints.symbol);

  let briefing = prior?.briefing ?? null;
  let distillCostUsd = 0;
  let fellBack = false;

  if (mode === 'refresh' && entity && !hasProse(company)) {
    try {
      const result = await triggerDistillRefresh(hints.symbol, entity, apiKey, baseUrl, briefingTypeId);
      briefing = result.briefing ?? briefing;
      distillCostUsd = result.distillCostUsd;
      fellBack = true;
    } catch (e) {
      logger.warn(`Distill briefing fallback for ${hints.symbol} failed: ${(e as Error).message}`);
    }
  }

  const bundle: DistillBundle = {
    ticker:    hints.symbol,
    baseUrl,
    entity,
    company,
    sectors,
    // An empty pool must not blank context that is already on disk.
    briefing,
    fetchedAt: new Date().toISOString(),
  };
  const withProse = [company, ...sectors].filter(hasProse).length;
  const detail =
    `${withProse} dossier(s)`
    + (company ? '' : ', no company entity')
    + (sectors.length ? ` · ${sectors.length} sector(s)` : '')
    + (fellBack ? ` · briefing fallback${distillCostUsd > 0 ? ` $${distillCostUsd.toFixed(4)}` : ''}` : '');

  return { bundle, mode, distillCostUsd, detail };
}

/**
 * Build and store. Split from `buildDistillBundle` because one caller — the
 * analysis run — wants the prose for a prompt without claiming it is the stored
 * state of the world.
 */
export async function syncDistillDossiers(
  hints: DistillEntityHints,
  apiKey: string,
  baseUrl: string,
  briefingTypeId: string | undefined,
  mode: DistillMode,
  runId?: number | null,
): Promise<DistillSyncResult> {
  const result = await buildDistillBundle(hints, apiKey, baseUrl, briefingTypeId, mode);
  await writeDistill(hints.symbol, result.bundle, runId);
  return result;
}
