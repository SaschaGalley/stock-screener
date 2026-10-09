/**
 * The cells of a workbook's first sheet, as text: enough to read an issuer's
 * holdings file, nothing more — no formats, formulas or dates. Cells are
 * placed by their column letter, so a row with gaps keeps its columns.
 */

import { strFromU8, unzipSync } from 'fflate';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m));

/** The text of every `<t>` inside, as a shared or inline string runs it together. */
const text = (xml: string) => unescape([...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(''));

const column = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function sheetRows(file: Uint8Array): string[][] {
  const files = unzipSync(file);
  const strings = files['xl/sharedStrings.xml']
    ? [...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => text(m[1]))
    : [];
  const sheet = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  for (const r of strFromU8(files[sheet]).matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = c[1].match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = c[1].match(/\bt="(\w+)"/)?.[1];
      const v = c[2]?.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      const value = type === 's' ? strings[Number(v)] ?? ''
        : type === 'inlineStr' ? text(c[2] ?? '')
        : unescape(v ?? '');
      row[ref ? column(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}
