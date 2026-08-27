/**
 * How the Distill prose reaches the analysis model.
 *
 * The load-bearing part is the labelling. A sector dossier read as
 * company-specific is the observed failure mode of this integration, not a
 * hypothetical one, so these tests pin that every block says what it is about —
 * and that a briefing's own headings can never outrank the section holding them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { distillDossierSection } from '../src/output/prompt.js';
import type { DistillBundle, DistillDossierBlock } from '../src/data/distill.js';

function block(over: Partial<DistillDossierBlock> = {}): DistillDossierBlock {
  return {
    kind:        'company',
    ref:         'company:airbus',
    entityId:    'uuid-airbus',
    displayName: 'Airbus',
    state:       'ready',
    periodStart: '2026-07-28T22:00:00.000Z',
    periodEnd:   '2026-08-27T22:00:00.000Z',
    builtAt:     '2026-08-27T22:21:45.000Z',
    stale:       false,
    content:     '## Summary\nOrder book grew.',
    ...over,
  };
}

const bundle = (over: Partial<DistillBundle> = {}): DistillBundle => ({
  ticker: 'AIR.PA', baseUrl: 'https://distill.test',
  company: null, sectors: [], briefing: null,
  fetchedAt: '2026-08-27T20:00:00.000Z',
  ...over,
});

describe('distillDossierSection', () => {
  it('says nothing at all when there is no prose', () => {
    assert.equal(distillDossierSection('AIR.PA', bundle()), '');
    assert.equal(distillDossierSection('AIR.PA', undefined), '');
  });

  it('drops a block that carries no content, rather than heading an empty one', () => {
    const empty = block({ state: 'empty', content: null });
    assert.equal(distillDossierSection('AIR.PA', bundle({ company: empty })), '');
  });

  it('scopes a company block to the company', () => {
    const out = distillDossierSection('AIR.PA', bundle({ company: block() }));
    assert.match(out, /Company dossier — Airbus/);
    assert.match(out, /\*\*Scope: AIR\.PA itself\.\*\*/);
  });

  it('warns, on the sector block itself, that it is not about the company', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' })],
    }));
    assert.match(out, /Sector dossier — Industrials/);
    assert.match(out, /NOT AIR\.PA/);
    assert.match(out, /never becomes a company-level\s+finding/);
  });

  it('keeps both sectors of a stock that sits in two', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block(),
      sectors: [
        block({ kind: 'sector', ref: 'sector:aerospace_defense', displayName: 'Aerospace & Defense' }),
        block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' }),
      ],
    }));
    assert.match(out, /sector:aerospace_defense/);
    assert.match(out, /sector:industrials/);
    assert.equal(out.match(/#### Sector dossier/g)?.length, 2);
  });

  it('states the window, and that it is exclusive at the end', () => {
    const out = distillDossierSection('AIR.PA', bundle({ company: block() }));
    assert.match(out, /Window 2026-07-28 to 2026-08-27 \(end exclusive\)/);
  });

  it('carries `stale` as a note instead of hiding the block', () => {
    const out = distillDossierSection('AIR.PA', bundle({ company: block({ stale: true }) }));
    assert.match(out, /marked stale upstream/);
    assert.match(out, /Order book grew/, 'the prose is still there');
  });

  it('demotes the block prose below its own heading', () => {
    // `## Summary` inside a `####` block would otherwise outrank the section —
    // and, at the top level, the whole stock analysis.
    const out = distillDossierSection('AIR.PA', bundle({ company: block() }));
    assert.match(out, /^##### Summary$/m);
    assert.doesNotMatch(out, /^## Summary$/m);
  });

  it('marks the briefing as the one block that includes today', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block(),
      briefing: {
        id: 'b1', briefingTypeId: 't1', briefingTypeName: 'Daily', title: 'x',
        body: '## Summary\nToday.', format: 'markdown', language: 'de',
        entityRefs: [], insightCount: 3, model: 'm', costUsd: null,
        createdAt: '2026-08-27T10:00:00.000Z',
      },
    }));
    assert.match(out, /#### Briefing — Daily/);
    assert.match(out, /does\* include today/);
  });
});
