/**
 * The Hatchet worker process.
 *
 * A second entrypoint next to `server.ts`, not a thread inside it. The API
 * process answers HTTP and must stay responsive; a worker spends its time
 * inside minute-long analysis runs. Keeping them apart means a saturated
 * worker cannot make the admin page time out, and either can be restarted
 * without the other.
 *
 * One entrypoint, several shapes. `HATCHET_WORKER_ROLE` decides which tasks
 * this process serves and how many it will take at once — see `roles.ts` for
 * why the split exists at all. Unset means `all`, which is the single process
 * `pnpm dev` starts and the right shape for an installation that has not split
 * anything.
 */

import { logger } from '../utils/logger.js';
import { getHatchet, isHatchetConfigured } from './client.js';
import { isWorkerRole, slotsFor, WorkerRole, workerName, WORKER_ROLES } from './roles.js';

/** The base name this worker registers under. Hatchet prefixes it with the
 *  namespace, so on a dev machine it appears as `dev_stock-cli`. */
export const WORKER_NAME = 'stock-cli';

function resolveRole(): WorkerRole {
  const raw = (process.env.HATCHET_WORKER_ROLE ?? 'all').trim().toLowerCase();
  if (isWorkerRole(raw)) return raw;
  throw new Error(`HATCHET_WORKER_ROLE="${raw}" is not one of: ${WORKER_ROLES.join(', ')}`);
}

async function main(): Promise<void> {
  // Checked before the tasks are pulled in: a task declaration builds the
  // client as a side effect of being imported, so a static import would throw
  // past this handler and print a stack trace where a sentence belongs.
  //
  // Not an error: Hatchet is optional, and this process is part of the default
  // dev stack. Exiting quietly keeps `pnpm dev` working on a checkout that has
  // never been given a token, where the in-process scheduler is the whole app.
  if (!isHatchetConfigured()) {
    logger.info('Hatchet not configured — worker idle. Set HATCHET_CLIENT_TOKEN to enable it.');
    return;
  }

  const role  = resolveRole();
  const slots = Number(process.env.HATCHET_WORKER_SLOTS ?? slotsFor(role));
  const name  = workerName(WORKER_NAME, role);

  const { ping } = await import('./tasks/ping.js');
  const { pipeline, dataTask, distillTask, analysisTask } = await import('./tasks/pipeline.js');
  const { refreshData, distillRefresh, analyze } = await import('./tasks/single.js');
  const { ensureRateLimits } = await import('./limits.js');

  // Grouped by what they contend for, not by what they do. Each interactive
  // task sits with the pipeline stage it duplicates, so a click and the nightly
  // run draw on one ceiling rather than each getting their own.
  const byRole = {
    all:      [ping, pipeline, dataTask, distillTask, analysisTask, refreshData, distillRefresh, analyze],
    general:  [ping, pipeline, dataTask, refreshData],
    distill:  [distillTask, distillRefresh],
    analysis: [analysisTask, analyze],
  } satisfies Record<WorkerRole, unknown[]>;

  const workflows = byRole[role];

  // Declared before the worker accepts anything: a task that spends from a key
  // the server has never heard of cannot be scheduled. Cheap and idempotent, so
  // every role does it rather than one owning it and the rest depending on that
  // one being deployed.
  await ensureRateLimits();

  const worker = await getHatchet().worker(name, { slots, workflows });

  logger.success(
    `Hatchet worker "${name}" starting — role ${role}, ${slots} slot(s), `
    + `${workflows.length} task(s)`,
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
