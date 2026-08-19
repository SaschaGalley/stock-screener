/**
 * The metric catalogue: which series exist, derived from the zod schemas.
 *
 * Nothing here lists field names. Each domain points at a schema in
 * `src/types.ts` and the walker produces its leaves, so the set of chartable
 * metrics is a consequence of the type definitions rather than a copy of them.
 * Adding a valuation model to `AnalysisResultSchema` adds its outputs to the
 * catalogue on the next boot.
 *
 * Metric keys are `<domain>.<dotted path>`, e.g. `metrics.composite.primary.median`.
 */

import { z } from 'zod';
import {
  AnalysisResultSchema,
  EarningsEstimateSchema,
  EarningsSurpriseSchema,
  LLMAnalysisSchema,
  MacroContextSchema,
  MarketSignalsSchema,
  SectorMediansSchema,
  StockFinancialsSchema,
  TechnicalSignalsSchema,
} from '../types.js';
import { logger } from '../utils/logger.js';
import { query } from './client.js';
import { KeyedArray, LeafDef, fieldsOf, leavesOf } from './walk.js';

// ── Domains ──────────────────────────────────────────────────────────────────

/**
 * The 19 valuation models, expressed as "the analysis result minus everything
 * that is not a model". An omit list rather than a pick list on purpose: a new
 * model added to `AnalysisResultSchema` joins the catalogue by itself, whereas
 * a pick list would silently leave it out.
 */
const ModelResultsSchema = AnalysisResultSchema.omit({
  symbol: true, timestamp: true, provider: true, searchProvider: true,
  financials: true, sectorMedians: true, marketSignals: true,
  llmAnalysis: true, news: true, perplexity: true,
});

/** Per-symbol market signals. Macro is global and handled as its own domain. */
const SymbolSignalsSchema = MarketSignalsSchema.omit({ macro: true });

/**
 * FRED's two rates, declared here because `data/fred.ts` models them as a plain
 * interface. The catalogue is where a value becomes a series, so this is the
 * right place for the one schema the domain layer never needed.
 */
const MarketRatesSchema = z.object({
  riskFreeRate: z.number().describe('10-year Treasury yield (FRED DGS10) as a decimal'),
  aaaBondYield: z.number().describe("Moody's Aaa corporate bond yield (FRED DAAA) as a decimal"),
});

/**
 * Everything that is true of the market rather than of one stock. The file
 * cache stored this block inside every symbol's market-signals payload, so a
 * nightly run wrote the same VIX reading 35 times.
 */
const GlobalSchema = MacroContextSchema.merge(MarketRatesSchema);

/**
 * Arrays whose elements are addressed by a value from a closed set, not by
 * position — the only two in the codebase. Everything else that looks like an
 * array is a fiscal series and goes to `fundamental_periods`.
 */
const KEYED_ARRAYS: Record<string, readonly KeyedArray[]> = {
  signals: [
    { path: 'revisions.perPeriod', keyField: 'period', keys: ['0q', '+1q', '0y', '+1y'] },
  ],
  metrics: [
    {
      path: 'peerMultiples.byMultiple',
      keyField: 'metric',
      keys: ['pe', 'evEbitda', 'evRevenue', 'priceFCF', 'priceSales', 'pb'],
    },
  ],
};

interface DomainSpec {
  domain:  string;
  schema:  z.ZodTypeAny;
  /** Series that only move when a new report lands. Informational for the UI. */
  cadence: 'daily' | 'quarterly' | 'annual';
}

const DOMAINS: readonly DomainSpec[] = [
  { domain: 'financials', schema: StockFinancialsSchema,  cadence: 'daily' },
  { domain: 'metrics',    schema: ModelResultsSchema,     cadence: 'daily' },
  { domain: 'signals',    schema: SymbolSignalsSchema,    cadence: 'daily' },
  { domain: 'signals_agg',schema: TechnicalSignalsSchema, cadence: 'daily' },
  { domain: 'peers',      schema: SectorMediansSchema,    cadence: 'daily' },
  { domain: 'verdict',    schema: LLMAnalysisSchema,      cadence: 'daily' },
  { domain: 'macro',      schema: GlobalSchema,           cadence: 'daily' },
];

/** Keyed-array config for one domain, in the form `readPath` expects. */
export function keyedArraysFor(domain: string): readonly KeyedArray[] {
  return KEYED_ARRAYS[domain] ?? [];
}

// ── Fiscal-period metrics ────────────────────────────────────────────────────
// These come out of arrays, so the walker skips them; their element schemas
// still supply the field set and the descriptions.

/**
 * Element schemas whose fields become fiscal metrics, minus the field that
 * identifies the period itself (that becomes `period_end`, not a value).
 */
const FISCAL_ELEMENTS: readonly { schema: z.ZodTypeAny; skip: readonly string[] }[] = [
  { schema: EarningsSurpriseSchema, skip: ['quarter'] },
  { schema: EarningsEstimateSchema, skip: ['period', 'endDate'] },
];

function fiscalLeaves(): LeafDef[] {
  const seen = new Map<string, LeafDef>();
  const add = (leaf: LeafDef) => { if (!seen.has(leaf.path)) seen.set(leaf.path, leaf); };

  // fundamentalsHistory is one {year, value} array per headline metric, so the
  // metric names are the keys of the wrapper object.
  for (const [name] of fieldsOf(StockFinancialsSchema.shape.fundamentalsHistory)) {
    add({ path: name, kind: 'number', unit: 'currency', description: `Reported ${name} for the fiscal period` });
  }
  // quarterlyRevenues carries the same meaning under its own array.
  add({ path: 'revenue', kind: 'number', unit: 'currency', description: 'Total revenue for the fiscal period' });

  for (const source of FISCAL_ELEMENTS) {
    for (const [name, child] of fieldsOf(source.schema)) {
      if (source.skip.includes(name)) continue;
      for (const leaf of leavesOf(z.object({ [name]: child }))) add(leaf);
    }
  }
  return [...seen.values()];
}

// ── Catalogue assembly ───────────────────────────────────────────────────────

export interface MetricDef {
  key:         string;
  domain:      string;
  valueKind:   LeafDef['kind'];
  label:       string;
  unit:        string | null;
  description: string | null;
  cadence:     'daily' | 'quarterly' | 'annual';
}

/** A readable label from a dotted path: `composite.primary.median` → "Composite › Primary › Median". */
function labelFor(path: string): string {
  return path
    .split('.')
    .map((s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()))
    .join(' › ');
}

/** Every metric this build knows about. Pure — no database access. */
export function buildCatalog(): MetricDef[] {
  const out: MetricDef[] = [];

  for (const spec of DOMAINS) {
    for (const leaf of leavesOf(spec.schema, { keyedArrays: keyedArraysFor(spec.domain) })) {
      out.push({
        key:         `${spec.domain}.${leaf.path}`,
        domain:      spec.domain,
        valueKind:   leaf.kind,
        label:       labelFor(leaf.path),
        unit:        leaf.unit,
        description: leaf.description,
        cadence:     spec.cadence,
      });
    }
  }

  for (const leaf of fiscalLeaves()) {
    out.push({
      key:         `fundamentals.${leaf.path}`,
      domain:      'fundamentals',
      valueKind:   'number',
      label:       labelFor(leaf.path),
      unit:        leaf.unit,
      description: leaf.description,
      cadence:     'quarterly',
    });
  }

  return out;
}

// ── Persistence + id cache ───────────────────────────────────────────────────

let idByKey: Map<string, number> | null = null;

/**
 * Write the catalogue and load the key → id map.
 *
 * Upsert rather than replace: metric ids are foreign keys in `observations`, so
 * a metric that disappears from the schemas keeps its row (and its history)
 * instead of cascading years of data away. Labels and descriptions are
 * refreshed, since those are just presentation.
 */
export async function syncCatalog(): Promise<Map<string, number>> {
  const defs = buildCatalog();

  // Two statements rather than one upsert, and the reason is the id sequence.
  //
  // `metrics.id` is a smallserial, capped at 32767, and `ON CONFLICT DO UPDATE`
  // calls nextval() for every row it considers — not just the ones it inserts.
  // Upserting all 421 metrics on each boot therefore spent 421 ids per restart
  // whether or not anything had changed, and around the seventy-seventh the
  // sequence ran out and the process refused to start. Inserting only what is
  // missing spends an id only when there is genuinely a new metric.
  //
  // Still one round trip each, on unnested arrays; 300-odd single statements
  // would make boot noticeably slower for no benefit.
  const columns = [
    defs.map((d) => d.key),
    defs.map((d) => d.domain),
    defs.map((d) => d.valueKind),
    defs.map((d) => d.label),
    defs.map((d) => d.unit),
    defs.map((d) => d.description),
    defs.map((d) => d.cadence),
  ];

  await query(
    `INSERT INTO metrics (key, domain, value_kind, label, unit, description, cadence)
     SELECT t.* FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
     ) AS t(key, domain, value_kind, label, unit, description, cadence)
     WHERE NOT EXISTS (SELECT 1 FROM metrics m WHERE m.key = t.key)`,
    columns,
  );

  // Descriptions, labels and units are presentation and do change between
  // versions, so existing rows are still brought up to date — by key, which
  // touches no sequence.
  await query(
    `UPDATE metrics m SET
       domain      = t.domain,
       value_kind  = t.value_kind,
       label       = t.label,
       unit        = t.unit,
       description = t.description,
       cadence     = t.cadence
     FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
     ) AS t(key, domain, value_kind, label, unit, description, cadence)
     WHERE m.key = t.key
       AND (m.domain, m.value_kind, m.label, m.unit, m.description, m.cadence)
           IS DISTINCT FROM
           (t.domain, t.value_kind, t.label, t.unit, t.description, t.cadence)`,
    columns,
  );

  const rows = (await query<{ id: number; key: string }>('SELECT id, key FROM metrics')).rows;
  idByKey = new Map(rows.map((r) => [r.key, r.id]));
  logger.debug(`Metric catalogue: ${defs.length} defined, ${idByKey.size} stored`);
  return idByKey;
}

/** Metric id for a key, or null when the catalogue has not been synced. */
export function metricId(key: string): number | null {
  return idByKey?.get(key) ?? null;
}

/** The loaded map, syncing on first use. */
export async function metricIds(): Promise<Map<string, number>> {
  return idByKey ?? syncCatalog();
}
