/**
 * Which tasks a worker serves, and how many at once.
 *
 * The split exists because a worker's slot count is the only limit Hatchet
 * enforces *across processes*. Everything else available on this engine either
 * cancels work (both CANCEL_ strategies) or preempts it (GROUP_ROUND_ROBIN), so
 * the in-process gate in `gate.ts` had to do the waiting — and a task waiting
 * at that gate still holds a slot, doing nothing. Give Distill its own worker
 * with one slot and the queue does the waiting instead: nothing is held, and
 * "one at a time" survives a second replica, which the gate never could.
 *
 * The roles line up with what each stage contends for, not with what it does:
 *
 *   distill   — one machine at home answering one request at a time
 *   analysis  — an LLM bill, and how much of it may be in flight
 *   general   — everything else, which is bounded by the API rate limits and
 *               by the parent, whose only job is to wait
 *
 * `all` is the single-process shape `pnpm dev` starts and the default for an
 * installation that has not split anything. The gates still hold the line there.
 */

import { ANALYSIS_CONCURRENCY, DISTILL_CONCURRENCY } from './limits.js';

export type WorkerRole = 'all' | 'general' | 'distill' | 'analysis';

export const WORKER_ROLES: readonly WorkerRole[] = ['all', 'general', 'distill', 'analysis'];

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

/**
 * Slots per role.
 *
 * For the two limited roles the slot count *is* the limit — that is the whole
 * point of separating them. `general` is deliberately generous: its members are
 * either rate-limited already or, in the parent's case, asleep for hours
 * waiting on stages that run elsewhere. A slot it holds costs an idle promise.
 */
export function slotsFor(role: WorkerRole): number {
  switch (role) {
    case 'distill':  return DISTILL_CONCURRENCY;
    case 'analysis': return ANALYSIS_CONCURRENCY;
    // Above the size of any watchlist, so the parent and one chain per symbol
    // always have somewhere to sit. Starving those would stall a run against
    // stages that are perfectly free.
    case 'general':  return 64;
    case 'all':      return 64;
  }
}

/** A human-readable name for the worker, so the dashboard is legible. */
export function workerName(base: string, role: WorkerRole): string {
  return role === 'all' ? base : `${base}-${role}`;
}
