import fetch from 'node-fetch';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import {
  FilingEntry, SubmissionsMeta,
  writeSubmissions, writeSubmissionFile, getSubmissionsDir,
} from '../cache.js';

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

async function lookupCIK(symbol: string): Promise<{ cik: string; name: string } | null> {
  const data = await getJson<Record<string, TickerEntry>>(`${SEC_BASE}/files/company_tickers.json`);
  if (!data) return null;
  const sym = symbol.toUpperCase();
  for (const entry of Object.values(data)) {
    if (entry.ticker.toUpperCase() === sym) {
      return { cik: String(entry.cik_str).padStart(10, '0'), name: entry.title };
    }
  }
  return null;
}

export async function fetchEdgarFilings(
  symbol: string,
  cacheDir: string,
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

  // Collect relevant filings respecting per-form limits
  const recent = edgarData.filings.recent;
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
  const subDir = getSubmissionsDir(cacheDir, symbol);
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
      writeSubmissionFile(cacheDir, symbol, localFile, content);
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

  writeSubmissions(cacheDir, symbol, meta);
  return meta;
}
