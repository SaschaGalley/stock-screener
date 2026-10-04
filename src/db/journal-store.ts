/** The journal, stored. See `migrations/013_journal.sql`. */

import type { JournalInput, JournalKind, JournalRevision } from '../journal.js';
import { query, queryOne } from './client.js';

export interface JournalRow {
  id:        number;
  day:       string;
  kind:      JournalKind;
  symbols:   string[];
  body:      string;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, day, kind, symbols, body, created_at AS "createdAt", updated_at AS "updatedAt"`;

type Raw = Omit<JournalRow, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };
const row = (r: Raw): JournalRow => ({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });

/** Every entry, newest day first — or those naming `symbol`. */
export async function listJournal(symbol?: string): Promise<JournalRow[]> {
  const res = await query<Raw>(
    `SELECT ${COLUMNS} FROM journal_entries
      WHERE deleted_at IS NULL AND ($1::text IS NULL OR symbols @> ARRAY[$1::text])
      ORDER BY day DESC, id DESC`,
    [symbol?.toUpperCase() ?? null],
  );
  return res.rows.map(row);
}

/** Entries naming any of `symbols` from `from` on — the timelines' read. */
export async function journalForSymbols(symbols: string[], from: string): Promise<JournalRow[]> {
  const res = await query<Raw>(
    `SELECT ${COLUMNS} FROM journal_entries
      WHERE deleted_at IS NULL AND symbols && $1::text[] AND day >= $2::date
      ORDER BY day DESC, id DESC`,
    [symbols.map((s) => s.toUpperCase()), from],
  );
  return res.rows.map(row);
}

export async function journalRevisions(ids: number[]): Promise<Map<number, JournalRevision[]>> {
  const out = new Map<number, JournalRevision[]>();
  if (ids.length === 0) return out;
  const res = await query<{ entryId: number; day: string; kind: JournalKind; symbols: string[]; body: string; savedAt: Date }>(
    `SELECT entry_id AS "entryId", day, kind, symbols, body, saved_at AS "savedAt"
       FROM journal_revisions WHERE entry_id = ANY($1) ORDER BY saved_at`,
    [ids],
  );
  for (const r of res.rows) {
    const list = out.get(r.entryId) ?? [];
    list.push({ day: r.day, kind: r.kind, symbols: r.symbols, body: r.body, savedAt: r.savedAt.toISOString() });
    out.set(r.entryId, list);
  }
  return out;
}

export async function createJournal(e: JournalInput): Promise<JournalRow> {
  const r = await queryOne<Raw>(
    `INSERT INTO journal_entries (day, kind, symbols, body) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [e.day, e.kind, e.symbols, e.body],
  );
  return row(r!);
}

/**
 * Replace an entry's wording, keeping the one it replaces. Null when there is
 * no such entry. Saving it unchanged keeps no copy.
 */
export async function updateJournal(id: number, e: JournalInput): Promise<JournalRow | null> {
  await query(
    `INSERT INTO journal_revisions (entry_id, day, kind, symbols, body)
     SELECT id, day, kind, symbols, body FROM journal_entries
      WHERE id = $1 AND deleted_at IS NULL
        AND (day, kind, symbols, body) IS DISTINCT FROM ($2::date, $3::text, $4::text[], $5::text)`,
    [id, e.day, e.kind, e.symbols, e.body],
  );
  const r = await queryOne<Raw>(
    `UPDATE journal_entries SET day = $2, kind = $3, symbols = $4, body = $5, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    [id, e.day, e.kind, e.symbols, e.body],
  );
  return r ? row(r) : null;
}

/** Marked, not removed — a deleted entry is a click away from coming back. */
export async function deleteJournal(id: number): Promise<boolean> {
  const res = await query('UPDATE journal_entries SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
  return (res.rowCount ?? 0) > 0;
}
