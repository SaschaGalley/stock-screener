/**
 * Trades from umsatz, the owner's bookkeeping, for the journal to ask about.
 *
 * umsatz is the record of what was bought and sold; this app only wants to
 * know why. Every purchase and sale without an entry giving its reason is
 * offered in the journal, prefilled; savings plans and spin-offs are kept but
 * never asked about, since nobody decided them.
 *
 * The data is real: develop against it in aggregate only (see CLAUDE.md).
 */

import { getConfig } from './config.js';
import { readAppState, writeAppState } from './db/admin.js';
import { dismissTrades, openTrades, replaceTrades, type TradeRow } from './db/trades-store.js';
import { TRADE_KINDS, type OpenTrades, type TradeKind } from './journal.js';
import { logger } from './utils/logger.js';

const SOURCE = 'umsatz';
const SYNCED_AT = 'trades.umsatz.syncedAt';
const SYNC_ERROR = 'trades.umsatz.syncError';
/** The journal page asks on every visit; umsatz is asked at most this often. */
const SYNC_EVERY_MS = 10 * 60_000;

/** One trade as umsatz sends it, or null when it is not one. */
export function tradeFromUmsatz(v: unknown): TradeRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
  const id = str(o.id);
  const day = str(o.day)?.slice(0, 10) ?? null;
  const isin = str(o.isin);
  const kind = str(o.kind);
  const quantity = num(o.quantity);
  const price = num(o.price);
  if (!id || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !isin || quantity === null || price === null) return null;
  if (!kind || !(TRADE_KINDS as readonly string[]).includes(kind)) return null;
  return {
    externalId:   id,
    day,
    isin:         isin.toUpperCase(),
    sourceSymbol: str(o.symbol)?.toUpperCase() ?? null,
    name:         str(o.name) ?? isin,
    assetType:    str(o.assetType) ?? 'unknown',
    kind:         kind as TradeKind,
    quantity:     Math.abs(quantity),
    price,
    currency:     str(o.currency) ?? 'EUR',
    fee:          num(o.fee) ?? 0,
  };
}

/** Fetch every trade from umsatz and replace the copy. Throws when umsatz cannot be read. */
export async function syncTrades(): Promise<{ total: number; added: number }> {
  const { umsatzApiUrl, umsatzApiKey } = getConfig();
  if (!umsatzApiKey) throw new Error('UMSATZ_API_KEY ist nicht gesetzt.');
  try {
    const res = await fetch(`${umsatzApiUrl.replace(/\/$/, '')}/integrations/stock-cli/trades`, {
      headers: { 'x-api-key': umsatzApiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`umsatz antwortet mit ${res.status}${res.status === 401 ? ' — der Schlüssel passt nicht' : ''}`);
    const body = await res.json() as { trades?: unknown };
    if (!Array.isArray(body.trades)) throw new Error('umsatz hat keine Liste von Trades geschickt');
    const rows = body.trades.map(tradeFromUmsatz).filter((r): r is TradeRow => r !== null);
    const out = await replaceTrades(SOURCE, rows);
    await writeAppState(SYNCED_AT, new Date().toISOString());
    await writeAppState(SYNC_ERROR, '');
    logger.info(`Trades from umsatz: ${out.total}, ${out.added} new`);
    return out;
  } catch (e) {
    const message = e instanceof Error && e.name === 'TimeoutError' ? 'umsatz antwortet nicht' : (e as Error).message;
    await writeAppState(SYNC_ERROR, message);
    throw new Error(message);
  }
}

/**
 * The trades still waiting for a reason, synced first when the copy is older
 * than ten minutes (or `force`). A failed sync is reported beside the trades
 * from before, not instead of them.
 */
export async function readOpenTrades(symbol?: string, force = false): Promise<OpenTrades> {
  const configured = !!getConfig().umsatzApiKey;
  if (configured) {
    const last = await readAppState(SYNCED_AT);
    if (force || !last || Date.now() - Date.parse(last) > SYNC_EVERY_MS) {
      await syncTrades().catch(() => { /* recorded in SYNC_ERROR */ });
    }
  }
  const [syncedAt, syncError, trades] = await Promise.all([
    readAppState(SYNCED_AT), readAppState(SYNC_ERROR), openTrades(symbol),
  ]);
  return { configured, syncedAt, syncError: syncError || null, trades };
}

export const ignoreTrades = (ids: number[]) => dismissTrades(ids);
