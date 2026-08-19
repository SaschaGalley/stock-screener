/**
 * The Hatchet worker process.
 *
 * A second entrypoint next to `server.ts`, not a thread inside it. The API
 * process answers HTTP and must stay responsive; a worker spends its time
 * inside minute-long analysis runs. Keeping them apart means a saturated
 * worker cannot make the admin page time out, and either can be restarted
 * without the other.
 *
 * Registers `ping` only, for now. Real pipeline tasks land here as they move
 * over from `scheduler.ts`.
 */

import { logger } from '../utils/logger.js';
import { getHatchet, isHatchetConfigured } from './client.js';

/** One slot while the only task is `ping`; the pipeline will want more. */
const SLOTS = Number(process.env.HATCHET_WORKER_SLOTS ?? 1);

async function main(): Promise<void> {
  // Checked before the tasks are pulled in: a task declaration builds the
  // client as a side effect of being imported, so a static import would throw
  // past this handler and print a stack trace where a sentence belongs.
  if (!isHatchetConfigured()) {
    const { HatchetNotConfiguredError } = await import('./client.js');
    throw new HatchetNotConfiguredError();
  }
  const { ping } = await import('./tasks/ping.js');

  const worker = await getHatchet().worker('stock-cli', {
    slots:     SLOTS,
    workflows: [ping],
  });

  logger.success(`Hatchet worker "stock-cli" starting — ${SLOTS} slot(s), tasks: ping`);

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
