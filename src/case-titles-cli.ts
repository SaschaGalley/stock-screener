/**
 * `pnpm case-titles` — write headlines for the bull and bear points stored
 * without one (see `case-titles.ts`), once, then exit.
 *
 *   --dry-run       ask the model and print what would be written; write nothing
 *   --symbol <s>    one stock only
 *   --model <id>    another model than the admin settings' summary model
 *
 * A point that has a headline is not asked about again, so a run that stopped
 * half-way is finished by running it again, and a second run costs nothing.
 */

import { readAppConfig } from './app-config.js';
import { TITLES_SYSTEM, TitlesSchema, titlesPrompt, untitledPoints, withTitles } from './case-titles.js';
import { closePool, waitForDatabase } from './db/client.js';
import { listVerdictDocuments, rewriteVerdictDocument } from './db/store.js';
import { resolveModelId } from './models.js';
import { createProviderForModel } from './providers/factory.js';
import { logger } from './utils/logger.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Points sent in one call: enough to amortise the instructions, few enough to keep the order straight. */
const BATCH = 24;

(async () => {
  const dryRun = flag('--dry-run');
  const symbol = option('--symbol')?.toUpperCase();
  await waitForDatabase();
  const model = resolveModelId(option('--model') ?? (await readAppConfig()).scoring.summaryModel);
  const provider = createProviderForModel(model);

  const docs = await listVerdictDocuments(symbol);
  const todo = docs.map((d) => ({ ...d, points: untitledPoints(d.data.llmAnalysis) })).filter((d) => d.points.length > 0);
  const total = todo.reduce((n, d) => n + d.points.length, 0);
  logger.info(`${docs.length} Analysen, ${todo.length} mit ${total} Punkten ohne Überschrift — Modell ${model}${dryRun ? ' (Probelauf)' : ''}`);

  let written = 0, titled = 0, failed = 0;
  for (const doc of todo) {
    const titles: (string | undefined)[] = [];
    try {
      for (let i = 0; i < doc.points.length; i += BATCH) {
        const batch = doc.points.slice(i, i + BATCH);
        const r = await provider.complete({
          system: TITLES_SYSTEM, user: titlesPrompt(doc.symbol, batch),
          schema: TitlesSchema, label: 'case-titles', maxTokens: 1500,
        });
        // Out of step is worse than missing: a headline over the wrong point.
        if (r.titles.length !== batch.length) throw new Error(`${r.titles.length} Überschriften für ${batch.length} Punkte`);
        titles.push(...r.titles);
      }
    } catch (e) {
      failed++;
      logger.warn(`${doc.symbol} #${doc.id}: ${(e as Error).message}`);
      continue;
    }
    const llmAnalysis = withTitles(doc.data.llmAnalysis, doc.points, titles);
    const n = untitledPoints(doc.data.llmAnalysis).length - untitledPoints(llmAnalysis).length;
    titled += n;
    // The points the model could not name — mostly a few words already — stay as they are.
    if (n === 0) continue;
    if (dryRun) {
      logger.info(`${doc.symbol} #${doc.id}:\n${doc.points.map((p, i) => `  ${titles[i] ?? '—'}  ←  ${p.text.slice(0, 80)}…`).join('\n')}`);
      continue;
    }
    await rewriteVerdictDocument(doc.id, { ...doc.data, llmAnalysis });
    written++;
  }

  logger.success(`${titled} Überschriften${dryRun ? ' (nicht geschrieben)' : ` in ${written} Analysen geschrieben`}${failed ? `, ${failed} Analysen fehlgeschlagen` : ''}`);
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
})().catch(async (e) => {
  logger.error(`case-titles: ${(e as Error).message}`);
  await closePool();
  process.exit(1);
});
