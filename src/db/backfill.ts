/**
 * One-shot import of the old file cache.
 *
 * Two different things are being rescued here, and the distinction matters:
 *
 *   - `history.json` is REAL PAST. Those points were recorded on the days they
 *     carry and cannot be reconstructed from anything else. They are imported
 *     at their original timestamps.
 *   - Everything else is the CURRENT STATE — one overwritten snapshot per kind.
 *     It is imported at the file's mtime, which is when it was actually true.
 *     The 19 valuation models are re-run over the stored financials while we
 *     are at it, so the series that were never persisted at all start with a
 *     value instead of a gap.
 *
 * Idempotent: snapshots and documents deduplicate on content hash, observations
 * upsert on (symbol, metric, timestamp). Running it twice changes nothing.
 *
 *   pnpm run backfill [--data-dir .cache] [--dry-run]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { computeAllMetrics } from '../analysis/computeMetrics.js';
import { deriveTechnicalSignals } from '../analysis/signals.js';
import type { MarketSignals, NewsItem, SectorMedians, StockFinancials } from '../types.js';
import type { PerplexityContext } from '../data/perplexity.js';
import type { DistillBundle } from '../data/distill.js';
import type { DistillEntityRef } from '../data/distill-entities.js';
import { closePool, waitForDatabase } from './client.js';
import { migrate } from './migrate.js';
import { syncCatalog } from './catalog.js';
import { resolveDataRoot } from '../files.js';
import {
  CachedAnalysisEntry, ObservationSource,
  recordFundamentals, recordMacro, recordObservations,
  saveDocument, saveSnapshot, searchTraceText, upsertSymbol, verdictText,
  FINANCIALS_VERSION, MARKET_SIGNALS_VERSION,
  NEWS_VERSION, SECTOR_MEDIANS_VERSION,
} from './store.js';
import { writeDistillEntity, writeSubmissions, writeSettingsJson, SubmissionsMeta } from './admin.js';

/** The old cache envelope: `{ v, ts, data }`. */
interface Envelope<T> { v: number | string; ts: number; data: T }

function readEnvelope<T>(file: string): Envelope<T> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as Envelope<T>; }
  catch (e) {
    logger.warn(`Unreadable: ${file} (${(e as Error).message})`);
    return null;
  }
}

/** When the payload was last true: the envelope timestamp, else the mtime. */
function timeOf<T>(file: string, entry: Envelope<T> | null): Date {
  if (entry && typeof entry.ts === 'number' && Number.isFinite(entry.ts)) return new Date(entry.ts);
  try { return statSync(file).mtime; } catch { return new Date(); }
}

// ── The old HistoryPoint, and where each field now lives ─────────────────────
// The 12 hand-picked fields that were the entire history mechanism. Two of them
// (targetUpsidePct, compositeUpsidePct) were derived from the others and are
// not imported — they are recomputed against the current price wherever shown.

interface LegacyHistoryPoint {
  at: string;
  source: 'analysis' | 'data';
  price: number | null;
  marketCap: number | null;
  peRatio: number | null;
  targetMean: number | null;
  compositeFairValue: number | null;
  aiScore: number | null;
  recommendation: string | null;
  model: string | null;
}

const LEGACY_MAP: { field: keyof LegacyHistoryPoint; key: string }[] = [
  { field: 'price',              key: 'financials.price' },
  { field: 'marketCap',          key: 'financials.marketCap' },
  { field: 'peRatio',            key: 'financials.peRatio' },
  { field: 'targetMean',         key: 'financials.targetMeanPrice' },
  { field: 'compositeFairValue', key: 'metrics.composite.primary.median' },
  { field: 'aiScore',            key: 'verdict.score' },
  { field: 'recommendation',     key: 'verdict.recommendation' },
];

export interface BackfillStats {
  symbols: number; snapshots: number; documents: number;
  observations: number; historyPoints: number; filings: number;
}

async function importHistory(
  symbol: string, points: LegacyHistoryPoint[], ids: Map<string, number>, dryRun: boolean,
): Promise<number> {
  let written = 0;
  for (const point of points) {
    const at = new Date(point.at);
    if (Number.isNaN(at.getTime())) continue;

    // Built by hand rather than through the projector: the legacy shape is not
    // any of the catalogued domains, it is a flat record whose fields happen to
    // map onto seven of them.
    const rows: { metricId: number; value: number | null; valueText: string | null }[] = [];
    for (const { field, key } of LEGACY_MAP) {
      const id = ids.get(key);
      const raw = point[field];
      if (id === undefined || raw === null || raw === undefined) continue;
      if (typeof raw === 'number' && Number.isFinite(raw)) rows.push({ metricId: id, value: raw, valueText: null });
      else if (typeof raw === 'string') rows.push({ metricId: id, value: null, valueText: raw });
    }
    if (rows.length === 0) continue;
    written++;
    if (dryRun) continue;

    // Reuses the same upsert the live path uses, via a synthetic source that
    // the projector would produce — see recordObservations for the real route.
    await recordObservationRows(symbol, rows, at);
  }
  return written;
}

/** Direct row write, for the legacy import only. */
async function recordObservationRows(
  symbol: string,
  rows: { metricId: number; value: number | null; valueText: string | null }[],
  at: Date,
): Promise<void> {
  const { query } = await import('./client.js');
  const id = await upsertSymbol(symbol);
  await query(
    `INSERT INTO observations (symbol_id, metric_id, observed_at, value, value_text)
     SELECT $1, m, $3, v, t
       FROM unnest($2::smallint[], $4::double precision[], $5::text[]) AS u(m, v, t)
     ON CONFLICT (symbol_id, metric_id, observed_at) DO NOTHING`,
    [id, rows.map((r) => r.metricId), at, rows.map((r) => r.value), rows.map((r) => r.valueText)],
  );
}

async function importSymbol(
  root: string, symbol: string, ids: Map<string, number>, dryRun: boolean, stats: BackfillStats,
): Promise<void> {
  const dir = join(root, symbol);
  const fFile = join(dir, 'financials.json');
  const fEntry = readEnvelope<StockFinancials>(fFile);
  if (!fEntry?.data) {
    logger.debug(`${symbol}: no financials — skipping`);
    return;
  }
  const financials = fEntry.data;
  const at = timeOf(fFile, fEntry);
  stats.symbols++;

  if (!dryRun) {
    await upsertSymbol(symbol, {
      companyName: financials.companyName, sector: financials.sector,
      industry: financials.industry, isin: financials.isin, wkn: financials.wkn,
      website: financials.website, currency: financials.tradingCurrency ?? null,
    });
    await saveSnapshot(symbol, 'financials', Number(fEntry.v) || FINANCIALS_VERSION, financials);
  }
  stats.snapshots++;

  // ── The other overwritten payloads ─────────────────────────────────────────
  const msFile  = join(dir, 'market-signals.json');
  const msEntry = readEnvelope<MarketSignals>(msFile);
  const smEntry = readEnvelope<SectorMedians>(join(dir, 'sector-medians.json'));
  const newsEntry = readEnvelope<NewsItem[]>(join(dir, 'news.json'));

  if (!dryRun) {
    if (msEntry?.data)   await saveSnapshot(symbol, 'market_signals', Number(msEntry.v) || MARKET_SIGNALS_VERSION, msEntry.data);
    if (smEntry?.data)   await saveSnapshot(symbol, 'sector_medians', SECTOR_MEDIANS_VERSION, smEntry.data);
    if (newsEntry?.data) await saveSnapshot(symbol, 'news', Number(newsEntry.v) || NEWS_VERSION, newsEntry.data);
  }
  stats.snapshots += [msEntry, smEntry, newsEntry].filter((e) => e?.data).length;

  // ── The models that were never stored at all ───────────────────────────────
  // Peer medians come from the file when present; without them the composite
  // drops a contributor, which is exactly what the live path would also do.
  const metrics = (() => {
    try { return computeAllMetrics(financials, null, smEntry?.data ?? null); }
    catch (e) {
      logger.warn(`${symbol}: models could not be recomputed (${(e as Error).message})`);
      return null;
    }
  })();

  const sources: ObservationSource[] = [{ domain: 'financials', payload: financials }];
  if (metrics)       sources.push({ domain: 'metrics', payload: metrics });
  if (msEntry?.data) sources.push({ domain: 'signals', payload: msEntry.data });
  if (smEntry?.data) sources.push({ domain: 'peers',   payload: smEntry.data });
  if (msEntry?.data?.technicals) {
    sources.push({
      domain: 'signals_agg',
      payload: deriveTechnicalSignals(msEntry.data.technicals, financials.price),
    });
  }

  if (!dryRun) {
    stats.observations += await recordObservations(symbol, sources, at);
    await recordFundamentals(symbol, financials, at);
    if (metrics) await saveSnapshot(symbol, 'metrics', FINANCIALS_VERSION, metrics);
    if (msEntry?.data?.macro) await recordMacro(msEntry.data.macro, timeOf(msFile, msEntry));
  }

  // ── Text outputs ───────────────────────────────────────────────────────────
  const pplx = readEnvelope<PerplexityContext>(join(dir, 'perplexity.json'));
  if (pplx?.data?.synthesis && !dryRun) {
    await saveDocument({
      symbol, kind: 'perplexity', variant: pplx.data.model,
      content: pplx.data.synthesis, data: pplx.data, model: pplx.data.model,
    });
  }
  if (pplx?.data?.synthesis) stats.documents++;

  const distill = readEnvelope<DistillBundle>(join(dir, 'distill.json'));
  if (distill?.data && !dryRun) {
    await saveDocument({
      symbol, kind: 'distill',
      variant: distill.data.briefing?.briefingTypeId ?? '',
      content: distill.data.briefing?.body ?? '',
      data: distill.data,
      model: distill.data.briefing?.model ?? null,
      costUsd: distill.data.briefing?.costUsd ?? null,
    });
  }
  if (distill?.data) stats.documents++;

  // ── Stored verdicts ────────────────────────────────────────────────────────
  const analysesDir = join(dir, 'analyses');
  if (existsSync(analysesDir)) {
    for (const file of readdirSync(analysesDir).filter((f) => f.endsWith('.json'))) {
      const entry = readEnvelope<CachedAnalysisEntry>(join(analysesDir, file));
      const data = entry?.data;
      if (!data?.llmAnalysis || !data.flags) continue;
      stats.documents++;
      if (dryRun) continue;
      // The stored schema version travels with the row. Verdicts written under
      // an older one are kept — they are the deepest history there is — but
      // only current-version rows are offered back to the UI, so a v3 verdict
      // (prose where v4 onwards has bullet arrays) can never reach a component
      // that expects today's shape.
      const variant = data.hash ?? file.replace(/\.json$/, '');
      const schemaVer = Number(entry!.v) || 0;
      await saveDocument({
        symbol, kind: 'verdict', variant, schemaVer,
        content: verdictText(data.llmAnalysis), data, model: data.flags.model,
      });
      if (data.searches?.providers?.length) {
        await saveDocument({
          symbol, kind: 'search_trace', variant, schemaVer,
          content: searchTraceText(data.searches),
          data: data.searches, model: data.flags.model,
        });
      }
    }
  }

  // ── Mappings and the filing index ──────────────────────────────────────────
  const entity = readEnvelope<DistillEntityRef>(join(dir, 'distill-entity.json'));
  if (entity?.data?.id && !dryRun) await writeDistillEntity(symbol, entity.data);

  const subs = readEnvelope<SubmissionsMeta>(join(dir, 'submissions.json'));
  if (subs?.data?.filings?.length) {
    stats.filings += subs.data.filings.length;
    if (!dryRun) await writeSubmissions(symbol, subs.data);
  }

  // ── The real past ──────────────────────────────────────────────────────────
  const history = readEnvelope<LegacyHistoryPoint[]>(join(dir, 'history.json'));
  if (Array.isArray(history?.data)) {
    stats.historyPoints += await importHistory(symbol, history.data, ids, dryRun);
  }
}

export async function backfill(
  rawDir: string, opts: { dryRun?: boolean } = {},
): Promise<BackfillStats> {
  const dryRun = !!opts.dryRun;
  const root = resolveDataRoot(rawDir);
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);

  const ids = await syncCatalog();
  const stats: BackfillStats = {
    symbols: 0, snapshots: 0, documents: 0, observations: 0, historyPoints: 0, filings: 0,
  };

  const symbols = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'financials.json')))
    .map((d) => d.name)
    .sort();

  logger.info(`${dryRun ? 'Would import' : 'Importing'} ${symbols.length} symbol(s) from ${root}`);
  for (const symbol of symbols) {
    try {
      await importSymbol(root, symbol, ids, dryRun, stats);
      logger.debug(`${symbol} done`);
    } catch (e) {
      // One bad directory must not cost the other thirty-four their import.
      logger.error(`${symbol}: ${(e as Error).message}`);
    }
  }

  // Operational settings; job-runs.json is deliberately not imported — it is a
  // log of past runs, not data, and the new `runs` table starts clean.
  const appConfig = existsSync(join(root, 'app-config.json'))
    ? JSON.parse(readFileSync(join(root, 'app-config.json'), 'utf-8'))
    : null;
  if (appConfig && !dryRun) {
    await writeSettingsJson(appConfig);
    logger.info('Imported app-config.json into settings');
  }

  return stats;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('backfill.ts') || process.argv[1]?.endsWith('backfill.js');

if (isMain) {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--data-dir');
  const rawDir = dirFlag >= 0 ? args[dirFlag + 1] : (process.env.CACHE_DIR ?? getConfig().dataDir);
  const dryRun = args.includes('--dry-run');

  (async () => {
    await waitForDatabase();
    await migrate();
    const stats = await backfill(rawDir, { dryRun });
    logger.success(
      `${dryRun ? 'Dry run' : 'Backfill'} complete — `
      + `${stats.symbols} symbols, ${stats.snapshots} snapshots, ${stats.documents} documents, `
      + `${stats.observations} observations, ${stats.historyPoints} legacy history points, `
      + `${stats.filings} filings`,
    );
    await closePool();
  })().catch(async (e) => {
    logger.error(`Backfill failed: ${(e as Error).message}`);
    await closePool();
    process.exit(1);
  });
}
