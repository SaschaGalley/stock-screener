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

import { buildNarrativePrompt, distillDossierSection } from '../src/output/prompt.js';
import type { PerplexityContext } from '../src/data/perplexity.js';
import type { StockFinancials } from '../src/types.js';
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
    // Not claiming completeness, and saying which days the dropped four are from.
    assert.match(out, /4 older statements from 2026-08-10 to 2026-08-13 are not shown/);
  });

  it('says which span Distill left out, not just that something is missing', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({
        insights: {
          ...window([insight({ at: '2026-09-24T08:00:00.000Z' })], true),
          omitted: { count: 87, from: '2026-09-16T08:00:00.000Z', to: '2026-09-23T19:30:00.000Z' },
        },
      }),
    }));
    // The gap right behind a dossier is where a reader would assume nothing happened.
    assert.match(out, /87 older statements from 2026-09-16 to 2026-09-23 are not shown/);
    assert.doesNotMatch(out, /More exist than are shown/);
  });

  it("adds its own sector cap to what Distill left out, as one span", () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      insight({ id: `i${n}`, at: `2026-08-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`, content: `item ${n}` }));
    const out = distillDossierSection('AIR.PA', bundle({
      sectors: [block({
        kind: 'sector', ref: 'sector:industrials', displayName: 'Industrials',
        insights: {
          ...window(many, true),
          omitted: { count: 5, from: '2026-08-01T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
        },
      })],
    }));
    assert.match(out, /9 older statements from 2026-08-01 to 2026-08-13 are not shown/);
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

/**
 * How current the prose is. From 16 to 27 September 2026 every dossier came back
 * twelve days old, and the prompt still told the model "a late document landed;
 * the window above still holds" (distill#168). The reason decides the sentence.
 */
describe('dossier freshness', () => {
  it('says a dossier is out of date, with its end and how far it lags', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({
        state: 'outdated', stale: true, staleReasons: ['window_moved'], behindDays: 12,
        periodEnd: '2026-09-15T22:00:00.000Z',
      }),
    }));
    assert.match(out, /\*\*Out of date:\*\* this dossier ends on 2026-09-15, 12 days behind today/);
    assert.doesNotMatch(out, /the window above still holds/);
    // The prose itself is still there — true for its own window.
    assert.match(out, /Order book grew\./);
  });

  it('reads a lag of more than a day as out of date even under the state ready', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ state: 'ready', stale: true, staleReasons: ['window_moved'], behindDays: 3 }),
    }));
    assert.match(out, /\*\*Out of date:\*\*.*3 days behind today/);
  });

  it('keeps the harmless note for a late document, and only for that', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ stale: true, staleReasons: ['late_material'], behindDays: 0 }),
    }));
    assert.match(out, /a late document landed in a built day; the window above still holds/);
    assert.doesNotMatch(out, /Out of date/);
  });

  it("says a day of lag is covered by the raw statements until the night's build", () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ stale: true, staleReasons: ['window_moved'], behindDays: 1 }),
    }));
    assert.match(out, /a day behind until Distill's nightly build/);
    assert.doesNotMatch(out, /a late document landed/);
  });

  it('names rebuilt or reassigned material as such', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ stale: true, staleReasons: ['material_withdrawn'], behindDays: 0 }),
    }));
    assert.match(out, /part of its material was rebuilt or reassigned since/);
  });

  it('a bundle stored before the reasons existed keeps the old sentence', () => {
    const stored = block({ stale: true });
    delete stored.staleReasons;
    delete stored.behindDays;
    const out = distillDossierSection('AIR.PA', bundle({ company: stored }));
    assert.match(out, /a late document landed in a built day; the window above still holds/);
  });

  it('says nothing about freshness when the dossier is current', () => {
    const out = distillDossierSection('AIR.PA', bundle({
      company: block({ stale: false, staleReasons: [], behindDays: 0 }),
    }));
    assert.doesNotMatch(out, /Out of date|marked stale|a day behind/);
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
    assert.match(out, /Weigh it\s+like the web research, not above it/);
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


/**
 * How much Distill weighs. The company section used to call its material
 * "curated, multi-source", list "vetted RSS, earnings transcripts, sell-side
 * research" and rank it above Perplexity. Distill's audit of 27 September 2026
 * found most of it to be YouTube commentary, many daily tiles passed through
 * unedited, and promotion getting in — so the prompt no longer claims weight
 * for it, in the section or in the Perplexity heading that mirrored the claim.
 */
describe('how much Distill weighs', () => {
  const out = () => distillDossierSection('AIR.PA', bundle({ company: block() }));

  it('claims no precedence over the other qualitative sources', () => {
    const text = out();
    assert.doesNotMatch(text, /strongest qualitative signal|weight HIGHER|curated|vetted|sell-side research/);
    assert.match(text, /not verified, not ranked above other sources/);
  });

  it('says that opinion and repetition do not add up to evidence', () => {
    const text = out();
    assert.match(text, /An opinion stays an opinion/);
    assert.match(text, /Repetition is not confirmation/);
    assert.match(text, /A number or an event needs a second source/);
    assert.match(text, /Promotion can slip through/);
  });

  it('turns a divergence from the models into a question, not a verdict', () => {
    assert.match(out(), /as a question to check, not as a\s+verdict/);
  });
});

describe('the narrative prompt', () => {
  const f = { symbol: 'AIR.PA', companyName: 'Airbus', sector: 'Industrials', industry: 'Aerospace' } as StockFinancials;
  const pplx: PerplexityContext = {
    model: 'sonar-pro', synthesis: 'Order backlog at a record.', citations: [], fetchedAt: '2026-09-28T08:00:00.000Z',
  };

  it('no longer ranks Perplexity below Distill', () => {
    const text = buildNarrativePrompt(f, bundle({ company: block() }), pplx);
    assert.doesNotMatch(text, /unter Distill zu gewichten/);
    assert.match(text, /### Perplexity Sonar \(web-recherchiert\)/);
  });

  it('scores no dimension on a single commentator', () => {
    const text = buildNarrativePrompt(f, bundle({ company: block() }), pplx);
    assert.match(text, /Distill ist gesammelter Kommentar, keine geprüfte Quelle/);
    assert.match(text, /Wiederholt dieselbe Quelle etwas, bleibt es eine Quelle/);
  });
});
