/**
 * A fund's every position, from its issuer: Amundi's product API, iShares'
 * holdings file and SPDR's daily holdings workbook, each found by the fund's
 * ISIN. Yahoo (`fund-holdings.ts`) gives only the ten largest, and a broad
 * fund holds most stocks a depot holds besides well past its tenth: a Stoxx
 * Europe 600 fund has its European large caps at around one per cent each.
 *
 * Amundi and SPDR name each position's ISIN; iShares gives its ticker and
 * exchange, read here as the Yahoo symbol the depot's stocks carry.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { sheetRows } from './xlsx.js';

export const ISSUERS = ['amundi', 'ishares', 'spdr'] as const;
export type Issuer = (typeof ISSUERS)[number];
export const ISSUER_NAMES: Record<Issuer, string> = { amundi: 'Amundi', ishares: 'iShares', spdr: 'SPDR' };

export interface Composition {
  issuer:   Issuer;
  asOf:     string | null;
  /** The fund's shares; weights are of the fund. */
  holdings: { isin: string | null; symbol: string | null; name: string; weight: number }[];
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (stock-cli)' };
const TIMEOUT_MS = 30_000;

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mär: '03', mrz: '03', mar: '03', apr: '04', mai: '05', may: '05', jun: '06', jul: '07',
  aug: '08', sep: '09', okt: '10', oct: '10', nov: '11', dez: '12', dec: '12',
};
/** "07.Okt.2026" or "07-Oct-2026" as 2026-10-07. */
export function issuerDay(s: string | undefined): string | null {
  const m = s?.match(/(\d{1,2})[.\s-]+(\p{L}{3})\p{L}*[.\s-]+(\d{4})/u);
  const month = m && MONTHS[m[2].toLowerCase()];
  return m && month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

/** A German number, "9.120.367,53". */
const deNumber = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

/** Yahoo's suffix for an exchange as iShares names it; US listings have none. */
const EXCHANGES: [RegExp, string][] = [
  [/^nasdaq$|new york|nyse arca|nyse mkt|cboe/i, ''],
  [/xetra|deutsche b(ö|oe)rse|frankfurt/i, '.DE'],
  [/euronext paris/i, '.PA'], [/euronext amsterdam/i, '.AS'], [/euronext brussels/i, '.BR'], [/euronext lisbon/i, '.LS'],
  [/london/i, '.L'], [/six swiss/i, '.SW'], [/borsa italiana/i, '.MI'], [/madrid/i, '.MC'], [/wiener|vienna/i, '.VI'],
  [/copenhagen/i, '.CO'], [/helsinki/i, '.HE'], [/oslo/i, '.OL'], [/stockholm|omx nordic$/i, '.ST'], [/irish/i, '.IR'],
  [/tokyo/i, '.T'], [/hong kong/i, '.HK'], [/toronto/i, '.TO'], [/asx/i, '.AX'], [/singapore/i, '.SI'],
  [/tel aviv/i, '.TA'], [/new zealand/i, '.NZ'],
];

/** "BRK B" on the New York exchange as BRK-B, "NOVO B" in Copenhagen as NOVO-B.CO, "700" in Hong Kong as 0700.HK. */
export function yahooSymbol(ticker: string, exchange: string): string | null {
  const suffix = EXCHANGES.find(([re]) => re.test(exchange.trim()))?.[1];
  let t = ticker.trim().replace(/\.+$/, '').replace(/[\s./]+/g, '-');
  if (suffix === undefined || !t || t === '-') return null;
  if (suffix === '.HK' && /^\d+$/.test(t)) t = t.padStart(4, '0');
  return t + suffix;
}

/** RFC 4180 rows: quoted fields, doubled quotes, commas inside quotes. */
function csvRows(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** The rows under the header that names every column asked for, as records. */
function table(rows: string[][], columns: string[]): Record<string, string>[] {
  const at = rows.findIndex((r) => columns.every((c) => r.includes(c)));
  if (at < 0) return [];
  const header = rows[at];
  return rows.slice(at + 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** What the issuer sent, as it is kept: Amundi's composition, iShares' CSV, SPDR's sheet as rows. */
export function parseComposition(issuer: string, raw: any): Composition | null {
  let holdings: Composition['holdings'] = [];
  let asOf: string | null = null;
  if (issuer === 'amundi') {
    const rows: any[] = Array.isArray(raw?.compositionData) ? raw.compositionData : [];
    asOf = rows.find((r) => r?.compositionCharacteristics?.date)?.compositionCharacteristics.date ?? null;
    holdings = rows.flatMap((r) => {
      const c = r?.compositionCharacteristics ?? {};
      const weight = Number(r?.weight ?? c.weight);
      const name = typeof c.name === 'string' ? c.name.trim() : '';
      return /^(EQUITY|PREFERENCE)/.test(c.type ?? '') && name && weight > 0
        ? [{ isin: ISIN.test(c.isin ?? '') ? c.isin : null, symbol: null, name, weight }] : [];
    });
  } else if (issuer === 'ishares') {
    const rows = csvRows(String(raw?.csv ?? '').replace(/^﻿/, ''));
    asOf = issuerDay(rows[0]?.[1]);
    holdings = table(rows, ['Emittententicker', 'Name', 'Anlageklasse', 'Gewichtung (%)', 'Börse']).flatMap((r) => {
      const weight = deNumber(r['Gewichtung (%)']) / 100;
      return r.Anlageklasse === 'Aktien' && r.Name && weight > 0
        ? [{ isin: null, symbol: yahooSymbol(r.Emittententicker, r['Börse']), name: r.Name, weight }] : [];
    });
  } else if (issuer === 'spdr') {
    const rows: string[][] = Array.isArray(raw?.rows) ? raw.rows : [];
    asOf = issuerDay(rows.find((r) => /holdings as of/i.test(r[0] ?? ''))?.[1]);
    holdings = table(rows, ['ISIN', 'Security Name', 'Percent of Fund']).flatMap((r) => {
      const weight = Number(r['Percent of Fund']) / 100;
      return ISIN.test(r.ISIN) && r['Security Name'] && weight > 0 ? [{ isin: r.ISIN, symbol: null, name: r['Security Name'], weight }] : [];
    });
  } else return null;
  return holdings.length ? { issuer: issuer as Issuer, asOf, holdings } : null;
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res;
}

async function amundi(isin: string): Promise<unknown | null> {
  const res = await get('https://www.amundietf.de/mapi/ProductAPI/getProductsData', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { countryCode: 'DEU', languageCode: 'de', userProfileName: 'RETAIL' }, productIds: [isin], productType: 'PRODUCT',
      composition: { compositionFields: ['date', 'type', 'isin', 'bbg', 'name', 'weight', 'currency', 'sector', 'countryOfRisk'] },
    }),
  });
  const c = ((await res.json()) as any)?.products?.[0]?.composition;
  return c?.compositionData?.length ? c : null;
}

async function ishares(isin: string): Promise<unknown | null> {
  const search = (await (await get('https://www.ishares.com/varnish-api/core-search/search/products?'
    + new URLSearchParams({ site: 'de-ishares-v2', locale: 'de-de', rows: '5', start: '0', userType: 'individual', query: isin }))).json()) as any;
  const results: any[] = search?.results ?? [];
  // The search finds by ISIN exactly; one answer is the fund, several would be a guess.
  if (results.length !== 1 || !results[0]?.portfolioId) return null;
  const portfolioId = String(results[0].portfolioId);
  const csv = await (await get(`https://www.ishares.com/de/privatanleger/de/produkte/${portfolioId}/fund/latest-holdings.csv`)).text();
  return /Emittententicker/.test(csv) ? { portfolioId, csv } : null;
}

/** SPDR's funds by ISIN, to their ticker; the list names the ISIN only in each fund's document links. */
let spdrList: { at: number; tickers: Promise<Map<string, string>> } | null = null;
function spdrTickers(): Promise<Map<string, string>> {
  if (spdrList && Date.now() - spdrList.at < 86_400_000) return spdrList.tickers;
  const tickers = (async () => {
    const j = (await (await get('https://www.ssga.com/bin/v1/ssmp/fund/fundfinder?country=de&language=de&role=intermediary&product=etfs&ui=fund-finder')).json()) as any;
    const out = new Map<string, string>();
    for (const f of j?.data?.funds?.etfs?.datas ?? []) {
      const m = JSON.stringify(f).match(/isin=([A-Z0-9]{12})[^"]*?ticker=([a-z0-9-]+)/);
      if (m) out.set(m[1], m[2]);
    }
    return out;
  })();
  spdrList = { at: Date.now(), tickers };
  tickers.catch(() => { spdrList = null; });
  return tickers;
}

async function spdr(isin: string): Promise<unknown | null> {
  const ticker = (await spdrTickers()).get(isin);
  if (!ticker) return null;
  const file = new Uint8Array(await (await get(`https://www.ssga.com/library-content/products/fund-data/etfs/emea/holdings-daily-emea-en-${ticker}.xlsx`)).arrayBuffer());
  // The sheet as rows, without the closing page of legal text.
  const rows = sheetRows(file).filter((r) => r.every((c) => c.length < 500));
  return rows.length ? { ticker, rows } : null;
}

const FETCH: Record<Issuer, (isin: string) => Promise<unknown | null>> = { amundi, ishares, spdr };

/**
 * Ask each issuer for the fund in turn; the first that knows it answers. Null
 * when none does — and an error when one could not be asked, so that a site
 * that is down is not taken for one that does not know the fund.
 */
export async function fetchComposition(isin: string): Promise<{ issuer: Issuer; raw: unknown } | null> {
  let failed: Error | null = null;
  for (const issuer of ISSUERS) {
    try {
      const raw = await FETCH[issuer](isin);
      if (raw) return { issuer, raw };
    } catch (e) {
      failed = e as Error;
    }
  }
  if (failed) throw failed;
  return null;
}
