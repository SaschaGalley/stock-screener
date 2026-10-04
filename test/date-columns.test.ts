/**
 * A `date` column reads back as the day it holds.
 *
 * node-postgres parsed DATE into a Date at local midnight, and the readers
 * turned it back into a day with toISOString() — in UTC. On Europe/Berlin
 * every price bar, ex-date and insider trade came back a day early: the last
 * bar of 2 October 2026 read as 1 October.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import pg from 'pg';

import '../src/db/client.js';

const DATE_OID = 1082;

describe('date columns', () => {
  it('pass the day through as Postgres sends it, in any time zone', () => {
    const parse = pg.types.getTypeParser(DATE_OID);
    assert.equal(parse('2026-10-02'), '2026-10-02');
    assert.equal(parse('2012-06-29'), '2012-06-29');
  });
});
