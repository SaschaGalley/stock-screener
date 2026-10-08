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
import { dismissTrades, openTrades, replaceTrades, savePrices, type TradeRow } from './db/trades-store.js';
import { TRADE_KINDS, type OpenTrades, type TradeKind } from './journal.js';
import { logger } from './utils/logger.js';

/** Where the copy is kept: `umsatz`, or a placeholder's own source in development (`tradesSource`). */
export const tradesSource = (): string => getConfig().tradesSource;
const SYNCED_AT = () => `trades.${tradesSource()}.syncedAt`;
const SYNC_ERROR = () => `trades.${tradesSource()}.syncError`;
const SYNC_TRIED_AT = () => `trades.${tradesSource()}.triedAt`;
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

/** GET a stock-cli route of umsatz. Throws with a message fit for the page. */
async function fromUmsatz(path: string): Promise<unknown> {
  const { umsatzApiUrl, umsatzApiKey } = getConfig();
  if (!umsatzApiKey) throw new Error('UMSATZ_API_KEY ist nicht gesetzt.');
  const url = `${umsatzApiUrl.replace(/\/$/, '')}/integrations/stock-cli/${path}`;
  const res = await fetch(url, { headers: { 'x-api-key': umsatzApiKey }, signal: AbortSignal.timeout(20_000) });
  return umsatzJson(res, url);
}

/**
 * The body of umsatz's answer, or an error that says what is wrong in words
 * the page can show. umsatz serves its API and its admin from two hosts, and
 * the admin answers every path with its own page and a 200 — so a URL that
 * points at the admin does not fail, it returns HTML, which `res.json()`
 * reports as "Unexpected token '<'".
 */
export async function umsatzJson(res: Response, url: string): Promise<unknown> {
  const where = (() => { try { return new URL(url).origin; } catch { return url; } })();
  if (res.status === 401) throw new Error(`umsatz unter ${where} lehnt den Schlüssel ab — UMSATZ_API_KEY und STOCK_CLI_API_KEY müssen gleich sein.`);
  if (res.status === 404) throw new Error(`Unter ${where} gibt es ${new URL(url).pathname} nicht — ist umsatz mit der stock-cli-Schnittstelle deployt?`);
  if (!res.ok) throw new Error(`umsatz unter ${where} antwortet mit ${res.status}.`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    throw new Error(`Unter ${where} antwortet keine umsatz-API, sondern eine Webseite. UMSATZ_API_URL muss auf die API zeigen `
      + '(dieselbe Adresse wie VITE_API_URL in umsatz), nicht auf die Admin-Oberfläche.');
  }
  return res.json();
}

/** One price as umsatz sends it, or null when it is not one. */
export function priceFromUmsatz(v: unknown): { isin: string; day: string; priceEur: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const isin = typeof o.isin === 'string' ? o.isin.trim().toUpperCase() : '';
  const day = typeof o.day === 'string' ? o.day.slice(0, 10) : '';
  const price = typeof o.priceEur === 'number' ? o.priceEur : Number(o.priceEur);
  return isin && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(price) && price > 0 ? { isin, day, priceEur: price } : null;
}

/**
 * Fetch every trade and each asset's newest euro price from umsatz, and
 * replace the copy. Throws when umsatz cannot be read.
 */
export async function syncTrades(): Promise<{ total: number; added: number }> {
  try {
    const [body, priced] = await Promise.all([
      fromUmsatz('trades') as Promise<{ trades?: unknown }>,
      fromUmsatz('prices') as Promise<{ prices?: unknown }>,
    ]);
    if (!Array.isArray(body.trades)) throw new Error('umsatz hat keine Liste von Trades geschickt');
    const rows = body.trades.map(tradeFromUmsatz).filter((r): r is TradeRow => r !== null);
    const out = await replaceTrades(tradesSource(), rows);
    const prices = Array.isArray(priced.prices) ? priced.prices.map(priceFromUmsatz).filter((p) => p !== null) : [];
    await savePrices(tradesSource(), prices);
    await writeAppState(SYNCED_AT(), new Date().toISOString());
    await writeAppState(SYNC_ERROR(), '');
    logger.info(`Trades from umsatz: ${out.total}, ${out.added} new; ${prices.length} prices`);
    return out;
  } catch (e) {
    const where = getConfig().umsatzApiUrl;
    const message = e instanceof Error && e.name === 'TimeoutError' ? `umsatz unter ${where} antwortet nicht`
      // Node's fetch says only "fetch failed" for a refused or unresolvable host.
      : e instanceof TypeError && e.message === 'fetch failed' ? `umsatz unter ${where} ist nicht erreichbar — stimmt UMSATZ_API_URL?`
      : (e as Error).message;
    await writeAppState(SYNC_ERROR(), message);
    throw new Error(message);
  }
}

/** Sync when the copy is older than ten minutes, or when asked to; a failure is recorded, not thrown. */
export async function syncTradesIfStale(force = false): Promise<void> {
  if (!getConfig().umsatzApiKey) return;
  // By the last attempt, not the last success: a sync that keeps failing
  // would otherwise be retried by every page that reads the trades.
  const [last, tried] = await Promise.all([readAppState(SYNCED_AT()), readAppState(SYNC_TRIED_AT())]);
  const newest = [last, tried].filter((x): x is string => !!x).map(Date.parse).reduce((a, b) => Math.max(a, b), 0);
  if (force || Date.now() - newest > SYNC_EVERY_MS) {
    await writeAppState(SYNC_TRIED_AT(), new Date().toISOString());
    await syncTrades().catch(() => { /* recorded under SYNC_ERROR */ });
  }
}

/** When the copy was last refreshed, and why the last attempt failed if it did. */
export async function tradesSyncState(): Promise<{ configured: boolean; syncedAt: string | null; syncError: string | null }> {
  const [syncedAt, syncError] = await Promise.all([readAppState(SYNCED_AT()), readAppState(SYNC_ERROR())]);
  return { configured: !!getConfig().umsatzApiKey, syncedAt, syncError: syncError || null };
}

/**
 * The trades still waiting for a reason, synced first when the copy is older
 * than ten minutes (or `force`). A failed sync is reported beside the trades
 * from before, not instead of them.
 */
export async function readOpenTrades(symbol?: string, force = false): Promise<OpenTrades> {
  await syncTradesIfStale(force);
  const [state, trades] = await Promise.all([tradesSyncState(), openTrades(tradesSource(), symbol)]);
  return { ...state, trades };
}

export const ignoreTrades = (ids: number[]) => dismissTrades(ids);
