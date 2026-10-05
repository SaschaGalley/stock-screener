/**
 * The journal, read back with what has happened since.
 *
 * An entry names stocks and a day; the prices on file say how each has moved
 * from that day's close to the last one. That is the first half of learning
 * from it — "sold at the low", "bought on a headline and gave back 15 %" — and
 * it costs nothing to keep: the move is computed on read, so an entry dated
 * back to last spring gets last spring's close.
 */

import { entryContext, type EntryContext } from './analysis/entry-context.js';
import { readPriceBars, readPriceBarsMany } from './db/history-store.js';
import { readFinancialsLax, readSeries } from './db/store.js';
import {
  createJournal, deleteJournal, journalRevisions, listJournal, updateJournal, type JournalRow,
} from './db/journal-store.js';
import {
  isJournalKind, mentionedSymbols, normalizeSymbols, type JournalEntry, type JournalInput, type JournalKind,
  type JournalMove,
} from './journal.js';
import { invalidateFeed } from './stock-history-service.js';

const DAY_MS = 86_400_000;
/** How far back to look for the last close before an entry made on a weekend or a holiday. */
const LOOKBACK_DAYS = 10;

export class JournalInputError extends Error {}

/** A request body as an entry, or a JournalInputError saying what is wrong with it. */
export function parseJournalInput(raw: unknown): JournalInput {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const body = typeof o.body === 'string' ? o.body.replace(/\s+$/, '') : '';
  if (!body.trim()) throw new JournalInputError('Der Eintrag ist leer.');
  const kind = o.kind ?? 'note';
  if (!isJournalKind(kind)) throw new JournalInputError(`Unbekannte Art: ${String(kind)}`);
  const day = typeof o.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.day) && !Number.isNaN(Date.parse(o.day))
    ? o.day
    : null;
  if (!day) throw new JournalInputError('Datum fehlt oder ist ungültig (YYYY-MM-DD).');
  // Named in the field or mentioned as $TICKER in the text — both link the entry.
  const symbols = normalizeSymbols([...normalizeSymbols(o.symbols), ...mentionedSymbols(body)]);
  if (kind !== 'note' && symbols.length === 0) {
    throw new JournalInputError('Ein Kauf oder Verkauf braucht die Aktie.');
  }
  // The trades from the bookkeeping this entry gives the reason for.
  const tradeIds = Array.isArray(o.tradeIds)
    ? [...new Set(o.tradeIds.filter((x): x is number => Number.isInteger(x) && (x as number) > 0))]
    : [];
  return { day, kind, symbols, body, tradeIds };
}

export async function readJournal(symbol?: string): Promise<JournalEntry[]> {
  const rows = await listJournal(symbol);
  return withContext(rows);
}

export async function addJournal(input: JournalInput): Promise<JournalEntry> {
  const row = await createJournal(input);
  invalidateFeed();
  return (await withContext([row]))[0];
}

export async function editJournal(id: number, input: JournalInput): Promise<JournalEntry | null> {
  const row = await updateJournal(id, input);
  if (!row) return null;
  invalidateFeed();
  return (await withContext([row]))[0];
}

export async function removeJournal(id: number): Promise<boolean> {
  const done = await deleteJournal(id);
  if (done) invalidateFeed();
  return done;
}

async function withContext(rows: JournalRow[]): Promise<JournalEntry[]> {
  if (rows.length === 0) return [];
  const tickers = [...new Set(rows.flatMap((r) => r.symbols))];
  const earliest = rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0].day);
  const from = new Date(Date.parse(earliest) - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const [bars, revisions] = await Promise.all([
    tickers.length > 0 ? readPriceBarsMany(tickers, from) : new Map<string, never[]>(),
    journalRevisions(rows.map((r) => r.id)),
  ]);
  return rows.map((r) => ({
    ...r,
    revisions: revisions.get(r.id) ?? [],
    moves: r.symbols.flatMap((s) => {
      const m = moveSince(totalReturnCloses(bars.get(s) ?? []), r.day);
      return m ? [{ symbol: s, ...m }] : [];
    }),
  }));
}

/**
 * Adjusted closes where the whole stretch has them, so a dividend paid in
 * between is not read as a fall; one gap and it falls back to plain closes.
 */
function totalReturnCloses(bars: { day: string; close: number; adjClose: number | null }[]): { day: string; close: number }[] {
  const adjusted = bars.every((b) => b.adjClose !== null && b.adjClose > 0);
  return bars.map((b) => ({ day: b.day, close: adjusted ? b.adjClose! : b.close }));
}

/**
 * From the last close on or before `day` to the newest. Null without a close
 * that old, and for an entry from today: a move of nothing says nothing.
 */
export function moveSince(bars: { day: string; close: number }[], day: string): Omit<JournalMove, 'symbol'> | null {
  let from: { day: string; close: number } | undefined;
  for (const b of bars) {
    if (b.day > day) break;
    from = b;
  }
  const to = bars[bars.length - 1];
  if (!from || !to || to.day <= from.day || !(from.close > 0)) return null;
  // A close more than the lookback before the entry is a gap in the history, not its day.
  if (Date.parse(day) - Date.parse(from.day) > LOOKBACK_DAYS * DAY_MS) return null;
  return { fromDay: from.day, fromClose: from.close, toDay: to.day, toClose: to.close, change: to.close / from.close - 1 };
}

/** How many stocks one look at the situation covers — an entry naming more is about a theme, not a trade. */
const CONTEXT_LIMIT = 5;

/**
 * The situation of each stock on `day`: the run-up, the volume, the year's
 * high and low, our own verdict then, and a report due within the week. Read
 * before a purchase is entered and beside it afterwards.
 */
export async function entryContexts(symbols: string[], day: string, kind: JournalKind): Promise<EntryContext[]> {
  // A year for the high, the low and what counts as a jump, and a margin for the averages.
  const from = new Date(Date.parse(day) - 400 * DAY_MS).toISOString().slice(0, 10);
  // Only the next scheduled report is stored, so it says something about now, not about last spring.
  const recent = Date.now() - Date.parse(day) < 2 * DAY_MS;
  return Promise.all(normalizeSymbols(symbols).slice(0, CONTEXT_LIMIT).map(async (symbol) => {
    const [bars, series, financials] = await Promise.all([
      readPriceBars(symbol, from),
      readSeries(symbol, ['score.final.score', 'score.final.verdict'], { to: new Date(`${day}T23:59:59`) }),
      recent ? readFinancialsLax(symbol) : null,
    ]);
    const newest = (key: string) => series.find((x) => x.key === key)?.points.at(-1);
    return entryContext(symbol, kind, day, bars, {
      score:   newest('score.final.score')?.value ?? null,
      verdict: newest('score.final.verdict')?.text ?? null,
    }, financials?.nextEarningsDate ?? null);
  }));
}
