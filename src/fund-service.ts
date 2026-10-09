/**
 * The funds' holdings for the depot's look-through: Yahoo's sector split and
 * ten largest holdings, and where the fund's issuer lists it (Amundi, iShares,
 * SPDR, Vanguard, Xtrackers), its every holding in place of the ten. Each
 * answer is the stored one while it is less than a week old, else asked again
 * and kept. A fund nobody describes is left out and the page says so; a failed
 * or empty fetch falls back to an older answer.
 */

import type { FundHoldings } from './analysis/look-through.js';
import { fetchComposition, ISSUER_NAMES, ISSUERS, parseComposition, type Composition } from './data/fund-composition.js';
import { fetchFundHoldings, parseTopHoldings } from './data/fund-holdings.js';
import { latestFundCompositions, latestFundHoldings, saveFundComposition, saveFundHoldings } from './db/fund-store.js';
import { logger } from './utils/logger.js';

/** A fund's holdings move slowly: a week-old answer is today's. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Kept when no issuer knows the fund, so that it is asked again only after a week; an older list still counts. */
const NONE = 'none';
/** A 'none' that asked fewer issuers than there are now is asked again at once. */
const askedAll = (raw: unknown) => {
  const asked = (raw as { asked?: unknown } | null)?.asked;
  return Array.isArray(asked) && ISSUERS.every((i) => asked.includes(i));
};

/** The funds by ISIN. */
export async function fundHoldings(funds: readonly { isin: string; symbol: string | null }[]): Promise<Map<string, FundHoldings>> {
  const [yahoo, lists] = await Promise.all([
    yahooHoldings(funds.flatMap((f) => (f.symbol ? [f.symbol] : []))),
    compositions(funds.map((f) => f.isin)),
  ]);
  const out = new Map<string, FundHoldings>();
  for (const f of funds) {
    const y = f.symbol ? yahoo.get(f.symbol) : undefined;
    const c = lists.get(f.isin);
    if (!y && !c) continue;
    out.set(f.isin, {
      symbol: f.symbol,
      asOf: c?.asOf ?? y?.asOf ?? new Date().toISOString(),
      holdings: c?.holdings ?? y!.holdings,
      full: c ? ISSUER_NAMES[c.issuer] : null,
      sectors: y?.sectors ?? [], equity: y?.equity ?? null, bonds: y?.bonds ?? null, cash: y?.cash ?? null,
    });
  }
  return out;
}

async function yahooHoldings(symbols: readonly string[]): Promise<Map<string, FundHoldings>> {
  const stored = await latestFundHoldings(symbols);
  const out = new Map<string, FundHoldings>();
  await Promise.all(symbols.map(async (symbol) => {
    const s = stored.get(symbol);
    if (s && Date.now() - s.seenAt.getTime() < MAX_AGE_MS) {
      const h = parseTopHoldings(symbol, s.raw, s.seenAt.toISOString());
      if (h) out.set(symbol, h);
      return;
    }
    try {
      const { raw, holdings } = await fetchFundHoldings(symbol);
      if (raw) await saveFundHoldings(symbol, raw);
      if (holdings) { out.set(symbol, holdings); return; }
    } catch (e) {
      logger.warn(`Fund holdings ${symbol}: ${(e as Error).message}`);
    }
    const old = s ? parseTopHoldings(symbol, s.raw, s.seenAt.toISOString()) : null;
    if (old) out.set(symbol, old);
  }));
  return out;
}

async function compositions(isins: readonly string[]): Promise<Map<string, Composition>> {
  const stored = await latestFundCompositions(isins);
  const out = new Map<string, Composition>();
  await Promise.all(isins.map(async (isin) => {
    const s = stored.get(isin);
    const old = s && s.issuer !== NONE ? parseComposition(s.issuer, s.raw) : null;
    if (s && Date.now() - s.askedAt.getTime() < MAX_AGE_MS && (s.issuer !== NONE || askedAll(s.raw))) {
      if (old) out.set(isin, old);
      return;
    }
    try {
      const got = await fetchComposition(isin);
      await saveFundComposition(isin, got?.issuer ?? NONE, got?.raw ?? { asked: ISSUERS });
      const c = (got && parseComposition(got.issuer, got.raw)) ?? old;
      if (c) out.set(isin, c);
      return;
    } catch (e) {
      logger.warn(`Fund composition ${isin}: ${(e as Error).message}`);
    }
    if (old) out.set(isin, old);
  }));
  return out;
}
