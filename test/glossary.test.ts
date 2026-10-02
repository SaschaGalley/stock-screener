/**
 * The glossary explains stored metrics by their catalogue keys. A key that is
 * not in the catalogue is an explanation for a field that was renamed or
 * removed — still on screen, attached to nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCatalog } from '../src/db/catalog.js';
import { GLOSSARY } from '../web/src/glossary.js';

/** Keys for what has no single series behind it: sections, columns, ways of reading. */
const CONCEPT_PREFIXES = ['section.', 'concept.', 'list.', 'card.', 'tech.'];

describe('the glossary', () => {
  it('explains only metrics the catalogue knows', () => {
    const catalog = new Set(buildCatalog().map((m) => m.key));
    const orphans = Object.keys(GLOSSARY)
      .filter((k) => !CONCEPT_PREFIXES.some((p) => k.startsWith(p)))
      .filter((k) => !catalog.has(k));
    assert.deepEqual(orphans, []);
  });

  it('says something for every key', () => {
    for (const [k, v] of Object.entries(GLOSSARY)) assert.ok(v.trim().length > 20, k);
  });
});
