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
import type {
  DistillBundle,
  DistillDossierBlock,
  DistillInsight,
} from '../src/data/distill.js';

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
    insights:    null,
    ...over,
  };
}

function insight(over: Partial<DistillInsight> = {}): DistillInsight {
  return {
    id:            'i1',
    at:            '2026-08-27T09:14:00.000Z',
    content:       'Order intake rose 12% in July.',
    documentTitle: 'Airbus July orders',
    documentUrl:   'https://example.test/a',
    sourceName:    'Reuters',
    ...over,
  };
}

const window = (items: DistillInsight[], truncated = false) => ({
  from: '2026-07-28T22:00:00.000Z', to: '2026-08-27T20:00:00.000Z',
  count: items.length, truncated, items,
});

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
    assert.match(out, /#### Company — Airbus/);
    assert.match(out, /\*\*Scope: AIR\.PA itself\.\*\*/);
  });

  it('warns, on the sector block itself, that it is not about the company', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' })],
    }));
    assert.match(out, /#### Sector — Industrials/);
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
    assert.equal(out.match(/#### Sector — /g)?.length, 2);
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

  it('renders a legacy briefing from an older bundle', () => {
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
    assert.match(out, /stored from an earlier run/);
  });
});

describe('raw insights in the prompt', () => {
  it('renders them with the news date and the source', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ insights: window([insight()]) }),
    }));

    assert.match(out, /- 2026-08-27 · Reuters — Airbus July orders: Order intake rose 12% in July\./);
  });

  it('says they are unsynthesised, so one is one source', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ insights: window([insight()]) }),
    }));

    assert.match(out, /does NOT reproduce/);
    assert.match(out, /weigh a single one as a single\s+source/);
  });

  it('carries a block that has insights but no dossier — the just-switched-on case', () => {
    // Exactly what the paid briefing fallback used to be for.
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ state: 'not_built', content: null, insights: window([insight()]) }),
    }));

    assert.match(out, /No dossier has been built for this entity yet/);
    assert.match(out, /Order intake rose 12%/);
    assert.doesNotMatch(out, /Window .* to /, 'no window to state without a dossier');
  });

  it('warns when more exist than are shown, so silence is not read as absence', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ insights: window([insight()], true) }),
    }));

    assert.match(out, /absence here is not evidence of absence/);
  });

  it('caps a sector at eight and keeps the newest, without claiming completeness', () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      insight({ id: `i${n}`, at: `2026-08-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`, content: `item ${n}` }));

    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials', insights: window(many) })],
    }));

    assert.equal(out.match(/^- 2026-08-/gm)?.length, 8);
    assert.doesNotMatch(out, /item 3\b/, 'the four oldest are dropped');
    assert.match(out, /item 11\b/, 'the newest survive');
    assert.match(out, /More exist than are shown/);
  });

  it('leaves a company uncapped below the limit', () => {
    const many = Array.from({ length: 12 }, (_, n) => insight({ id: `i${n}`, content: `item ${n}` }));

    const out = distillDossierSection('AIR.PA', bundle({ company: block({ insights: window(many) }) }));

    assert.equal(out.match(/^- 2026-08-27/gm)?.length, 12);
    assert.doesNotMatch(out, /More exist than are shown/);
  });

  it('renders nothing extra when a block brought no insights', () => {
    const out = distillDossierSection('AIR.PA', bundle({ company: block() }));
    assert.doesNotMatch(out, /Raw source statements/);
  });
});

describe('the company / sector split', () => {
  it('keeps the strong-weight claim off the sector section', () => {
    // The whole reason for two sections: material filed under a heading that
    // says "strongest qualitative signal" reads as such however the sentences
    // inside it hedge.
    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' })],
    }));

    assert.doesNotMatch(out, /strongest qualitative signal/);
    assert.match(out, /### Sector Context — Industrials \(background, NOT about AIR\.PA\)/);
  });

  it('says outright that the sector blocks being longer is not weight', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block(),
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' })],
    }));

    assert.match(out, /\*\*Length here is not weight\.\*\*/);
  });

  it('emits both sections, company first', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block(),
      sectors: [block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' })],
    }));

    const company = out.indexOf('### Distill Dossier — AIR.PA');
    const sector  = out.indexOf('### Sector Context');
    assert.ok(company >= 0 && sector > company, 'the company section comes first');
    assert.match(out, /strongest qualitative signal/);
  });

  it('emits no sector section when the stock has none', () => {
    const out = distillDossierSection('AIR.PA', bundle({ company: block() }));
    assert.doesNotMatch(out, /### Sector Context/);
  });

  it('names every sector in the section heading', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [
        block({ kind: 'sector', ref: 'sector:aerospace_defense', displayName: 'Aerospace & Defense' }),
        block({ kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials' }),
      ],
    }));

    assert.match(out, /### Sector Context — Aerospace & Defense, Industrials/);
  });
});
