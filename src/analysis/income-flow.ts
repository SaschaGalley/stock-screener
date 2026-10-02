/**
 * Where each unit of revenue goes, from the income statement as filed.
 *
 * Revenue splits into the cost of making what was sold and gross profit; gross
 * profit into research, selling and administration, other operating costs and
 * operating income; operating income, with whatever the company earned or paid
 * outside its operations, into tax and net income. Read off Yahoo's statement
 * rows as archived (`yahoo_statements`), in the reporting currency.
 *
 * A loss does not flow: a company spending more than its gross profit has no
 * operating income to pass on, so the gap is drawn as what it is — a shortfall
 * funded from elsewhere — rather than as a negative stream, which a flow
 * diagram cannot draw.
 *
 * Pure and dependency-free so the web app can import the types.
 */

export interface IncomeFlow {
  /** Period end of the newest row, YYYY-MM-DD. */
  periodEnd:       string;
  /** "annual" — the newest fiscal year; "ttm" — the last four quarters summed. */
  basis:           'annual' | 'ttm';
  revenue:         number;
  costOfRevenue:   number;
  grossProfit:     number;
  research:        number;
  sga:             number;
  /** Operating costs that are neither: depreciation shown apart, restructuring, other. */
  otherOperating:  number;
  operatingIncome: number;
  /** Pre-tax income less operating income: interest, investments, one-offs. */
  nonOperating:    number;
  pretaxIncome:    number;
  tax:             number;
  netIncome:       number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const n = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One statement row as a flow, or null when it lacks revenue or the operating line. */
export function flowFromRow(row: any, basis: IncomeFlow['basis']): IncomeFlow | null {
  const revenue = n(row?.totalRevenue) ?? n(row?.operatingRevenue);
  if (revenue === null || revenue <= 0) return null;
  const cost = n(row.costOfRevenue) ?? n(row.reconciledCostOfRevenue) ?? (n(row.grossProfit) !== null ? revenue - row.grossProfit : null);
  const operatingIncome = n(row.operatingIncome) ?? n(row.totalOperatingIncomeAsReported);
  if (cost === null || operatingIncome === null) return null;
  const grossProfit = revenue - cost;
  const research = Math.max(0, n(row.researchAndDevelopment) ?? 0);
  const sga = Math.max(0, n(row.sellingGeneralAndAdministration) ?? 0);
  // Whatever of the gap between gross profit and operating income the named
  // lines do not explain.
  const otherOperating = grossProfit - operatingIncome - research - sga;
  const pretaxIncome = n(row.pretaxIncome) ?? operatingIncome;
  const tax = n(row.taxProvision) ?? 0;
  const netIncome = n(row.netIncomeCommonStockholders) ?? n(row.netIncome) ?? pretaxIncome - tax;
  const date = typeof row.date === 'string' ? row.date.slice(0, 10) : row.date instanceof Date ? row.date.toISOString().slice(0, 10) : '';
  return {
    periodEnd: date, basis, revenue, costOfRevenue: cost, grossProfit, research, sga,
    otherOperating, operatingIncome, nonOperating: pretaxIncome - operatingIncome, pretaxIncome, tax, netIncome,
  };
}

/** The last four quarters summed into one flow — only when they are four consecutive quarters. */
export function ttmFlow(quarters: any[]): IncomeFlow | null {
  const rows = [...quarters]
    .filter((q) => n(q?.totalRevenue) !== null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-4);
  if (rows.length < 4) return null;
  const first = Date.parse(String(rows[0].date)), last = Date.parse(String(rows[3].date));
  // Four quarters span about nine months from the first end to the last.
  if (!Number.isFinite(first) || !Number.isFinite(last) || Math.abs((last - first) / 86_400_000 - 273) > 40) return null;
  const keys = [
    'totalRevenue', 'costOfRevenue', 'grossProfit', 'researchAndDevelopment', 'sellingGeneralAndAdministration',
    'operatingIncome', 'pretaxIncome', 'taxProvision', 'netIncomeCommonStockholders', 'netIncome',
  ];
  const sum: Record<string, unknown> = { date: rows[3].date };
  for (const k of keys) {
    const vs = rows.map((r) => n(r[k]));
    sum[k] = vs.every((v) => v !== null) ? vs.reduce((a, b) => a! + b!, 0) : null;
  }
  return flowFromRow(sum, 'ttm');
}

export interface FlowLink { source: string; target: string; value: number; kind: 'income' | 'cost' | 'gap' }

/**
 * The flow as links between named stages, every value positive. A negative
 * stage is redrawn as what it is rather than as a negative stream, which a
 * flow diagram cannot draw: an operating loss is a shortfall feeding the
 * costs it could not cover; non-operating income that covers it flows into
 * that shortfall first; a tax credit adds to net income instead of leaving it.
 * Ondas is the case that needs all three — an operating loss of 225 million,
 * 360 million from revaluations, a tax credit, and a net profit.
 */
export function flowLinks(f: IncomeFlow): FlowLink[] {
  const links: FlowLink[] = [];
  const add = (source: string, target: string, value: number, kind: FlowLink['kind']) => {
    if (value > 0) links.push({ source, target, value, kind });
  };
  const OP = 'Operatives Ergebnis', LOSS = 'Operativer Verlust', OTHER = 'Finanz- & Sonstiges';
  const PRETAX = 'Ergebnis vor Steuern', NET = 'Nettoergebnis';

  add('Umsatz', 'Herstellkosten', f.costOfRevenue, 'cost');
  add('Umsatz', 'Bruttogewinn', f.grossProfit, 'income');
  add('Bruttogewinn', 'Forschung & Entwicklung', f.research, 'cost');
  add('Bruttogewinn', 'Vertrieb & Verwaltung', f.sga, 'cost');
  add('Bruttogewinn', 'Sonstige Betriebskosten', f.otherOperating, 'cost');

  if (f.operatingIncome >= 0) add('Bruttogewinn', OP, f.operatingIncome, 'income');
  else add(LOSS, 'Bruttogewinn', -f.operatingIncome, 'gap');

  if (f.nonOperating >= 0) {
    // What the operating loss leaves uncovered is covered from here first.
    const cover = f.operatingIncome < 0 ? Math.min(f.nonOperating, -f.operatingIncome) : 0;
    add(OTHER, LOSS, cover, 'income');
    add(OTHER, PRETAX, f.nonOperating - cover, 'income');
    add(OP, PRETAX, f.operatingIncome, 'income');
  } else if (f.operatingIncome > 0) {
    add(OP, `${OTHER} (Aufwand)`, Math.min(f.operatingIncome, -f.nonOperating), 'cost');
    add(OP, PRETAX, f.pretaxIncome, 'income');
  }

  if (f.pretaxIncome > 0) {
    add(PRETAX, 'Steuern', f.tax, 'cost');
    add(PRETAX, NET, f.pretaxIncome - Math.max(0, f.tax), 'income');
    add('Steuergutschrift', NET, -f.tax, 'income');
  }
  return links;
}
