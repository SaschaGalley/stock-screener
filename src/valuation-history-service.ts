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
import { fairMultiple, fitFairRatio, type FairRatio, type FairRatioModel, type FairRatioRow } from './analysis/fair-ratio.js';
import { peerDistribution } from './analysis/valuation-history.js';
import { latestSnapshot, latestSnapshotLax, latestValuesInSector, readFinancialsLax, saveSnapshot, symbolGroup } from './db/store.js';
import type { ComputedMetrics } from './analysis/computeMetrics.js';
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

// ── What the stock's growth, margins and risk would normally earn ───────────

/** The inputs the fair-multiple regression reads, by observation key. */
const FAIR_INPUT_KEYS = {
  revenueGrowth:   'financials.revenueGrowth',
  operatingMargin: 'financials.operatingMargin',
  grossProfit:     'financials.grossProfit',
  revenue:         'financials.revenue',
  beta:            'financials.beta',
} as const;
/** The multiples it explains — the two a reader compares first, and the two Simply Wall St picks between. */
const FAIR_MULTIPLES = ['pe', 'ps'] as const satisfies readonly HistoryMultiple[];
const FAIR_MODEL_TTL_MS = 6 * 60 * 60 * 1000;

type UniverseRow = { symbol: string; sector: string | null; values: Map<string, number> };
let fairCache: { at: number; rows: Map<string, UniverseRow>; models: Partial<Record<HistoryMultiple, FairRatioModel | null>> } | null = null;

async function fairModels() {
  if (fairCache && Date.now() - fairCache.at < FAIR_MODEL_TTL_MS) return fairCache;
  const keys = [...Object.values(FAIR_INPUT_KEYS), ...FAIR_MULTIPLES.map((m) => MULTIPLE_METRIC_KEYS[m])];
  const raw = await latestValuesInSector(null, keys, SECTOR_WINDOW_DAYS);
  const rows = new Map<string, UniverseRow>();
  for (const r of raw) {
    const row = rows.get(r.symbol) ?? { symbol: r.symbol, sector: r.sector, values: new Map() };
    row.values.set(r.key, r.value);
    rows.set(r.symbol, row);
  }
  const models: Partial<Record<HistoryMultiple, FairRatioModel | null>> = {};
  for (const m of FAIR_MULTIPLES) {
    models[m] = fitFairRatio([...rows.values()].map((r) => ({ ...inputsOf(r), multiple: r.values.get(MULTIPLE_METRIC_KEYS[m]) ?? null })));
  }
  fairCache = { at: Date.now(), rows, models };
  return fairCache;
}

function inputsOf(r: UniverseRow): Omit<FairRatioRow, 'multiple'> {
  const v = (k: string) => r.values.get(k) ?? null;
  const gp = v(FAIR_INPUT_KEYS.grossProfit), rev = v(FAIR_INPUT_KEYS.revenue);
  return {
    revenueGrowth:   v(FAIR_INPUT_KEYS.revenueGrowth),
    operatingMargin: v(FAIR_INPUT_KEYS.operatingMargin),
    grossMargin:     gp !== null && rev !== null && rev > 0 ? gp / rev : null,
    beta:            v(FAIR_INPUT_KEYS.beta),
    sector:          r.sector,
  };
}

/** The fair P/E and P/S for one stock, each with its fit — absent where the fit is too weak or the inputs missing. */
export async function fairRatios(symbol: string): Promise<Partial<Record<HistoryMultiple, FairRatio>>> {
  const { rows, models } = await fairModels();
  // The stock's own inputs from the universe's readings, else from its newest
  // stored payload: a watchlist stock not refreshed within the window still
  // has a fair multiple to read, only the fit needs today's cross-section.
  const own = rows.get(symbol.toUpperCase()) ?? await ownRow(symbol);
  if (!own) return {};
  const inputs = inputsOf(own);
  if (inputs.revenueGrowth === null || inputs.operatingMargin === null) return {};
  const out: Partial<Record<HistoryMultiple, FairRatio>> = {};
  for (const m of FAIR_MULTIPLES) {
    const model = models[m];
    const fair = model ? fairMultiple(model, inputs) : null;
    const actual = own.values.get(MULTIPLE_METRIC_KEYS[m]) ?? null;
    const positive = actual !== null && actual > 0 ? actual : null;
    // A fair P/E for a company without earnings is a number about nothing —
    // the reason Simply Wall St reads a loss-maker by its P/S.
    if (m === 'pe' && positive === null) continue;
    if (model && fair !== null) out[m] = { fair, actual: positive, r2: model.r2, n: model.n, inputs };
  }
  return out;
}

/** A stock's inputs and multiples from its newest stored payload, in the universe's shape. */
async function ownRow(symbol: string): Promise<UniverseRow | null> {
  const [f, m] = await Promise.all([
    readFinancialsLax(symbol),
    latestSnapshotLax<ComputedMetrics>(symbol, 'metrics'),
  ]);
  if (!f) return null;
  const values = new Map<string, number>();
  const put = (k: string, v: number | null | undefined) => { if (typeof v === 'number' && Number.isFinite(v)) values.set(k, v); };
  put(FAIR_INPUT_KEYS.revenueGrowth, f.revenueGrowth);
  put(FAIR_INPUT_KEYS.operatingMargin, f.operatingMargin);
  put(FAIR_INPUT_KEYS.grossProfit, f.grossProfit);
  put(FAIR_INPUT_KEYS.revenue, f.revenue);
  put(FAIR_INPUT_KEYS.beta, f.beta);
  put(MULTIPLE_METRIC_KEYS.pe, m?.ratios?.pe);
  put(MULTIPLE_METRIC_KEYS.ps, m?.evMultiples?.priceToSales);
  return { symbol: symbol.toUpperCase(), sector: f.sector, values };
}
