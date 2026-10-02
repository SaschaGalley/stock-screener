/**
 * Cached access to a stock's rebuilt valuation history.
 *
 * Same split as `perplexity-service.ts`: `backtest/history.ts` does the work,
 * `db/store.ts` the persistence, and the policy that joins them sits here. The
 * work is a SEC download, two price histories and sixty runs of the models —
 * a few seconds the first time a stock is opened, and nothing worth repeating
 * within a day: a month-end comes once a month and a filing once a quarter.
 */

import { getConfig } from './config.js';
import { reconstructHistory } from './backtest/history.js';
import type { HistoryMultiple, SectorMultiples, ValuationHistory } from './analysis/valuation-history.js';
import { peerDistribution } from './analysis/valuation-history.js';
import { latestSnapshot, latestValuesInSector, readFinancialsLax, saveSnapshot, symbolGroup } from './db/store.js';
import { logger } from './utils/logger.js';

/** Bump when the shape or the reconstruction changes; older rows are rebuilt. */
export const VALUATION_HISTORY_VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One rebuild per symbol at a time — a page opened twice should not pay twice. */
const inFlight = new Map<string, Promise<ValuationHistory | null>>();

export async function getValuationHistory(symbol: string): Promise<ValuationHistory | null> {
  const stored = await latestSnapshot<ValuationHistory>(symbol, 'valuation_history', {
    schemaVer: VALUATION_HISTORY_VERSION, maxAgeMs: MAX_AGE_MS,
  });
  if (stored && !stored.stale) return stored.data;

  const running = inFlight.get(symbol);
  if (running) return running;
  const job = rebuild(symbol).finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, job);
  return job;
}

async function rebuild(symbol: string): Promise<ValuationHistory | null> {
  // Lax: the history needs the name, sector and annual figures, none of which a
  // stale snapshot gets wrong enough to matter.
  const financials = await readFinancialsLax(symbol);
  if (!financials) return null;
  const cfg = getConfig();
  const started = Date.now();
  const history = await reconstructHistory({ financials, dataDir: cfg.dataDir, fredApiKey: cfg.fredApiKey });
  if (!history) return null;
  logger.info(`${symbol}: valuation history rebuilt from ${history.source} — ${history.points.length} months in ${Date.now() - started} ms`);
  await saveSnapshot(symbol, 'valuation_history', VALUATION_HISTORY_VERSION, history);
  return history;
}

// ── The same multiples across the stock's industry ──────────────────────────

/** Where each multiple is recorded — the observation keys the projection derived from the metrics schema. */
const MULTIPLE_METRIC_KEYS: Record<HistoryMultiple, string> = {
  pe:       'metrics.ratios.pe',
  ps:       'metrics.evMultiples.priceToSales',
  pfcf:     'metrics.evMultiples.priceToFCF',
  evEbitda: 'metrics.evMultiples.evToEbitda',
};
/** Readings older than this belong to another price. The universe cycles in about six nights. */
const SECTOR_WINDOW_DAYS = 14;
/** An industry with fewer readings than this is too small to rank against; the sector is used instead. */
const MIN_INDUSTRY_MEMBERS = 10;

/**
 * Each multiple against the stock's industry — "dearer than four in five
 * application-software companies" — which is the comparison the peer medians
 * cannot make: they are one number, Finnhub's handful of peers, and say
 * nothing about where in the spread a stock sits.
 */
export async function sectorMultiples(symbol: string): Promise<SectorMultiples | null> {
  const g = await symbolGroup(symbol);
  if (!g?.sector) return null;
  const keys = Object.values(MULTIPLE_METRIC_KEYS);
  const rows = await latestValuesInSector(g.sector, keys, SECTOR_WINDOW_DAYS);
  const inIndustry = rows.filter((r) => g.industry && r.industry === g.industry);
  const industryMembers = new Set(inIndustry.map((r) => r.symbol)).size;
  const level = g.industry && industryMembers >= MIN_INDUSTRY_MEMBERS ? 'industry' : 'sector';
  const pool = level === 'industry' ? inIndustry : rows;

  const multiples: SectorMultiples['multiples'] = {};
  for (const [m, key] of Object.entries(MULTIPLE_METRIC_KEYS) as [HistoryMultiple, string][]) {
    const forKey = pool.filter((r) => r.key === key);
    const own = forKey.find((r) => r.symbol === symbol.toUpperCase())?.value ?? null;
    const d = peerDistribution(forKey.filter((r) => r.symbol !== symbol.toUpperCase()).map((r) => r.value), own);
    if (d) multiples[m] = d;
  }
  return { level, group: level === 'industry' ? g.industry! : g.sector, multiples };
}
