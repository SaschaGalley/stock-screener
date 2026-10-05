/**
 * The journal: what I read, thought, bought and sold, and why.
 *
 * Pure and dependency-free so the web app imports the same kinds, labels and
 * the same reading of `$TICKER` as the server stores.
 */

export const JOURNAL_KINDS = ['note', 'buy', 'sell'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const JOURNAL_LABEL: Record<JournalKind, string> = {
  note: 'Notiz',
  buy:  'Kauf',
  sell: 'Verkauf',
};

/** What the move since the entry is called — since a sale it is what was given up. */
export const JOURNAL_SINCE: Record<JournalKind, string> = {
  note: 'seit Notiz',
  buy:  'seit Kauf',
  sell: 'seit Verkauf',
};

export const isJournalKind = (v: unknown): v is JournalKind =>
  typeof v === 'string' && (JOURNAL_KINDS as readonly string[]).includes(v);

/** A ticker as Yahoo writes it: BRK-B, ENR.DE, 0700.HK, ^GSPC. */
const TICKER = /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/;

/**
 * `$NVDA` in the text links the entry to NVDA. A letter must follow the
 * dollar, so "$17" is a price and not a ticker.
 */
const MENTION = /(^|[^\w$])\$([A-Za-z][A-Za-z0-9.\-]{0,14})/g;

export function mentionedSymbols(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION)) {
    // A sentence may end right after the ticker: "$NOW." is NOW.
    const s = m[2].replace(/[.\-]+$/, '').toUpperCase();
    if (TICKER.test(s)) out.add(s);
  }
  return [...out];
}

/** Upper case, trimmed, each once, in the order given — and nothing that cannot be a ticker. */
export function normalizeSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return [];
  const out = new Set<string>();
  for (const s of symbols) {
    if (typeof s !== 'string') continue;
    const t = s.trim().replace(/^\$/, '').toUpperCase();
    if (TICKER.test(t)) out.add(t);
  }
  return [...out];
}

/** The text with every `$TICKER` turned into a link to its page. */
export function linkMentions(body: string): string {
  return body.replace(MENTION, (all, lead: string, raw: string) => {
    const s = raw.replace(/[.\-]+$/, '');
    const rest = raw.slice(s.length);
    return TICKER.test(s.toUpperCase()) ? `${lead}[$${s.toUpperCase()}](#/stock/${s.toUpperCase()})${rest}` : all;
  });
}

/** The first line, without markdown, for a one-line mention on a timeline. */
export function journalHeadline(body: string, max = 140): string {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const plain = line
    .replace(/^#+\s*|^[-*>]\s+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '');
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export interface JournalRevision {
  day:     string;
  kind:    JournalKind;
  symbols: string[];
  body:    string;
  /** When this wording was replaced. */
  savedAt: string;
}

/** How a stock named in the entry has moved since its day. */
export interface JournalMove {
  symbol: string;
  /** The close the move is measured from — the entry's day, or the last trading day before it. */
  fromDay:   string;
  fromClose: number;
  toDay:     string;
  toClose:   number;
  /** Total return, dividends included where the history has them. */
  change:    number;
}

export interface JournalEntry {
  id:        number;
  /** The trades this entry gives the reason for. Empty for a note. */
  tradeIds:  number[];
  day:       string;
  kind:      JournalKind;
  symbols:   string[];
  body:      string;
  createdAt: string;
  updatedAt: string;
  /** Earlier wordings, oldest first. Empty for an entry never edited. */
  revisions: JournalRevision[];
  /** One per named stock with prices on file. */
  moves:     JournalMove[];
}

export interface JournalInput {
  day:      string;
  kind:     JournalKind;
  symbols:  string[];
  body:     string;
  tradeIds: number[];
}

/**
 * What a booking in the depot was. Only a purchase and a sale were decided;
 * a savings plan runs by itself and a spin-off happens to the holder.
 */
export const TRADE_KINDS = ['buy', 'sell', 'savings-plan', 'spin-off'] as const;
export type TradeKind = (typeof TRADE_KINDS)[number];

/** A trade from umsatz, the owner's bookkeeping. */
export interface Trade {
  id:        number;
  day:       string;
  isin:      string;
  /** This app's ticker when a stored stock carries the ISIN, the bookkeeping's own symbol otherwise. */
  symbol:    string | null;
  name:      string;
  assetType: string;
  kind:      TradeKind;
  quantity:  number;
  price:     number;
  currency:  string;
}

/** The trades still waiting for a reason, and whether there is anywhere to get them from. */
export interface OpenTrades {
  configured: boolean;
  syncedAt:   string | null;
  /** Why the last sync failed, when it did; the trades are then the ones from before. */
  syncError:  string | null;
  trades:     Trade[];
}
