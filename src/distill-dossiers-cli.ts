/**
 * `pnpm run dossiers:sync` — mirror the watchlist onto Distill's dossier
 * switches once, then exit.
 *
 * The pipeline does this at the start of every run, which is where it belongs:
 * the switch has to be right when the night's work depends on it. This exists
 * for the two moments a run is the wrong instrument — bootstrapping a watchlist
 * that predates the switch, and repairing one after a key was re-issued —
 * because a full run also refreshes data and spends Distill's LLM budget, which
 * is a lot to pay for flipping switches.
 *
 * Exits non-zero when the sync was aborted or left anything failed, so it can
 * be used as a check rather than only as a nudge.
 */

import { getConfig } from './config.js';
import { listDossiers } from './db/admin.js';
import { closePool, waitForDatabase } from './db/client.js';
import { describeDossierSync, syncWatchlistDossiers } from './distill-dossiers.js';
import { logger } from './utils/logger.js';

(async () => {
  await waitForDatabase();
  const summary = await syncWatchlistDossiers();

  const unsettled = (await listDossiers(getConfig().distillApiUrl))
    .filter((r) => r.state !== 'synced');
  for (const r of unsettled) {
    const name = r.kind === 'sector' ? `sector:${r.subject}` : r.subject;
    logger.warn(`${name}: ${r.state}${r.detail ? ` — ${r.detail}` : ''}`);
  }

  if (summary.aborted) {
    logger.error(`Dossier sync ${describeDossierSync(summary)}`);
    await closePool();
    process.exit(1);
  }

  logger.success(`Dossier sync — ${describeDossierSync(summary)}`);
  await closePool();
  process.exit(summary.failed > 0 ? 1 : 0);
})().catch(async (e) => {
  logger.error(`Dossier sync failed: ${(e as Error).message}`);
  await closePool();
  process.exit(1);
});
