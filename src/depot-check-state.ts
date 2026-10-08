/**
 * Where the depot check keeps its progress and its result: `app_state`, under
 * the trades source, so a placeholder's check in development never overwrites
 * the real one. Apart from the check itself because the depot view reads the
 * last result's stops, and the check reads the depot view.
 */

import type { DepotCheckResult, DepotCheckStatus, DepotNote } from './analysis/depot-check.js';
import { readAppState, writeAppState } from './db/admin.js';
import { tradesSource } from './trades-service.js';

export const CHECK_STATUS_KEY = () => `depot.check.${tradesSource()}.status`;
export const CHECK_RESULT_KEY = () => `depot.check.${tradesSource()}.result`;

export async function readStateJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await readAppState(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export const readCheckStatus = () => readStateJson<DepotCheckStatus>(CHECK_STATUS_KEY());
export const readCheckResult = () => readStateJson<DepotCheckResult>(CHECK_RESULT_KEY());

/** The owner's notes for the depot manager, by ticker: private like the trades (CLAUDE.md). */
export const NOTES_KEY = () => `depot.notes.${tradesSource()}`;

export async function readDepotNotes(): Promise<Record<string, DepotNote>> {
  return (await readStateJson<Record<string, DepotNote>>(NOTES_KEY())) ?? {};
}

/** Keep a note; an empty one forgets the stock's. */
export async function writeDepotNote(symbol: string, text: string): Promise<Record<string, DepotNote>> {
  const notes = await readDepotNotes();
  const t = text.trim().slice(0, 2000);
  if (t) notes[symbol] = { text: t, at: new Date().toISOString() };
  else delete notes[symbol];
  await writeAppState(NOTES_KEY(), JSON.stringify(notes));
  return notes;
}
