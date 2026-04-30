import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { StockFinancials } from './types.js';
import { logger } from './utils/logger.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour
// Bump whenever StockFinancials gains/loses fields — invalidates all old cache entries
const CACHE_VERSION = 5;

function resolveCacheDir(dir: string): string {
  if (dir.startsWith('~')) return join(homedir(), dir.slice(1));
  if (isAbsolute(dir)) return dir;
  return resolve(process.cwd(), dir);
}

export function readCache(rawDir: string, symbol: string): StockFinancials | null {
  const dir = resolveCacheDir(rawDir);
  const file = join(dir, `${symbol}.json`);
  if (!existsSync(file)) return null;
  try {
    const { v, ts, data } = JSON.parse(readFileSync(file, 'utf-8'));
    if (v !== CACHE_VERSION) {
      logger.debug(`Cache version mismatch for ${symbol} — refetching`);
      return null;
    }
    if (Date.now() - ts > TTL_MS) {
      logger.debug(`Cache expired for ${symbol}`);
      return null;
    }
    logger.debug(`Cache hit for ${symbol} (${Math.round((Date.now() - ts) / 60000)}m old)`);
    return data as StockFinancials;
  } catch {
    return null;
  }
}

export function writeCache(rawDir: string, symbol: string, data: StockFinancials): void {
  const dir = resolveCacheDir(rawDir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${symbol}.json`), JSON.stringify({ v: CACHE_VERSION, ts: Date.now(), data }, null, 2));
    logger.debug(`Cached ${symbol} → ${dir}`);
  } catch (e) {
    logger.warn(`Could not write cache: ${(e as Error).message}`);
  }
}
