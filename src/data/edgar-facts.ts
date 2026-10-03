/**
 * Company financials as they were known on any past day: the SEC's XBRL
 * company facts, reduced to the lines the models read.
 *
 * Every figure a US filer has tagged since 2009 is in one JSON document per
 * company (`/api/xbrl/companyfacts`), each with the period it covers and the
 * day it was filed. That second date is what makes a backtest honest: the
 * figures for a quarter exist from the day the 10-Q was filed, and a restated
 * figure from the day of the restatement — not from the end of the quarter,
 * which is when a database that only keeps "the" value would place it.
 *
 * Companies rename their tags: Apple reported `SalesRevenueNet` until 2018 and
 * `RevenueFromContractWithCustomerExcludingAssessedTax` since. So each line is
 * a list of tags in order of preference, merged per period (`FACT_LINES`).
 *
 * The full document is several megabytes per company; only the reduced lines
 * are kept, on disk under the data directory, so a second backtest reads
 * nothing from the SEC.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { logger } from '../utils/logger.js';
import { RateWindow } from '../utils/rate-window.js';

/** One reported figure: a duration (`start` set) or a point in time. */
export interface Fact {
  start: string | null;
  end:   string;
  val:   number;
  filed: string;
}

export type FactLines = Record<string, Fact[]>;

export interface CompanyFacts {
  cik:   string;
  name:  string;
  lines: FactLines;
}

/**
 * The lines, each a list of tags in order of preference: for any one period
 * the first tag that reports it wins. `dei:` marks the cover-page taxonomy.
 */
export const FACT_LINES: Record<string, string[]> = {
  // Flows (durations)
  revenue: [
    'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet',
    'SalesRevenueServicesNet', 'RevenuesNetOfInterestExpense',
  ],
  costOfRevenue:   ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
  grossProfit:     ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome:       ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'],
  pretaxIncome: [
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
  ],
  incomeTax:       ['IncomeTaxExpenseBenefit'],
  // The 2024 taxonomy moved much of it to `InterestExpenseOperating` — the banks, Allstate.
  interestExpense: ['InterestExpense', 'InterestExpenseDebt', 'InterestExpenseNonoperating', 'InterestExpenseOperating'],
  depreciation: [
    'DepreciationDepletionAndAmortization', 'DepreciationAndAmortization',
    'DepreciationAmortizationAndAccretionNet', 'Depreciation',
  ],
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  capex:          ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  stockComp:      ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  dividendsPaid:  ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  sga:            ['SellingGeneralAndAdministrativeExpense'],
  dilutedShares:  ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  // Stocks (instants)
  assets:             ['Assets'],
  liabilities:        ['Liabilities'],
  currentAssets:      ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  liabilitiesNoncurrent: ['LiabilitiesNoncurrent'],
  equity:             ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  minorityInterest:   ['MinorityInterest'],
  preferredEquity:    ['PreferredStockValue'],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash',
  ],
  shortInvestments:   ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  longTermDebt:       ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  currentDebt:        ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
  retainedEarnings:   ['RetainedEarningsAccumulatedDeficit'],
  receivables:        ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  ppe:                ['PropertyPlantAndEquipmentNet'],
  goodwill:           ['Goodwill'],
  intangibles:        ['IntangibleAssetsNetExcludingGoodwill'],
  investments:        ['EquityMethodInvestments', 'LongTermInvestments'],
  operatingLeases:    ['OperatingLeaseLiability'],
  sharesOutstanding:  ['dei:EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding'],
};

/** Periods reported this far apart are the same period, filed with a different day count. */
const SAME_DAY_TOLERANCE_MS = 3 * 86_400_000;

type RawFact = { start?: string; end: string; val: number; filed: string; form?: string };
type RawCompanyFacts = {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, RawFact[]> }>>;
};

/** Only annual and quarterly reports and their amendments; an 8-K's figures are a press release's. */
const FORMS = /^(10-K|10-Q|10-KT|10-QT|20-F|40-F)(\/A)?$/;

/**
 * One line from the raw document: every tag in the list, merged per period and
 * per filing, and every filing of a period kept.
 *
 * The preference between tags applies within one filing only: a 10-Q that
 * reports both `Revenues` and `SalesRevenueNet` for a quarter is read through
 * the first. Across filings it must not apply. A quarter of 2017 was filed in
 * November 2017 as `SalesRevenueNet` and again, as the comparative in a 2018
 * 10-Q, under the tag that replaced it; preferring the newer tag for the whole
 * period dropped the original filing, and on every day in between the quarter
 * looked unreported — 110 companies vanished from the backtest in January 2018.
 */
export function extractLine(raw: RawCompanyFacts, tags: string[]): Fact[] {
  const byPeriod = new Map<string, Map<string, { rank: number; fact: Fact }>>();
  tags.forEach((tag, rank) => {
    const [taxonomy, name] = tag.startsWith('dei:') ? ['dei', tag.slice(4)] : ['us-gaap', tag];
    const units = raw.facts?.[taxonomy]?.[name]?.units;
    if (!units) return;
    for (const list of Object.values(units)) {
      for (const f of list) {
        if (typeof f.val !== 'number' || !Number.isFinite(f.val) || !f.end || !f.filed) continue;
        if (f.form && !FORMS.test(f.form)) continue;
        const key = `${f.start ?? ''}|${f.end}`;
        const byFiling = byPeriod.get(key) ?? new Map<string, { rank: number; fact: Fact }>();
        const held = byFiling.get(f.filed);
        if (!held || rank < held.rank) {
          byFiling.set(f.filed, { rank, fact: { start: f.start ?? null, end: f.end, val: f.val, filed: f.filed } });
        }
        byPeriod.set(key, byFiling);
      }
    }
  });
  // A period is reported again as the comparative of the next two filings,
  // usually unchanged. Only its first filing and the ones that changed it —
  // the restatements — are facts about what was known when.
  const out: Fact[] = [];
  for (const byFiling of byPeriod.values()) {
    const facts = [...byFiling.values()].map((x) => x.fact).sort((a, b) => a.filed.localeCompare(b.filed));
    let last: number | null = null;
    for (const f of facts) {
      if (f.val === last) continue;
      out.push(f);
      last = f.val;
    }
  }
  return out.sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed));
}

/**
 * The cache file's shape: facts as `[start, end, val, filed]` tuples, a third
 * of the objects' size. `v` changes when the reduction does, so a cache written
 * by an older one is fetched again rather than read.
 */
const PACK_VERSION = 4;
type PackedFacts = {
  v?: number; cik: string; name: string; fetchedAt: string;
  lines: Record<string, [string | null, string, number, string][]>;
};

function pack(c: CompanyFacts): PackedFacts {
  const lines: PackedFacts['lines'] = {};
  for (const [k, v] of Object.entries(c.lines)) lines[k] = v.map((f) => [f.start, f.end, f.val, f.filed]);
  return { v: PACK_VERSION, cik: c.cik, name: c.name, fetchedAt: new Date().toISOString(), lines };
}

function unpack(p: PackedFacts): CompanyFacts {
  const lines: FactLines = {};
  for (const [k, v] of Object.entries(p.lines)) lines[k] = v.map(([start, end, val, filed]) => ({ start, end, val, filed }));
  return { cik: p.cik, name: p.name, lines };
}

export function reduceCompanyFacts(raw: RawCompanyFacts): CompanyFacts {
  const lines: FactLines = {};
  for (const [line, tags] of Object.entries(FACT_LINES)) lines[line] = extractLine(raw, tags);
  return { cik: String(raw.cik).padStart(10, '0'), name: raw.entityName, lines };
}

// ── Point in time ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

/** Every period of a line as it was known on `asOf`: the newest filing of each period filed before that day. */
export function knownOn(facts: Fact[], asOf: string): Fact[] {
  const latest = new Map<string, Fact>();
  for (const f of facts) {
    if (f.filed >= asOf) continue;
    const key = `${f.start ?? ''}|${f.end}`;
    const held = latest.get(key);
    if (!held || f.filed > held.filed) latest.set(key, f);
  }
  return [...latest.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** The newest value of a point-in-time line (a balance sheet item) known on `asOf`, and its date. */
export function latestInstant(facts: Fact[], asOf: string): Fact | null {
  const known = knownOn(facts, asOf).filter((f) => f.start === null);
  return known.length ? known[known.length - 1] : null;
}

/** The value of a point-in-time line at (about) `end`, as known on `asOf`. */
export function instantAt(facts: Fact[], end: string, asOf: string, toleranceDays = 20): number | null {
  let best: Fact | null = null;
  for (const f of knownOn(facts, asOf)) {
    if (f.start !== null) continue;
    const gap = Math.abs(days(f.end, end));
    if (gap <= toleranceDays && (!best || gap < Math.abs(days(best.end, end)))) best = f;
  }
  return best?.val ?? null;
}

type Span = 'quarter' | 'half' | 'nine' | 'year';

function spanOf(f: Fact): Span | null {
  if (!f.start) return null;
  const d = days(f.start, f.end);
  if (d >= 80 && d <= 100) return 'quarter';
  if (d >= 170 && d <= 195) return 'half';
  if (d >= 260 && d <= 285) return 'nine';
  if (d >= 350 && d <= 380) return 'year';
  return null;
}

function findDuration(known: Fact[], span: Span, end: string, start?: string): Fact | null {
  for (let i = known.length - 1; i >= 0; i--) {
    const f = known[i];
    if (spanOf(f) !== span) continue;
    if (Math.abs(Date.parse(f.end) - Date.parse(end)) > SAME_DAY_TOLERANCE_MS * 5) continue;
    if (start && f.start && Math.abs(Date.parse(f.start) - Date.parse(start)) > SAME_DAY_TOLERANCE_MS * 5) continue;
    return f;
  }
  return null;
}

function shiftYear(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * Twelve months of a flow ending at the newest period known on `asOf`, and
 * that period's end.
 *
 * A fiscal year is its own twelve months. A quarter or a year-to-date figure
 * becomes twelve months as `year-to-date + last fiscal year − the same
 * year-to-date a year earlier`, which is how a 10-Q's figures add up to a
 * trailing year without a fourth quarter ever being reported on its own.
 * Where that arithmetic lacks a piece, the newest fiscal year stands in.
 */
export function trailingTwelveMonths(facts: Fact[], asOf: string): { value: number; end: string } | null {
  const known = knownOn(facts, asOf).filter((f) => spanOf(f) !== null);
  if (known.length === 0) return null;
  const newestEnd = known[known.length - 1].end;
  const years = known.filter((f) => spanOf(f) === 'year');
  const lastYear = years.length ? years[years.length - 1] : null;
  if (!lastYear) return null;
  if (days(lastYear.end, newestEnd) <= 5) return { value: lastYear.val, end: lastYear.end };

  // The newest figures belong to a fiscal year in progress: the year-to-date
  // one starts the day after the last fiscal year ended.
  const ytd = [...known].reverse().find((f) => f.end === newestEnd && f.start !== null
    && spanOf(f) !== 'year' && Math.abs(days(lastYear.end, f.start) - 1) <= 10);
  const span = ytd ? spanOf(ytd) : null;
  const priorYtd = ytd && span ? findDuration(known, span, shiftYear(ytd.end, -1)) : null;
  if (!ytd || !priorYtd) return { value: lastYear.val, end: lastYear.end };
  return { value: ytd.val + lastYear.val - priorYtd.val, end: ytd.end };
}

/** Fiscal-year values known on `asOf`, oldest first, one per fiscal year end. */
export function fiscalYears(facts: Fact[], asOf: string): { end: string; value: number }[] {
  const out = new Map<string, number>();
  for (const f of knownOn(facts, asOf)) {
    if (spanOf(f) === 'year') out.set(f.end, f.val);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([end, value]) => ({ end, value }));
}

// ── Download and cache ───────────────────────────────────────────────────────

/**
 * The SEC asks for at most ten requests a second, with a contact in the
 * User-Agent — and at eight a second, a full index's first download still
 * tripped its ten-minute block. Five keeps well clear.
 */
const secWindow = new RateWindow(5, 1000);
const SEC_UA = 'stock-cli backtest (open-source research tool; contact via repository)';
/** Waits before each retry of a rate-limited download, in milliseconds. */
const SEC_RETRIES = [5_000, 30_000, 90_000];

/**
 * A company's reduced facts: from the disk cache when it is younger than
 * `maxAgeDays`, else downloaded and reduced. Null for a company the SEC has
 * no XBRL for — a foreign private issuer filing on paper, a new listing.
 */
export async function companyFacts(cik: string, cacheDir: string, maxAgeDays = 30): Promise<CompanyFacts | null> {
  const padded = cik.padStart(10, '0');
  const file = join(cacheDir, `CIK${padded}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as PackedFacts;
      const fresh = cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < maxAgeDays * DAY_MS;
      if (cached.v === PACK_VERSION && fresh) return unpack(cached);
    } catch { /* re-fetch a damaged cache file */ }
  }
  try {
    let res: Response;
    // The SEC answers a burst with 429 even under its stated limit; a company
    // lost to one would leave the backtest's universe different run to run.
    for (let attempt = 0; ; attempt++) {
      await secWindow.take();
      res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, {
        headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 429 || attempt >= SEC_RETRIES.length) break;
      await new Promise((r) => setTimeout(r, SEC_RETRIES[attempt]));
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reduced = reduceCompanyFacts(await res.json() as RawCompanyFacts);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(pack(reduced)));
    return reduced;
  } catch (e) {
    logger.warn(`SEC company facts ${padded}: ${(e as Error).message}`);
    return null;
  }
}
