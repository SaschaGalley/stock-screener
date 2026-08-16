/**
 * The two things that stay files.
 *
 * Everything the app measures lives in Postgres now. Two categories don't
 * belong there:
 *
 *   - EDGAR filings — immutable documents, and by far the bulk of what the old
 *     cache held (568 MB against 1.6 MB of actual data). They are fetched once,
 *     never change, and are served straight off disk. Their index is in the
 *     `filings` table; only the bytes are here.
 *   - Generated reports (report.md / .pdf) — derived artefacts of one analysis
 *     run, regenerable from the stored snapshot.
 *
 * `DATA_DIR` replaces `CACHE_DIR`: nothing here is a cache any more, and a
 * directory whose name says "cache" invites someone to delete it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { logger } from './utils/logger.js';

/** Absolute path of the data root, expanding `~`. */
export function resolveDataRoot(rawDir: string): string {
  if (rawDir.startsWith('~')) return join(homedir(), rawDir.slice(1));
  if (isAbsolute(rawDir)) return rawDir;
  return resolve(process.cwd(), rawDir);
}

/**
 * Per-symbol file directory, confined to the data root.
 *
 * The symbol still arrives from untrusted HTTP route params, so traversal is
 * rejected here as well as at the route boundary — the filesystem is the one
 * place where a bad string does lasting damage.
 */
export function symbolDir(rawDir: string, symbol: string): string {
  const root = resolveDataRoot(rawDir);
  const dir  = resolve(root, symbol);
  const rel  = relative(root, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw new Error(`Unsafe data symbol: ${JSON.stringify(symbol)}`);
  }
  return dir;
}

export function getSubmissionsDir(rawDir: string, symbol: string): string {
  return join(symbolDir(rawDir, symbol), 'submissions');
}

export function writeSubmissionFile(
  rawDir: string, symbol: string, filename: string, content: string,
): void {
  const dir = getSubmissionsDir(rawDir, symbol);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content, 'utf-8');
    logger.debug(`Saved filing: ${filename}`);
  } catch (e) {
    logger.warn(`Could not write filing: ${(e as Error).message}`);
  }
}

/** Path of a generated report, whether or not it exists yet. */
export function reportPath(rawDir: string, symbol: string, name: string): string {
  return join(symbolDir(rawDir, symbol), name);
}

export function reportExists(rawDir: string, symbol: string, name: string): boolean {
  try { return existsSync(reportPath(rawDir, symbol, name)); }
  catch { return false; }
}
