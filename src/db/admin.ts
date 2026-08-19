/**
 * Operational state: pipeline runs, settings, entity mappings, the filing index.
 *
 * These are not time series — they are the things that used to live as loose
 * JSON at the cache root (`app-config.json`, `job-runs.json`) or as a sidecar
 * per symbol. They move here because the file cache is gone, not because
 * history was wanted for them.
 *
 * Deliberately free of domain types: `AppConfig` validation stays in
 * `app-config.ts`, which calls the raw settings functions below. Importing the
 * schema here would close a cycle.
 */

import type { DistillEntityRef } from '../data/distill-entities.js';
import { logger } from '../utils/logger.js';
import { query, queryOne } from './client.js';
import { symbolId, upsertSymbol } from './store.js';

// ── Settings (was app-config.json) ───────────────────────────────────────────

export async function readSettingsJson(): Promise<unknown | null> {
  const row = await queryOne<{ config: unknown }>('SELECT config FROM settings WHERE id = true');
  return row?.config ?? null;
}

export async function writeSettingsJson(value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (id, config) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [JSON.stringify(value)],
  );
}

// ── Pipeline runs (was job-runs.json) ────────────────────────────────────────

export type JobStep = 'data' | 'distill' | 'analysis';
export type StepStatus = 'ok' | 'skipped' | 'failed';
export type JobRunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'stopped';
export type JobTrigger = 'cron' | 'manual' | 'api' | 'cli' | 'backfill';

export interface JobStepResult {
  step:   JobStep;
  status: StepStatus;
  detail: string;
  ms:     number;
}

export interface JobSymbolResult {
  symbol: string;
  steps:  JobStepResult[];
  ms:     number;
}

export interface JobRun {
  id:            string;
  trigger:       JobTrigger;
  startedAt:     string;
  finishedAt:    string | null;
  status:        JobRunStatus;
  currentSymbol: string | null;
  symbols:       JobSymbolResult[];
  totals:        { symbols: number; data: number; distill: number; analysis: number; failed: number };
  error?:        string;
}

/** Open a run and return its id. Every write during the run references it. */
export async function startRun(trigger: JobTrigger): Promise<number> {
  const row = await queryOne<{ id: number }>(
    'INSERT INTO runs (trigger) VALUES ($1) RETURNING id', [trigger],
  );
  return row!.id;
}

export async function setRunSymbol(runId: number, symbol: string | null): Promise<void> {
  await query('UPDATE runs SET current_symbol = $2 WHERE id = $1', [runId, symbol]);
}

/** Append the steps of one symbol. `seq` preserves the order they ran in. */
export async function recordRunSteps(
  runId: number, symbol: string, steps: JobStepResult[],
): Promise<void> {
  if (steps.length === 0) return;
  const base = (await queryOne<{ n: number }>(
    'SELECT COALESCE(MAX(seq), 0) AS n FROM run_steps WHERE run_id = $1', [runId],
  ))!.n;
  await query(
    `INSERT INTO run_steps (run_id, seq, symbol, step, status, detail, ms)
     SELECT $1, $2 + ord, $3, s, st, d, m
       FROM unnest($4::text[], $5::text[], $6::text[], $7::integer[])
            WITH ORDINALITY AS u(s, st, d, m, ord)`,
    [
      runId, base, symbol,
      steps.map((s) => s.step), steps.map((s) => s.status),
      steps.map((s) => s.detail), steps.map((s) => s.ms),
    ],
  );
}

export async function finishRun(
  runId: number, status: JobRunStatus, error?: string,
): Promise<void> {
  await query(
    `UPDATE runs SET status = $2, finished_at = now(), current_symbol = NULL, error = $3
      WHERE id = $1`,
    [runId, status, error ?? null],
  );
}

interface RunRow {
  id: number; trigger: JobTrigger; started_at: Date; finished_at: Date | null;
  status: JobRunStatus; current_symbol: string | null; error: string | null;
}

interface StepRow {
  run_id: number; seq: number; symbol: string; step: JobStep;
  status: StepStatus; detail: string | null; ms: number;
}

/** Reassemble the nested shape the admin page renders. */
function assemble(runs: RunRow[], steps: StepRow[]): JobRun[] {
  const bySymbol = new Map<number, Map<string, JobSymbolResult>>();
  for (const s of steps) {
    const perRun = bySymbol.get(s.run_id) ?? new Map<string, JobSymbolResult>();
    const entry = perRun.get(s.symbol) ?? { symbol: s.symbol, steps: [], ms: 0 };
    entry.steps.push({ step: s.step, status: s.status, detail: s.detail ?? '', ms: s.ms });
    entry.ms += s.ms;
    perRun.set(s.symbol, entry);
    bySymbol.set(s.run_id, perRun);
  }

  return runs.map((r) => {
    const symbols = [...(bySymbol.get(r.id)?.values() ?? [])];
    const totals = { symbols: symbols.length, data: 0, distill: 0, analysis: 0, failed: 0 };
    for (const sym of symbols) {
      for (const step of sym.steps) {
        if (step.status === 'ok') totals[step.step]++;
        if (step.status === 'failed') totals.failed++;
      }
    }
    return {
      id:            String(r.id),
      trigger:       r.trigger,
      startedAt:     r.started_at.toISOString(),
      finishedAt:    r.finished_at?.toISOString() ?? null,
      status:        r.status,
      currentSymbol: r.current_symbol,
      symbols,
      totals,
      ...(r.error ? { error: r.error } : {}),
    };
  });
}

const MAX_KEPT_RUNS = 20;

/** The recent runs, newest first, with their steps. */
export async function listRuns(limit = MAX_KEPT_RUNS): Promise<JobRun[]> {
  const runs = (await query<RunRow>(
    'SELECT * FROM runs ORDER BY started_at DESC LIMIT $1', [limit],
  )).rows;
  if (runs.length === 0) return [];
  // Ordered by id, not seq. `seq` is assigned by reading MAX and adding one,
  // which is safe only while a single writer walks the watchlist; with symbols
  // running in parallel two writers can read the same MAX and collide. `id` is
  // a bigserial, so it is monotonic by construction and gives the same order
  // as seq ever did for a serial run.
  const steps = (await query<StepRow>(
    'SELECT * FROM run_steps WHERE run_id = ANY($1::bigint[]) ORDER BY id',
    [runs.map((r) => r.id)],
  )).rows;
  return assemble(runs, steps);
}

/**
 * Mark runs left "running" by a crash as failed.
 *
 * The scheduler holds its active run in memory, so a container restart would
 * otherwise leave a row claiming to be in progress forever and the admin page
 * showing a run that no process is executing.
 */
export async function reapStaleRuns(): Promise<number> {
  const res = await query(
    `UPDATE runs SET status = 'failed', finished_at = now(),
            error = COALESCE(error, 'interrupted by restart')
      WHERE status = 'running'`,
  );
  const n = res.rowCount ?? 0;
  if (n > 0) logger.warn(`Marked ${n} interrupted pipeline run(s) as failed`);
  return n;
}

/** Drop runs beyond the retention window, cascading their steps. */
export async function pruneRuns(keep = MAX_KEPT_RUNS): Promise<void> {
  await query(
    `DELETE FROM runs WHERE id NOT IN (
       SELECT id FROM runs ORDER BY started_at DESC LIMIT $1
     )`,
    [keep],
  );
}

// ── Distill entity mapping ───────────────────────────────────────────────────

/**
 * The stored mapping is exactly `DistillEntityRef`. Imported as a type — erased
 * at build time, so this module keeps no runtime edge to the domain — because a
 * re-declared copy would drift the first time a field is added there.
 */
export type DistillEntityRow = DistillEntityRef;

export async function readDistillEntity(
  symbol: string, baseUrl: string,
): Promise<DistillEntityRow | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const row = await queryOne<{
    entity_id: string; ref: string | null; entity_type: string | null;
    display_name: string | null; matched_on: string | null;
    matched_value: string | null; query: string | null;
    base_url: string; resolved_at: Date;
  }>(
    'SELECT * FROM distill_entities WHERE symbol_id = $1 AND base_url = $2', [id, baseUrl],
  );
  if (!row) return null;
  return {
    id: row.entity_id, ref: row.ref ?? '', type: row.entity_type ?? '',
    displayName: row.display_name ?? '',
    matchedOn: (row.matched_on ?? 'name') as DistillEntityRef['matchedOn'],
    matchedValue: row.matched_value ?? '', query: row.query ?? '',
    baseUrl: row.base_url, resolvedAt: row.resolved_at.toISOString(),
  };
}

export async function writeDistillEntity(
  symbol: string, entity: DistillEntityRow,
): Promise<void> {
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO distill_entities
       (symbol_id, base_url, entity_id, ref, entity_type, display_name,
        matched_on, matched_value, query, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (symbol_id, base_url) DO UPDATE SET
       entity_id     = EXCLUDED.entity_id,
       ref           = EXCLUDED.ref,
       entity_type   = EXCLUDED.entity_type,
       display_name  = EXCLUDED.display_name,
       matched_on    = EXCLUDED.matched_on,
       matched_value = EXCLUDED.matched_value,
       query         = EXCLUDED.query,
       resolved_at   = now()`,
    [
      id, entity.baseUrl, entity.id, entity.ref, entity.type,
      entity.displayName, entity.matchedOn, entity.matchedValue, entity.query,
    ],
  );
}

export async function clearDistillEntity(symbol: string, baseUrl?: string): Promise<void> {
  const id = await symbolId(symbol);
  if (id === null) return;
  if (baseUrl) {
    await query('DELETE FROM distill_entities WHERE symbol_id = $1 AND base_url = $2', [id, baseUrl]);
  } else {
    await query('DELETE FROM distill_entities WHERE symbol_id = $1', [id]);
  }
}

// ── EDGAR filing index ───────────────────────────────────────────────────────
// The documents themselves stay on disk (see src/files.ts): they are immutable,
// large, and served straight from the filesystem.

export interface FilingEntry {
  accessionNumber: string;
  form:            string;
  filingDate:      string;
  primaryDocument: string;
  description:     string;
  localFile?:      string;
}

export interface SubmissionsMeta {
  cik:        string;
  entityName: string;
  filings:    FilingEntry[];
  fetchedAt:  string;
}

export async function readSubmissions(symbol: string): Promise<SubmissionsMeta | null> {
  const id = await symbolId(symbol);
  if (id === null) return null;
  const res = await query<{
    accession_number: string; cik: string | null; entity_name: string | null;
    form: string; filing_date: Date; primary_document: string | null;
    description: string | null; local_file: string | null; fetched_at: Date;
  }>(
    'SELECT * FROM filings WHERE symbol_id = $1 ORDER BY filing_date DESC', [id],
  );
  if (res.rows.length === 0) return null;
  return {
    cik:        res.rows[0].cik ?? '',
    entityName: res.rows[0].entity_name ?? '',
    fetchedAt:  res.rows[0].fetched_at.toISOString(),
    filings: res.rows.map((r) => ({
      accessionNumber: r.accession_number,
      form:            r.form,
      filingDate:      r.filing_date.toISOString().slice(0, 10),
      primaryDocument: r.primary_document ?? '',
      description:     r.description ?? '',
      ...(r.local_file ? { localFile: r.local_file } : {}),
    })),
  };
}

export async function writeSubmissions(symbol: string, meta: SubmissionsMeta): Promise<void> {
  if (meta.filings.length === 0) return;
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO filings
       (symbol_id, accession_number, cik, entity_name, form, filing_date,
        primary_document, description, local_file)
     SELECT $1, a, $2, $3, f, d::date, p, ds, lf
       FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
            AS u(a, f, d, p, ds, lf)
     ON CONFLICT (symbol_id, accession_number) DO UPDATE SET
       local_file = COALESCE(EXCLUDED.local_file, filings.local_file),
       fetched_at = now()`,
    [
      id, meta.cik, meta.entityName,
      meta.filings.map((f) => f.accessionNumber),
      meta.filings.map((f) => f.form),
      meta.filings.map((f) => f.filingDate),
      meta.filings.map((f) => f.primaryDocument),
      meta.filings.map((f) => f.description),
      meta.filings.map((f) => f.localFile ?? null),
    ],
  );
}
