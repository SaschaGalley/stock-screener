/**
 * The discover page's universe lists (`src/analysis/discover.ts`), read from
 * what the nightly rotation stored. Rebuilt at most every few minutes: the
 * universe moves once a night, and the read is a few hundred stocks' worth.
 */

import {
  ANALYST_DAYS, INSIDER_DAYS, TURN_DAYS, discoverUniverse, onePerCompany, type DiscoverUniverse, type UniverseStock,
} from './analysis/discover.js';
import { PILLAR_LABELS } from './analysis/score.js';
import { PILLAR_KEYS } from './types.js';
import { latestPointsForAll } from './db/store.js';
import {
  universeAnalystMoves, universeInsiderBuys, universeProfiles, universeVerdicts, watchlistNames,
} from './db/discover-store.js';
import { logoDomain } from './symbols.js';

const KEY = {
  score:       'score.final.score',
  verdict:     'score.final.verdict',
  fair:        'metrics.composite.primary.median',
  fairP25:     'metrics.composite.primary.p25',
  undervalued: 'metrics.composite.pctPrimaryUndervalued',
  confidence:  'metrics.composite.confidence',
  zone:        'metrics.altmanZ.zone',
  factor:      'score.factor.verdict',
  uncapped:    'score.factor.uncappedVerdict',
} as const;
const pillarKey = (p: string) => `score.factor.pillars.${p}.score`;

const DAY_MS = 86_400_000;
const TTL_MS = 10 * 60_000;
/** Every stock of the universe off the list, and the lists drawn from them. */
interface UniverseRead { stocks: UniverseStock[]; lists: DiscoverUniverse }
let memo: { at: number; value: Promise<UniverseRead> } | null = null;

async function readUniverse(now: Date): Promise<UniverseRead> {
  const days = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const [profiles, listed, points, verdicts, moves, buys] = await Promise.all([
    universeProfiles(),
    watchlistNames(),
    latestPointsForAll([...Object.values(KEY), ...PILLAR_KEYS.map(pillarKey)], { withReference: true }),
    // A little before the window, so a turn on its first day has a reading to turn from.
    universeVerdicts(days(TURN_DAYS + 15)),
    universeAnalystMoves(days(ANALYST_DAYS)),
    universeInsiderBuys(days(INSIDER_DAYS).toISOString().slice(0, 10)),
  ]);

  const stocks = profiles.map((p): UniverseStock => {
    const at = points.get(p.symbol);
    const value = (k: string) => at?.get(k)?.value ?? null;
    const text = (k: string) => at?.get(k)?.text ?? null;
    return {
      symbol:      p.symbol,
      name:        p.name,
      sector:      p.sector,
      industry:    p.industry,
      logoDomain:  logoDomain(p.website),
      currency:    p.currency,
      price:       p.price,
      marketCap:   p.marketCap,
      asOf:        at?.get(KEY.score)?.at ?? null,
      score:       value(KEY.score),
      verdict:     text(KEY.verdict),
      pillars:     PILLAR_KEYS.flatMap((k) => {
        const v = value(pillarKey(k));
        return v === null ? [] : [{ label: PILLAR_LABELS[k], score: v }];
      }),
      fair:        value(KEY.fair),
      fairP25:     value(KEY.fairP25),
      undervalued: value(KEY.undervalued),
      confidence:  value(KEY.confidence),
      health:      value(pillarKey('health')),
      distress:    text(KEY.zone) === 'distress',
      capped:      text(KEY.factor) !== null && text(KEY.factor) !== text(KEY.uncapped),
      stale:       p.stale,
    };
  });
  const kept = onePerCompany(stocks, listed);
  return { stocks: kept, lists: discoverUniverse({ stocks: kept, verdicts, moves, buys, now }) };
}

/** Forget the lists — a stock just joined the watchlist and leaves them. */
export function invalidateDiscover(): void {
  memo = null;
}

function cached(): Promise<UniverseRead> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
  const entry = { at: Date.now(), value: readUniverse(new Date()) };
  entry.value.catch(() => { if (memo === entry) memo = null; });
  memo = entry;
  return entry.value;
}

/** The lists, from the cache while it is fresh. */
export async function universeLists(): Promise<DiscoverUniverse> {
  return (await cached()).lists;
}

/** Every stock of the universe that is not on the list, one line per company. */
export async function universeStocks(): Promise<UniverseStock[]> {
  return (await cached()).stocks;
}
