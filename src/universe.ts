/**
 * The reference universe: which stocks it holds, and which of them tonight's
 * run refreshes.
 *
 * Several hundred stocks cannot all be refreshed every night against a
 * 60-per-minute Finnhub budget, and they do not need to be: they are scored to
 * give the score a population, not to be watched. Each night refreshes the
 * `batchSize` members refreshed longest ago, so the whole universe comes round
 * every few nights and a symbol a night failed on is still among the oldest.
 *
 * A reference refresh is the data step on a diet (`refreshStockData` with
 * `reference`): no news, no options chain, no Distill, peers once a month, and
 * never an analysis. What it keeps is everything the factor score reads.
 *
 * **Leaving is part of the record.** A stock that drops out of an index has
 * usually fallen first, and an evaluation that stops scoring it the day it
 * leaves only ever sees the survivors. So a member that leaves every index is
 * scored for `DEPARTED_GRACE_DAYS` more — a quarter, the evaluation's longest
 * horizon — before the rotation lets it go.
 */

import { AppConfig } from './app-config.js';
import { readAppState, writeAppState } from './db/admin.js';
import { referenceRotation } from './db/store.js';
import { UNIVERSE_SOURCES } from './data/universe.js';
import { logger } from './utils/logger.js';

const MEMBERSHIP_KEY = 'universe.membership';
/** Where the S&P-only list lived before the universe had more than one index. */
const LEGACY_MEMBERS_KEY = 'universe.members';

/** How long a stock that left every index is still scored. */
export const DEPARTED_GRACE_DAYS = 90;

export interface Membership {
  /** Current members, per index. */
  bySource: Record<string, string[]>;
  /** Symbols that have left every index, with the day they left (YYYY-MM-DD). */
  departed: Record<string, string>;
}

/**
 * Every index's members once, in the sources' order. A later index's listing
 * of a European company an earlier one already holds on another exchange is
 * left out — the DAX lists Airbus as AIR on Xetra, the EURO STOXX 50 as AIR.PA,
 * and one company must not count twice in the population. Only suffixed
 * tickers are compared, and only across indices: EL is Estée Lauder in New
 * York and EL.PA is EssilorLuxottica, and SAN.MC and SAN.PA are a bank and a
 * drugmaker inside one index.
 */
export function unionMembers(bySource: Record<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const europeanRoots = new Set<string>();
  const root = (t: string) => t.split('.')[0];
  for (const { key } of UNIVERSE_SOURCES) {
    const roots = new Set<string>();
    for (const t of bySource[key] ?? []) {
      if (seen.has(t)) continue;
      if (t.includes('.') && europeanRoots.has(root(t))) continue;
      seen.add(t);
      out.push(t);
      if (t.includes('.')) roots.add(root(t));
    }
    for (const r of roots) europeanRoots.add(r);
  }
  return out;
}

/**
 * The membership after a fetch. An index whose fetch failed keeps its last
 * list, so a Wikipedia outage cannot look like forty companies leaving. A
 * symbol no index lists any more is recorded as departed today; one that comes
 * back is no longer departed.
 */
export function nextMembership(
  prev: Membership | null, fetched: Record<string, string[] | null>, today: string,
): Membership {
  const bySource: Record<string, string[]> = {};
  for (const { key } of UNIVERSE_SOURCES) bySource[key] = fetched[key] ?? prev?.bySource[key] ?? [];
  const now = new Set(unionMembers(bySource));
  const departed: Record<string, string> = {};
  for (const [symbol, since] of Object.entries(prev?.departed ?? {})) {
    if (!now.has(symbol)) departed[symbol] = since;
  }
  for (const symbol of unionMembers(prev?.bySource ?? {})) {
    if (!now.has(symbol) && !(symbol in departed)) departed[symbol] = today;
  }
  return { bySource, departed };
}

/** The members to score: every current one, and those that left within the grace period. */
export function activeMembers(m: Membership, today: string, graceDays = DEPARTED_GRACE_DAYS): string[] {
  const cutoff = Date.parse(today) - graceDays * 86_400_000;
  const leaving = Object.entries(m.departed)
    .filter(([, since]) => Date.parse(since) >= cutoff)
    .map(([symbol]) => symbol);
  return [...new Set([...unionMembers(m.bySource), ...leaving])];
}

/** The membership as last stored; the S&P-only list of the first version counts as its S&P part. */
export async function storedMembership(): Promise<Membership | null> {
  try {
    const raw = await readAppState(MEMBERSHIP_KEY);
    if (raw) return JSON.parse(raw) as Membership;
    const legacy = await readAppState(LEGACY_MEMBERS_KEY);
    const members = legacy ? (JSON.parse(legacy) as { members?: string[] }).members : null;
    return Array.isArray(members) ? { bySource: { sp500: members }, departed: {} } : null;
  } catch {
    return null;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The members to score today, without fetching anything. */
export async function storedMembers(): Promise<string[]> {
  const m = await storedMembership();
  return m ? activeMembers(m, today()) : [];
}

/**
 * Fetch every index, keep what each list says where it looks like the index
 * and the last good list where it does not, record who left, and return the
 * members to score.
 */
export async function universeMembers(): Promise<string[]> {
  const fetched: Record<string, string[] | null> = {};
  for (const source of UNIVERSE_SOURCES) {
    fetched[source.key] = null;
    try {
      const members = await source.fetch();
      if (members.length >= source.minSize) fetched[source.key] = members;
      else logger.warn(`${source.label} list parsed to ${members.length} members — keeping the stored list`);
    } catch (e) {
      logger.warn(`${source.label} list unavailable (${(e as Error).message}) — keeping the stored list`);
    }
  }
  const next = nextMembership(await storedMembership(), fetched, today());
  await writeAppState(MEMBERSHIP_KEY, JSON.stringify(next));
  const left = Object.keys(next.departed).length;
  if (left > 0) logger.info(`Universe: ${left} former member(s) still scored for the grace period`);
  return activeMembers(next, today());
}

/**
 * Tonight's reference symbols, least recently refreshed first. Empty when the
 * universe is off, and when the data step is: a reference refresh is that step.
 */
export async function referenceBatch(config: AppConfig): Promise<string[]> {
  const { enabled, batchSize } = config.universe;
  if (!enabled || batchSize <= 0 || !config.steps.data.enabled) return [];
  return referenceRotation(await universeMembers(), batchSize);
}
