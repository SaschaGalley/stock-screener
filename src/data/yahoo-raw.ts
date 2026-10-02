/**
 * What a Yahoo refresh downloads, kept as downloaded.
 *
 * `yfinance.ts` turns Yahoo's answers into the payload the models read and
 * throws the rest away: a year of daily bars became technical indicators, a
 * decade of analyst actions became one month's rating counts, two years of
 * insider trades became six totals, and every statement line the models do
 * not use was dropped. This is the rest — the rows, in Yahoo's own units and
 * with its own dates — mapped into the shapes `db/history-store.ts` appends.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PriceBarRow {
  day:      string;
  open:     number | null;
  high:     number | null;
  low:      number | null;
  /** Split-adjusted close — Yahoo's `close`. */
  close:    number;
  /** Split- and dividend-adjusted — Yahoo's `adjclose`. */
  adjClose: number | null;
  volume:   number | null;
}

export interface PriceEventRow {
  day:   string;
  kind:  'split' | 'dividend';
  value: number;
}

export interface AnalystActionRow {
  gradedAt:          string;
  firm:              string;
  action:            string | null;
  fromGrade:         string | null;
  toGrade:           string | null;
  priceTargetAction: string | null;
  priceTarget:       number | null;
  priorPriceTarget:  number | null;
}

export interface InsiderTransactionRow {
  tradedOn:    string | null;
  filer:       string | null;
  relation:    string | null;
  description: string | null;
  shares:      number | null;
  value:       number | null;
  ownership:   string | null;
}

export interface YahooRaw {
  priceBars:           PriceBarRow[];
  priceEvents:         PriceEventRow[];
  /** fundamentalsTimeSeries as returned: reporting currency, real period ends. */
  statements: {
    annual:    { balanceSheet: unknown[]; financials: unknown[]; cashFlow: unknown[] };
    quarterly: { balanceSheet: unknown[]; financials: unknown[]; cashFlow: unknown[] };
  };
  /** The estimate and rating modules, in full — they change most days. */
  analyst:             Record<string, unknown>;
  /** Who holds the stock — changes with each quarterly filing. */
  holders:             Record<string, unknown>;
  analystActions:      AnalystActionRow[];
  insiderTransactions: InsiderTransactionRow[];
}

const num = (v: any): number | null => {
  const x = typeof v === 'object' && v !== null && 'raw' in v ? v.raw : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const text = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoDay = (v: any): string | null => {
  const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};
const isoTime = (v: any): string | null => {
  const d = v instanceof Date ? v : typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** A chart response's quotes as rows; a bar without a close is not a bar. */
export function priceBarsFrom(quotes: any[]): PriceBarRow[] {
  return (quotes ?? []).flatMap((q) => {
    const day = isoDay(q?.date);
    const close = num(q?.close) ?? num(q?.adjclose);
    if (!day || close === null || close <= 0) return [];
    return [{
      day, close,
      open: num(q.open), high: num(q.high), low: num(q.low),
      adjClose: num(q.adjclose), volume: num(q.volume),
    }];
  });
}

/** A chart response's `events` — splits as new shares per old, dividends per share. */
export function priceEventsFrom(events: any): PriceEventRow[] {
  const list = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
  const splits = list(events?.splits).flatMap((s) => {
    const day = isoDay(s?.date);
    const ratio = Number(s?.numerator) / Number(s?.denominator);
    return day && Number.isFinite(ratio) && ratio > 0 ? [{ day, kind: 'split' as const, value: ratio }] : [];
  });
  const dividends = list(events?.dividends).flatMap((d) => {
    const day = isoDay(d?.date);
    const amount = num(d?.amount);
    return day && amount !== null && amount > 0 ? [{ day, kind: 'dividend' as const, value: amount }] : [];
  });
  return [...splits, ...dividends];
}

export function analystActionsFrom(module: any): AnalystActionRow[] {
  return (module?.history ?? []).flatMap((h: any) => {
    const gradedAt = isoTime(h?.epochGradeDate);
    const firm = text(h?.firm);
    if (!gradedAt || !firm) return [];
    return [{
      gradedAt, firm,
      action: text(h.action), fromGrade: text(h.fromGrade), toGrade: text(h.toGrade),
      priceTargetAction: text(h.priceTargetAction),
      priceTarget: num(h.currentPriceTarget), priorPriceTarget: num(h.priorPriceTarget),
    }];
  });
}

export function insiderTransactionsFrom(module: any): InsiderTransactionRow[] {
  return (module?.transactions ?? []).map((t: any) => ({
    tradedOn:    isoDay(t?.startDate),
    filer:       text(t?.filerName),
    relation:    text(t?.filerRelation),
    description: text(t?.transactionText),
    shares:      num(t?.shares),
    value:       num(t?.value),
    ownership:   text(t?.ownership),
  }));
}

/** The named modules out of a quoteSummary answer, absent ones left out. */
export function pickModules(summary: any, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.flatMap((n) => (summary?.[n] != null ? [[n, summary[n]]] : [])));
}
