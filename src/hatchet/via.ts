/**
 * Work a person is waiting on, run where the queue says: in a Hatchet worker
 * when one is configured, inline otherwise. Shared by the endpoints and by the
 * depot check, which runs the same refresh and analysis for each candidate.
 */

import { isHatchetConfigured } from './client.js';

/**
 * How an interactive job is dispatched.
 *
 * The endpoints still await their result and answer with it, so the web
 * UI is unchanged — what moves is *where* the work happens. In the worker it
 * counts against the same rate limits and the same Distill gate as the nightly
 * pipeline, which is the whole point: a refresh clicked at 2am used to slip
 * past both.
 *
 * Without a token there is no queue to use, so the work runs inline exactly as
 * it always did.
 */
export async function viaHatchet<O>(enqueue: () => Promise<O>, inline: () => Promise<O>): Promise<O> {
  if (!isHatchetConfigured()) return inline();

  // Checked first, because the failure without it is the unhelpful kind: the
  // task is accepted, nothing picks it up, and the browser waits on a request
  // that will never answer. Before this work moved to the queue that click
  // simply ran, so an unattended queue must say so rather than hang.
  const { hasActiveWorker } = await import('./activity.js');
  if (!await hasActiveWorker()) throw new NoWorkerError();

  return enqueue();
}

/** No worker is listening, so there is no point queueing the work. */
export class NoWorkerError extends Error {
  constructor() {
    super('No Hatchet worker is running — start one with `pnpm hatchet:worker` '
      + '(in production, the stockcli-worker-* containers).');
    this.name = 'NoWorkerError';
  }
}

/**
 * Trigger options for work a person is waiting on.
 *
 * HIGH priority because they are waiting: with Distill serialised, a click
 * during a nightly pass would otherwise queue behind every remaining symbol.
 * Spelled numerically (3 = Priority.HIGH) to keep the SDK's enum out of the
 * server's imports; the value is part of the wire protocol.
 */
export const interactive = (meta: Record<string, string>) => ({
  additionalMetadata: { ...meta, trigger: 'api' },
  priority: 3,
});
