/**
 * Turning a zod schema into a list of metrics, generically.
 *
 * This is the piece that replaces the hand-written 12-field `HistoryPoint`.
 * Every numeric, boolean and enum leaf of a schema becomes a metric with a
 * dotted key; a new field in `src/types.ts` is therefore historised the moment
 * it is added, and nobody has to remember to extend a parallel list.
 *
 * Deliberately NOT captured here:
 *   - free-text strings (company descriptions, assumption prose) — they are not
 *     a series, and the ones that matter live in `documents`
 *   - arrays of objects — either a fiscal series (routed to
 *     `fundamental_periods`) or a detail list whose aggregate is already a leaf.
 *     The two closed-set exceptions are declared per call as `keyedArrays`.
 */

import { z } from 'zod';

export type LeafKind = 'number' | 'boolean' | 'enum';

export interface LeafDef {
  /** Dotted path relative to the schema root, e.g. `composite.primary.median`. */
  path:        string;
  kind:        LeafKind;
  description: string | null;
  /** Rendering hint for the UI; inferred from the name and description. */
  unit:        string | null;
}

/**
 * An array that behaves like a record: its elements are distinguished by a
 * field drawn from a closed set, so each (key, field) pair is a stable metric.
 * `revisions.perPeriod[period='0q'].netRevision30d` is a real series; the
 * position of that element in the array is not.
 */
export interface KeyedArray {
  path:     string;
  keyField: string;
  keys:     readonly string[];
}

export interface WalkOptions {
  keyedArrays?: readonly KeyedArray[];
}

// ── zod introspection ────────────────────────────────────────────────────────
// zod v4 keeps its type tag on `_def.type` (a lowercase string) and wraps
// modifiers (optional, nullable, default, catch, pipe) around the inner type.
// Unwrapping is the only part of this file that depends on zod internals — and
// this file is the only place in the codebase that touches them at all.

interface ZodDefLike {
  type?:      string;
  /** optional / nullable / default / catch / readonly wrappers. */
  innerType?: z.ZodTypeAny;
  /** The source side of a pipe — what `.transform()` produces in v4. */
  in?:        z.ZodTypeAny;
  /** Array element type. */
  element?:   z.ZodTypeAny;
  /** Object fields. A plain object in v4; it was a thunk in v3. */
  shape?:     Record<string, z.ZodTypeAny>;
}

const WRAPPER_TYPES = new Set([
  'optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional',
]);

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def ?? {};
}

/** The schema one wrapper layer in, or undefined when this isn't a wrapper. */
function innerOf(def: ZodDefLike): z.ZodTypeAny | undefined {
  if (def.type === 'pipe') return def.in;
  return def.type && WRAPPER_TYPES.has(def.type) ? def.innerType : undefined;
}

/** Strip optional/nullable/default/catch/pipe wrappers down to the real type. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema;
  for (;;) {
    const inner = innerOf(defOf(cur));
    if (!inner) return cur;
    cur = inner;
  }
}

/** The `.describe()` text, looking through wrappers to the innermost one set. */
function describeOf(schema: z.ZodTypeAny): string | null {
  let cur: z.ZodTypeAny | undefined = schema;
  while (cur) {
    if (cur.description) return cur.description;
    cur = innerOf(defOf(cur));
  }
  return null;
}

/** Field names of a zod object, in declaration order. */
export function fieldsOf(schema: z.ZodTypeAny): [string, z.ZodTypeAny][] {
  return Object.entries(defOf(unwrap(schema)).shape ?? {});
}

// ── Unit inference ───────────────────────────────────────────────────────────
// A rendering hint, not a contract. Wrong guesses cost a formatting nicety;
// the value itself is always stored raw.

const CURRENCY_HINTS = [
  'price', 'value', 'cap', 'revenue', 'income', 'profit', 'cash', 'debt',
  'assets', 'liabilities', 'equity', 'ebit', 'capex', 'target', 'fairvalue',
  'earnings', 'dividend', 'expense', 'sga', 'ppe', 'receivables', 'sma', 'ema',
  'bollinger', 'atr',
];

/** Statistics whose unit is whatever they summarise, not the word itself. */
const INHERITS_UNIT = new Set(['median', 'mean', 'p25', 'p75', 'min', 'max']);

/**
 * Enclosing paths under which such a statistic is a price per share. Kept apart
 * from CURRENCY_HINTS because these match the whole path: putting 'composite'
 * in the leaf list would also make `composite.confidence` a currency.
 */
const CURRENCY_CONTEXTS = ['composite', 'fairvalue', 'fairprice', 'target', 'price'];

function inferUnit(path: string, kind: LeafKind, description: string | null): string | null {
  if (kind !== 'number') return null;
  const full = path.toLowerCase();
  const leaf = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const desc = (description ?? '').toLowerCase();

  // `composite.primary.median` is a price; `median` on its own says nothing.
  // Fall back to the enclosing path for these.
  if (INHERITS_UNIT.has(leaf)) {
    return CURRENCY_CONTEXTS.some((h) => full.includes(h)) ? 'currency' : null;
  }

  // `pct` prefix as well as suffix: `pctPrimaryUndervalued` is a fraction, and
  // without this it matches the 'value' currency hint inside "undervalued".
  // `percent` anywhere, so `bollingerPercentB` doesn't read as a price.
  if (leaf.startsWith('pct') || leaf.endsWith('pct') || leaf.includes('percent')) return 'pct';
  // Any `xToY` name is a quotient — debtToEquity, evToEbitda, priceToSales.
  if (/^[a-z0-9]+to[a-z0-9]+$/.test(leaf)) return 'ratio';
  if (desc.includes('(decimal') || desc.includes('decimal,')) return 'pct';
  if (leaf.includes('rate') || leaf.includes('yield') || leaf.includes('margin')
    || leaf.includes('growth') || leaf.includes('return')) return 'pct';
  if (leaf === 'score' || leaf.endsWith('score')) return 'score';
  if (leaf.includes('count') || leaf.startsWith('shares') || leaf.includes('employees')
    || leaf.includes('years') || leaf.includes('analyst')) return 'count';
  if (leaf.includes('ratio') || leaf === 'pe' || leaf === 'peg' || leaf === 'pb'
    || leaf.startsWith('evto') || leaf.startsWith('priceto') || leaf.includes('beta')) return 'ratio';
  if (CURRENCY_HINTS.some((h) => leaf.includes(h))) return 'currency';
  return null;
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Every chartable leaf of a schema, depth-first, in declaration order. */
export function leavesOf(schema: z.ZodTypeAny, opts: WalkOptions = {}): LeafDef[] {
  const out: LeafDef[] = [];
  const keyed = new Map((opts.keyedArrays ?? []).map((k) => [k.path, k]));

  const emit = (path: string, kind: LeafKind, description: string | null) => {
    out.push({ path, kind, description, unit: inferUnit(path, kind, description) });
  };

  const visit = (node: z.ZodTypeAny, path: string): void => {
    const description = describeOf(node);
    const inner = unwrap(node);
    const def = defOf(inner);

    switch (def.type) {
      case 'object': {
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          visit(child, path ? `${path}.${key}` : key);
        }
        return;
      }
      case 'array': {
        const spec = keyed.get(path);
        if (!spec || !def.element) return;   // unkeyed arrays are not a metric
        for (const key of spec.keys) {
          for (const [field, child] of fieldsOf(def.element)) {
            if (field === spec.keyField) continue;
            visit(child, `${path}.${key}.${field}`);
          }
        }
        return;
      }
      case 'number':  emit(path, 'number',  description); return;
      case 'boolean': emit(path, 'boolean', description); return;
      case 'enum':    emit(path, 'enum',    description); return;
      default: return;   // strings, arrays of scalars, unions, anything else
    }
  };

  visit(schema, '');
  return out;
}

// ── Reading values back out ──────────────────────────────────────────────────

/**
 * Resolve a dotted path against a runtime value.
 *
 * Understands the keyed-array segment produced above: when the current node is
 * an array, the next segment is matched against the declared key field rather
 * than used as an index.
 */
export function readPath(
  root: unknown,
  path: string,
  keyedArrays: readonly KeyedArray[] = [],
): unknown {
  const segments = path.split('.');
  let cur: unknown = root;
  let walked = '';

  for (let i = 0; i < segments.length; i++) {
    if (cur === null || cur === undefined) return null;
    const segment = segments[i];

    if (Array.isArray(cur)) {
      const spec = keyedArrays.find((k) => k.path === walked);
      if (!spec) return null;
      cur = cur.find(
        (el) => el && typeof el === 'object'
          && (el as Record<string, unknown>)[spec.keyField] === segment,
      ) ?? null;
      walked = `${walked}.${segment}`;
      continue;
    }

    if (typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[segment];
    walked = walked ? `${walked}.${segment}` : segment;
  }
  return cur ?? null;
}

/** A leaf value coerced to the two columns `observations` stores. */
export interface ObservedValue {
  value:     number | null;
  valueText: string | null;
}

/**
 * Coerce a raw leaf to storage form. Booleans become 1/0 so a Piotroski signal
 * charts on the same axis as everything else; enums keep their label and also
 * get no numeric value.
 */
export function coerce(raw: unknown, kind: LeafKind): ObservedValue | null {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { value: raw, valueText: null }
        : null;
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw ? 1 : 0, valueText: null } : null;
    case 'enum':
      return typeof raw === 'string' ? { value: null, valueText: raw } : null;
  }
}
