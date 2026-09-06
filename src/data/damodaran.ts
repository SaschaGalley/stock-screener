/**
 * Damodaran's implied equity risk premium.
 *
 * The ERP is not a property of finance, it is a price: the extra return the
 * market is currently demanding for holding equities. Damodaran backs it out of
 * the S&P 500 every month — index level, trailing cash flows, expected growth
 * and the T-bond rate solved for the discount rate that reproduces the index —
 * and republishes the whole series as a spreadsheet. A hardcoded 5.5% was a
 * snapshot of that series taken once and never looked at again; it read 6.4% in
 * late 2008 and under 4% for most of the years since.
 *
 * So we pull it like the risk-free rate, from the one place it is published:
 *   https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx
 *
 * Which is an .xlsx, hence the ~60 lines of ZIP and XML below. That is the
 * whole cost, and it buys a number that moves with the market the rest of the
 * models are being compared against.
 */

import { inflateRawSync } from 'node:zlib';

import { logger } from '../utils/logger.js';

const ERP_XLSX = 'https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx';

/**
 * Which of the sheet's premium columns to read, by header text rather than by
 * position — he adds columns (the Covid-adjusted variant appeared in 2020) and
 * a fixed column index would have silently started reading a different series.
 *
 * "ERP (T12m)" is the trailing-twelve-month implied premium, the series he
 * charts as *the* implied ERP. It is measured against the raw T-bond rate,
 * which is what our own CAPM pairs it with (FRED DGS10), so the two halves of
 * `riskFreeRate + β × ERP` come from the same convention.
 */
const PREMIUM_HEADER = 'ERP (T12m)';
const DATE_HEADER    = 'Start of month';

/** Outside this band the parse is wrong, not the market. Historic range: ~2–6.5%. */
const PLAUSIBLE_ERP: readonly [number, number] = [0.02, 0.10];

/** A monthly series that stops moving is worth a warning, not a rejection. */
const STALE_AFTER_DAYS = 100;

export interface ImpliedERP {
  /** Implied premium as a decimal (0.0409 = 4.09%). */
  premium: number;
  /** Month the observation belongs to, `YYYY-MM`. */
  asOf: string | null;
}

// ─── xlsx reading ────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CDH_SIG  = 0x02014b50;

/**
 * The three entries we need out of the archive, decompressed.
 *
 * Walks the central directory rather than scanning for local file headers: the
 * `PK\x03\x04` signature also occurs inside compressed data, and a scan finds
 * those too.
 */
function readZipEntries(buf: Buffer, wanted: Set<string>): Map<string, string> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const entries = buf.readUInt16LE(eocd + 10);
  const out = new Map<string, string>();
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('bad central directory');
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localAt  = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (wanted.has(name)) {
      if (compSize === 0xffffffff || localAt === 0xffffffff) throw new Error('zip64 not supported');
      // The local header repeats the name and carries its own extra field,
      // which is routinely a different length from the central one.
      const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
      const raw = buf.subarray(dataAt, dataAt + compSize);
      out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');   // last, so &amp;lt; stays literal
}

/** The shared string table, in index order — sheet cells with `t="s"` point into it. */
function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    unescapeXml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''))
  );
}

interface SheetCell { col: string; row: number; text: string }

/** Every non-empty cell of a worksheet, in document order, resolved to text. */
function* cells(xml: string, strings: string[]): Generator<SheetCell> {
  const re = /<c\s+r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const [, col, row, attrs, inner] of xml.matchAll(re)) {
    if (!inner) continue;                                    // self-closing: styled but empty
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
           ?? /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
    if (v === undefined) continue;
    const shared = /\bt="s"/.test(attrs);
    const text = shared ? strings[Number(v)] : unescapeXml(v);
    if (text !== undefined) yield { col, row: Number(row), text };
  }
}

/**
 * Excel serial → `YYYY-MM`. Two epochs exist and this workbook is authored on a
 * Mac, so it uses the 1904 one; the 1900 epoch is offset by two days to
 * reproduce Lotus's phantom 29 Feb 1900.
 */
function serialToMonth(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + serial * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last row of the monthly series: its premium, and the month it belongs to. */
export function parseImpliedERP(xlsx: Buffer): ImpliedERP | null {
  const files = readZipEntries(xlsx, new Set([
    'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml',
  ]));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('no first worksheet');
  const date1904 = /date1904="(1|true)"/.test(files.get('xl/workbook.xml') ?? '');
  const strings = sharedStrings(files.get('xl/sharedStrings.xml'));

  let premiumCol: string | null = null;
  let dateCol: string | null = null;
  let last: { premium: number; serial: number | null } | null = null;
  let serial: number | null = null;

  for (const { col, row, text } of cells(sheet, strings)) {
    if (row === 1) {
      const header = text.trim().replace(/\s+/g, ' ');
      if (header === PREMIUM_HEADER) premiumCol = col;
      if (header === DATE_HEADER)    dateCol    = col;
      continue;
    }
    if (premiumCol === null) throw new Error(`no "${PREMIUM_HEADER}" column`);
    // Cells arrive row by row, so the date is read before the premium beside it.
    if (col === dateCol) serial = Number(text);
    if (col === premiumCol) {
      const premium = Number(text);
      if (Number.isFinite(premium)) last = { premium, serial: Number.isFinite(serial) ? serial : null };
    }
  }
  if (!last) return null;

  return {
    premium: last.premium,
    asOf: last.serial === null ? null : serialToMonth(last.serial, date1904),
  };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

/**
 * Process-level memo, mirroring `getMarketRates`. This series moves once a
 * month, so refetching 47KB on the hour would be pure waste; in-flight sharing
 * keeps concurrent openers to a single download.
 */
const ERP_TTL_MS = 12 * 60 * 60 * 1000;
let erpCache: { at: number; erp: ImpliedERP | null } | null = null;
let erpInFlight: Promise<ImpliedERP | null> | null = null;

/** Latest implied ERP, or null when it can't be fetched or parsed (caller falls back). */
export async function getImpliedERP(): Promise<ImpliedERP | null> {
  if (erpCache && Date.now() - erpCache.at < ERP_TTL_MS) return erpCache.erp;
  if (erpInFlight) return erpInFlight;

  erpInFlight = (async () => {
    let erp: ImpliedERP | null = null;
    try {
      const res = await fetch(ERP_XLSX, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      erp = parseImpliedERP(Buffer.from(await res.arrayBuffer()));

      const [lo, hi] = PLAUSIBLE_ERP;
      if (erp && (erp.premium < lo || erp.premium > hi)) {
        // A premium outside the band means we are reading the wrong column, not
        // that equities got cheap. Refuse it rather than discount half the
        // portfolio at a made-up rate.
        throw new Error(`implausible premium ${(erp.premium * 100).toFixed(2)}% — column layout changed?`);
      }
      if (erp) {
        logger.debug(`Damodaran implied ERP — ${(erp.premium * 100).toFixed(2)}% (${erp.asOf ?? 'undated'})`);
        if (erp.asOf !== null && daysSince(erp.asOf) > STALE_AFTER_DAYS) {
          logger.warn(`Damodaran implied ERP is stale — latest observation is ${erp.asOf}`);
        }
      }
    } catch (e) {
      logger.warn(`Damodaran ERP: ${(e as Error).message}`);
      erp = null;
    }
    // Negative results are cached too: when the file moves or the layout
    // changes, every valuation would otherwise re-download it and re-fail.
    erpCache = { at: Date.now(), erp };
    return erp;
  })();

  try {
    return await erpInFlight;
  } finally {
    erpInFlight = null;
  }
}

/** Days since the first of the given `YYYY-MM`. */
function daysSince(asOf: string): number {
  const [y, m] = asOf.split('-').map(Number);
  return (Date.now() - Date.UTC(y, m - 1, 1)) / 86_400_000;
}
