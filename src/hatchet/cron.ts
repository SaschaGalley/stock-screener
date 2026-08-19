/**
 * Keeping Hatchet's cron in step with the admin page.
 *
 * The schedule is edited in the UI and stored in `settings.json`, so that file
 * stays the source of truth and Hatchet is brought into line with it — never
 * the other way round. `applySchedule()` calls this at boot and after every
 * config change, exactly as it used to call `cron.schedule()`.
 *
 * Written as delete-then-create rather than update: a cron is identified by its
 * name, and the expression, the timezone and whether it should exist at all can
 * each change independently. Reconciling those in place is more code than
 * simply removing the ones we own and re-adding the one the config asks for.
 */

import { AppConfig } from '../app-config.js';
import { logger } from '../utils/logger.js';
import { getHatchet } from './client.js';

/** Name of the cron this app owns. Anything else on the tenant is left alone. */
export const CRON_NAME = 'stock-cli-nightly';

/**
 * Make Hatchet's crons match the stored config.
 *
 * Returns the expression that ended up installed, or null when the schedule is
 * switched off — the same answer `getSchedulerStatus()` reports to the UI.
 */
export async function syncHatchetCron(config: AppConfig): Promise<string | null> {
  const hatchet = getHatchet();

  // Remove ours first, whatever it currently says. Deleting a cron that is not
  // there is not an error worth failing a config save over.
  const existing = await hatchet.crons.list({ workflow: 'pipeline' });
  for (const cron of existing.rows ?? []) {
    if (cron.name !== CRON_NAME) continue;
    await hatchet.crons.delete(cron).catch((e) =>
      logger.warn(`Could not remove old cron: ${(e as Error).message}`));
  }

  if (!config.schedule.enabled) {
    logger.info('Pipeline schedule is disabled — no Hatchet cron installed.');
    return null;
  }

  await hatchet.crons.create('pipeline', {
    name:       CRON_NAME,
    expression: config.schedule.cron,
    input:      { trigger: 'cron', symbols: [] },
    additionalMetadata: { timezone: config.schedule.timezone },
  });

  logger.success(`Pipeline scheduled in Hatchet: "${config.schedule.cron}"`);
  return config.schedule.cron;
}
