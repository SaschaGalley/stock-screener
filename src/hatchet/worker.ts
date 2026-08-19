/**
 * The Hatchet worker process.
 *
 * A second entrypoint next to `server.ts`, not a thread inside it. The API
 * process answers HTTP and must stay responsive; a worker spends its time
 * inside minute-long analysis runs. Keeping them apart means a saturated
 * worker cannot make the admin page time out, and either can be restarted
 * without the other.
 *
 * Registers the nightly pipeline, the interactive single-symbol tasks the API
 * now hands over, and `ping`, which stays because it is what
 * `pnpm hatchet:check` uses to prove the round trip.
 *
 * Slots are the worker's own ceiling and deliberately generous: the real pacing
 * comes from the per-task rate limits and concurrency caps, which Hatchet
 * enforces across every worker rather than per process. A tight slot count here
 * would just add a second, invisible limit.
 */

import { logger } from '../utils/logger.js';
import { getHatchet, isHatchetConfigured } from './client.js';

/** The name this worker registers under. Hatchet prefixes it with the
 *  namespace, so on a dev machine it appears as `dev_stock-cli`. */
export const WORKER_NAME = 'stock-cli';

/** Worker ceiling; the per-task limits do the real pacing. */
const SLOTS = Number(process.env.HATCHET_WORKER_SLOTS ?? 20);

async function main(): Promise<void> {
  // Checked before the tasks are pulled in: a task declaration builds the
  // client as a side effect of being imported, so a static import would throw
  // past this handler and print a stack trace where a sentence belongs.
  // Not an error: Hatchet is optional, and this process is part of the default
  // dev stack. Exiting quietly keeps `pnpm dev` working on a checkout that has
  // never been given a token, where the in-process scheduler is the whole app.
  if (!isHatchetConfigured()) {
    logger.info('Hatchet not configured — worker idle. Set HATCHET_CLIENT_TOKEN to enable it.');
    return;
  }
  const { ping } = await import('./tasks/ping.js');
  const { pipeline, symbolPipeline } = await import('./tasks/pipeline.js');
  const { refreshData, distillRefresh, analyze } = await import('./tasks/single.js');
  const { ensureRateLimits } = await import('./limits.js');

  // Declared before the worker accepts anything: a task that spends from a key
  // the server has never heard of cannot be scheduled.
  await ensureRateLimits();

  const worker = await getHatchet().worker(WORKER_NAME, {
    slots:     SLOTS,
    workflows: [ping, pipeline, symbolPipeline, refreshData, distillRefresh, analyze],
  });

  logger.success(
    `Hatchet worker "${WORKER_NAME}" starting — ${SLOTS} slot(s), tasks: ping, pipeline, `
    + 'symbol-pipeline, refresh-data, distill-refresh, analyze',
  );

  // Blocks until the process is signalled; the SDK handles SIGTERM/SIGINT.
  await worker.start();
}

main().catch((e) => {
  if ((e as Error).name === 'HatchetNotConfiguredError') {
    logger.error((e as Error).message);
    process.exit(1);
  }
  logger.error(`Hatchet worker failed: ${(e as Error).message}`);
  process.exit(1);
});
