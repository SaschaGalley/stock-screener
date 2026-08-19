/**
 * "What is happening to this symbol right now?"
 *
 * Answered by asking Hatchet, not Postgres, and the split is deliberate:
 *
 *   live state  → Hatchet. It owns the queue, so it is the only thing that
 *                 knows a task is queued but not started, or running on a
 *                 worker that has since stopped answering. Mirroring that into
 *                 Postgres would mean writing "started" rows and reconciling
 *                 the ones no process ever finished — which is precisely the
 *                 `reapStaleRuns()` clean-up this app already needed.
 *
 *   history     → Postgres. `runs`/`run_steps` outlive Hatchet's retention,
 *                 join against the domain tables, and are what the admin page
 *                 renders. A queue is not an archive.
 *
 * The join between the two is `additionalMetadata`, attached when a run is
 * triggered. Hatchet can filter on it, so tagging every run with its symbol is
 * what makes a per-symbol question answerable at all — without it the only
 * available question is "is anything running".
 */

import { getHatchet } from './client.js';

/** `refresh-data-1787176529920` → `refresh-data`. */
function stripRunSuffix(name?: string | null): string | null {
  return name ? name.replace(/-\d{10,}$/, '') : null;
}

/** Statuses that mean "not finished yet". */
const IN_FLIGHT = ['QUEUED', 'RUNNING'] as const;

export interface ActivityEntry {
  /** Hatchet's own id, for linking straight into its dashboard. */
  id:          string;
  workflow:    string;
  status:      string;
  symbol:      string | null;
  /** Which pipeline run this belongs to, when it belongs to one. */
  runId:       string | null;
  trigger:     string | null;
  startedAt:   string | null;
}

/**
 * Everything in flight, newest first — optionally narrowed to one symbol.
 *
 * Narrowing happens server-side through the metadata filter rather than by
 * fetching everything and sifting here, so this stays cheap with a queue that
 * has a whole watchlist in it.
 */
export async function inFlight(symbol?: string): Promise<ActivityEntry[]> {
  const hatchet = getHatchet();

  const res = await hatchet.runs.list({
    statuses:   [...IN_FLIGHT] as never,
    onlyTasks:  false,
    limit:      200,
    ...(symbol ? { additionalMetadata: { symbol: symbol.toUpperCase() } } : {}),
  });

  return (res.rows ?? []).map((row) => {
    const meta = (row.additionalMetadata ?? {}) as Record<string, string>;
    return {
      id:        row.metadata?.id ?? '',
      // `workflowName` first: Hatchet's `displayName` for a standalone task is
      // the name with a trigger timestamp appended, which is noise in a UI. The
      // suffix is stripped from the fallback for the same reason.
      workflow:  row.workflowName ?? stripRunSuffix(row.displayName) ?? 'unknown',
      status:    String(row.status ?? 'unknown'),
      symbol:    meta.symbol ?? null,
      runId:     meta.runId ?? null,
      trigger:   meta.trigger ?? null,
      startedAt: row.startedAt ?? row.createdAt ?? null,
    };
  });
}

/**
 * Is this symbol busy, and with what?
 *
 * Returns the stage names rather than a bare boolean: "AAPL is analysing" and
 * "AAPL is waiting for a Distill slot" are different answers to the question a
 * UI is really asking, and both are already in the data.
 */
export async function symbolActivity(symbol: string): Promise<{
  busy: boolean; stages: string[]; entries: ActivityEntry[];
}> {
  const entries = await inFlight(symbol);
  return {
    busy:    entries.length > 0,
    stages:  [...new Set(entries.map((e) => e.workflow))],
    entries,
  };
}
