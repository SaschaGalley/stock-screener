/**
 * The implied ERP, read out of Damodaran's monthly spreadsheet.
 *
 * The parser's whole job is to survive a file we do not control: he adds
 * columns, and the premium must keep coming from the column with the right
 * header rather than from wherever "J" happens to point that year.
 */

import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { parseImpliedERP } from '../src/data/damodaran.js';

// ─── A minimal .xlsx, built here so the test needs no network and no fixture ──

const COL = (i: number) => String.fromCharCode(65 + i); // A, B, C … (≤ 26 columns)

/** One worksheet: a header row of shared strings, then rows of numbers. */
function sheetXml(headers: string[], rows: (number | null)[][]): string {
  const header = headers
    .map((_, i) => `<c r="${COL(i)}1" t="s"><v>${i}</v></c>`)
    .join('');
  const body = rows.map((cells, r) =>
    `<row r="${r + 2}">${cells.map((v, i) =>
      // Empty cells are written self-closing by Excel — the parser has to skip
      // them without swallowing the next cell's value.
      v === null ? `<c r="${COL(i)}${r + 2}" s="1"/>` : `<c r="${COL(i)}${r + 2}"><v>${v}</v></c>`
    ).join('')}</row>`
  ).join('');
  return `<?xml version="1.0"?><worksheet><sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
}

function stringsXml(headers: string[]): string {
  const si = headers.map((h) => `<si><t>${h.replace(/&/g, '&amp;')}</t></si>`).join('');
  return `<?xml version="1.0"?><sst count="${headers.length}">${si}</sst>`;
}

/** A ZIP archive of `name → xml`, deflated for all but the first entry. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text, 'utf8');
    const stored = i === 0;                        // exercise both storage methods
    const data = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    locals.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  });

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

function workbook(headers: string[], rows: (number | null)[][], date1904 = true): Buffer {
  return zip({
    'xl/workbook.xml': `<?xml version="1.0"?><workbook><workbookPr date1904="${date1904 ? 1 : 0}"/></workbook>`,
    'xl/sharedStrings.xml': stringsXml(headers),
    'xl/worksheets/sheet1.xml': sheetXml(headers, rows),
  });
}

/** The file as it stands today: date, index, rates, then the premium variants. */
const HEADERS = [
  'Start of month', 'S&P 500', 'T.Bond Rate', 'ERP (T12 m with sustainable payout)',
  'ERP (T12m)', 'ERP (Smoothed)',
];
const ROWS = [
  [44773, 7490, 0.0474, 0.0428, 0.0423, 0.0625],   // 2026-08
  [44804, 7686.14, 0.0475, 0.0414, 0.0409, 0.0605], // 2026-09
];

describe('implied ERP', () => {
  it('reads the last month of the series', () => {
    assert.deepEqual(parseImpliedERP(workbook(HEADERS, ROWS)), {
      premium: 0.0409,
      asOf: '2026-09',
    });
  });

  it('follows the header, not the column position', () => {
    // He inserted "ERP (Covid Adjusted)" mid-table in 2020; a fixed index would
    // have started reporting the neighbouring series without a word.
    const headers = [...HEADERS];
    headers.splice(4, 0, 'ERP (Covid Adjusted)');
    const rows = ROWS.map((r) => [...r.slice(0, 4), 0.081, ...r.slice(4)]);

    assert.equal(parseImpliedERP(workbook(headers, rows))?.premium, 0.0409);
  });

  it('refuses a file without the premium column', () => {
    const headers = HEADERS.map((h) => (h === 'ERP (T12m)' ? 'ERP (renamed)' : h));
    assert.throws(() => parseImpliedERP(workbook(headers, ROWS)), /ERP \(T12m\)/);
  });

  it('skips empty cells rather than reading past them', () => {
    // Early rows of the real file carry only a few columns.
    const rows = [...ROWS, [44834, 7700, 0.0480, null, null, null]];
    assert.equal(parseImpliedERP(workbook(HEADERS, rows))?.premium, 0.0409);
  });

  it('dates the observation with the workbook epoch', () => {
    // The same serial in a 1900-based workbook is 1462 days earlier — Damodaran
    // authors his on a Mac, and reading the file with the wrong epoch would
    // date every observation four years out.
    assert.equal(parseImpliedERP(workbook(HEADERS, ROWS, false))?.asOf, '2022-08');
  });
});
