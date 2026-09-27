import fetch from 'node-fetch';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { FilingEntry, SubmissionsMeta, writeSubmissions } from '../db/admin.js';
import { getSubmissionsDir, writeSubmissionFile } from '../files.js';

const EDGAR_BASE = 'https://data.sec.gov';
const SEC_BASE   = 'https://www.sec.gov';
const UA         = 'investment-cli/1.0 (open-source research tool)';

const RELEVANT_FORMS = new Set(['10-K', '10-Q', '8-K', '20-F', '6-K', 'DEF 14A']);
const MAX_PER_FORM: Record<string, number> = {
  '10-K': 2, '10-Q': 4, '8-K': 3, '20-F': 2, '6-K': 3, 'DEF 14A': 1,
};

interface TickerEntry { cik_str: number; ticker: string; title: string }

interface EdgarSubmissionsResponse {
  cik:  string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate:      string[];
      form:            string[];
      primaryDocument: string[];
      description?:    string[];
    };
  };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) { logger.debug(`EDGAR ${res.status}: ${url}`); return null; }
    return await res.json() as T;
  } catch (e) {
    logger.debug(`EDGAR fetch error: ${(e as Error).message}`);
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) { logger.debug(`Download ${res.status}: ${url}`); return null; }
    return await res.text();
  } catch (e) {
    logger.debug(`Download error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The SEC's ticker → CIK table, once per process and day. It is a megabyte, and
 * the nightly refresh asks it once per symbol.
 */
const TICKER_TABLE_TTL_MS = 24 * 60 * 60 * 1000;
let tickerTable: { at: number; byTicker: Map<string, { cik: string; name: string }> } | null = null;

async function lookupCIK(symbol: string): Promise<{ cik: string; name: string } | null> {
  if (!tickerTable || Date.now() - tickerTable.at > TICKER_TABLE_TTL_MS) {
    const data = await getJson<Record<string, TickerEntry>>(`${SEC_BASE}/files/company_tickers.json`);
    if (!data) return null;
    tickerTable = {
      at: Date.now(),
      byTicker: new Map(Object.values(data).map((e) => [
        e.ticker.toUpperCase(), { cik: String(e.cik_str).padStart(10, '0'), name: e.title },
      ])),
    };
  }
  return tickerTable.byTicker.get(symbol.toUpperCase()) ?? null;
}

interface XbrlConcept {
  units?: Record<string, Array<{ end?: string; val?: number; form?: string }>>;
}

/** The newest reported value of one us-gaap concept, by period end. */
async function latestConcept(cik: string, concept: string): Promise<{ end: string; val: number } | null> {
  const data = await getJson<XbrlConcept>(`${EDGAR_BASE}/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`);
  let newest: { end: string; val: number } | null = null;
  for (const f of data?.units?.USD ?? []) {
    if (typeof f.end !== 'string' || typeof f.val !== 'number' || !Number.isFinite(f.val)) continue;
    if (!newest || f.end > newest.end) newest = { end: f.end, val: f.val };
  }
  return newest;
}

/** A balance older than this belongs to a filer that stopped reporting the concept. */
const LEASE_MAX_AGE_DAYS = 460;

/**
 * Operating lease liabilities as last reported to the SEC.
 *
 * Under US GAAP an operating lease costs rent inside operating income and
 * operating cash flow, while Yahoo's total debt carries the lease liability
 * too — so a cash-flow DCF that subtracts total debt charges the lease twice.
 * Starbucks carries 9.2 bn of them. The liability is only on the balance sheet
 * in total, or as its current and non-current halves; either answers. Null for
 * a filer that does not report the concept (IFRS filers, whose leases are debt
 * the cash flows are before, as they should be).
 */
export async function getOperatingLeaseLiabilities(symbol: string): Promise<number | null> {
  try {
    const cik = (await lookupCIK(symbol))?.cik;
    if (!cik) return null;
    const total = await latestConcept(cik, 'OperatingLeaseLiability');
    let found: { end: string; val: number } | null = total;
    if (!found) {
      const [current, noncurrent] = await Promise.all([
        latestConcept(cik, 'OperatingLeaseLiabilityCurrent'),
        latestConcept(cik, 'OperatingLeaseLiabilityNoncurrent'),
      ]);
      if (noncurrent) {
        found = { end: noncurrent.end, val: noncurrent.val + (current?.end === noncurrent.end ? current.val : 0) };
      }
    }
    if (!found) return null;
    const ageDays = (Date.now() - Date.parse(found.end)) / 86_400_000;
    return Number.isFinite(ageDays) && ageDays <= LEASE_MAX_AGE_DAYS && found.val >= 0 ? found.val : null;
  } catch (e) {
    logger.debug(`EDGAR operating leases for ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

export async function fetchEdgarFilings(
  symbol: string,
  dataDir: string,
): Promise<SubmissionsMeta | null> {
  logger.step('Looking up CIK in EDGAR...');
  const cikInfo = await lookupCIK(symbol);
  if (!cikInfo) {
    logger.warn(`${symbol} not found in EDGAR — likely a non-US listing (10-K/20-F unavailable)`);
    return null;
  }
  logger.info(`CIK: ${cikInfo.cik}  (${cikInfo.name})`);

  const edgarData = await getJson<EdgarSubmissionsResponse>(
    `${EDGAR_BASE}/submissions/CIK${cikInfo.cik}.json`,
  );
  if (!edgarData) {
    logger.warn(`Could not fetch EDGAR submission index for ${symbol}`);
    return null;
  }

  // Collect relevant filings respecting per-form limits. Large filers paginate
  // (filings.files[]) and `recent` / its arrays may be absent — guard the cast.
  const recent = edgarData.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) {
    logger.warn(`EDGAR submissions for ${symbol} had no usable 'recent' filings block`);
    return null;
  }
  const formCount: Record<string, number> = {};
  const filings: FilingEntry[] = [];

  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const form = recent.form[i];
    if (!RELEVANT_FORMS.has(form)) continue;
    const max = MAX_PER_FORM[form] ?? 1;
    formCount[form] = formCount[form] ?? 0;
    if (formCount[form] >= max) continue;
    formCount[form]++;
    filings.push({
      accessionNumber: recent.accessionNumber[i],
      form,
      filingDate:      recent.filingDate[i],
      primaryDocument: recent.primaryDocument[i],
      description:     recent.description?.[i] ?? '',
    });
  }

  logger.success(`Found ${filings.length} relevant filings`);

  // Download primary documents
  const subDir = getSubmissionsDir(dataDir, symbol);
  const cikNum = parseInt(cikInfo.cik, 10);
  let downloaded = 0;

  for (const filing of filings) {
    const acc       = filing.accessionNumber.replace(/-/g, '');
    const ext       = filing.primaryDocument.split('.').pop() ?? 'htm';
    const safeForm  = filing.form.replace(/\s+/g, '_');
    const localFile = `${safeForm}_${filing.filingDate}_${acc.slice(-6)}.${ext}`;

    if (existsSync(join(subDir, localFile))) {
      logger.debug(`Already cached: ${localFile}`);
      filing.localFile = localFile;
      downloaded++;
      continue;
    }

    const url = `${SEC_BASE}/Archives/edgar/data/${cikNum}/${acc}/${filing.primaryDocument}`;
    logger.debug(`Downloading ${filing.form} (${filing.filingDate})...`);
    const content = await getText(url);

    if (content) {
      writeSubmissionFile(dataDir, symbol, localFile, content);
      filing.localFile = localFile;
      downloaded++;
    } else {
      logger.warn(`  Could not download ${filing.form} ${filing.filingDate}`);
    }

    // SEC rate-limit guidance: ≤10 req/s; 350 ms gives comfortable headroom
    await new Promise((r) => setTimeout(r, 350));
  }

  logger.success(`Downloaded ${downloaded}/${filings.length} filings → ${subDir}`);

  const meta: SubmissionsMeta = {
    cik:        cikInfo.cik,
    entityName: cikInfo.name,
    filings,
    fetchedAt:  new Date().toISOString(),
  };

  await writeSubmissions(symbol, meta);
  return meta;
}
