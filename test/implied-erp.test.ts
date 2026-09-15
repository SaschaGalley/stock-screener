/**
 * The implied ERP, read out of Damodaran's monthly spreadsheet.
 *
 * The parser's whole job is to survive a file we do not control: he adds
 * columns, and the premium must keep coming from the column with the right
 * header rather than from wherever "J" happens to point that year.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseImpliedERP } from '../src/data/damodaran.js';
import { workbook } from './support/xlsx.js';

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
