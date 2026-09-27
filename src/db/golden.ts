/**
 * Capture stored inputs as golden fixtures.
 *
 *   pnpm run golden:capture -- MSFT,BRK-B,AIR.PA   # writes test/golden/<SYMBOL>.inputs.json
 *
 * The inputs are what the score read at this moment: the financials, market
 * signals, peer medians and technical signals in force, and the recorded
 * rates (`storedInputs`). `test/golden.test.ts` recomputes every model and the
 * factor score from them and compares with `<SYMBOL>.expected.json`, so a
 * change that moves a real stock's numbers fails a test instead of passing
 * unnoticed. After an intended change, `UPDATE_GOLDEN=1 pnpm test` rewrites the
 * expectations, and the diff of those files is the change's effect on real
 * stocks, reviewable line by line.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { closePool, waitForDatabase } from './client.js';
import { storedInputs } from './rescore.js';

export const GOLDEN_DIR = 'test/golden';

const isMain = process.argv[1]?.endsWith('golden.ts') || process.argv[1]?.endsWith('golden.js');

if (isMain) {
  const symbols = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) {
    logger.error('Usage: pnpm run golden:capture -- SYMBOL[,SYMBOL…]');
    process.exit(1);
  }

  (async () => {
    getConfig();
    await waitForDatabase();
    const dir = resolve(GOLDEN_DIR);
    mkdirSync(dir, { recursive: true });
    for (const symbol of symbols) {
      const inputs = await storedInputs(symbol);
      if (!inputs) {
        logger.warn(`${symbol}: nothing stored to capture`);
        continue;
      }
      writeFileSync(join(dir, `${symbol}.inputs.json`), `${JSON.stringify(inputs, null, 2)}\n`);
      logger.success(`${symbol} → ${GOLDEN_DIR}/${symbol}.inputs.json`);
    }
    logger.info('Now `UPDATE_GOLDEN=1 pnpm test` to write the expectations.');
    await closePool();
  })().catch(async (e) => {
    logger.error(`Capture failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
}
