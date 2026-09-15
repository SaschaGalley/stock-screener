/**
 * A minimal .xlsx, built in memory so spreadsheet tests need no network and no
 * binary fixture: one worksheet, a header row of shared strings, rows of numbers.
 */

import { crc32, deflateRawSync } from 'node:zlib';

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

export function workbook(headers: string[], rows: (number | null)[][], date1904 = true): Buffer {
  return zip({
    'xl/workbook.xml': `<?xml version="1.0"?><workbook><workbookPr date1904="${date1904 ? 1 : 0}"/></workbook>`,
    'xl/sharedStrings.xml': stringsXml(headers),
    'xl/worksheets/sheet1.xml': sheetXml(headers, rows),
  });
}

/** Damodaran's layout cut down to what the parser reads: one month (serial 44804 = Sep 2026), one premium. */
export function erpWorkbook(premium: number): Buffer {
  return workbook(['Start of month', 'T.Bond Rate', 'ERP (T12m)'], [[44804, 0.0475, premium]]);
}
