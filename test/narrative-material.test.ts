/**
 * How much the narrative may weigh, from what each source brought.
 *
 * The weights follow what each source was measured to carry on 10 October 2026
 * (`measurements/quellen/BERICHT.md`): the brief most, deep research beside it,
 * a Distill dossier least. These tests pin the arithmetic, not the numbers'
 * justification.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DistillBundle } from '../src/data/distill.js';
import type { PerplexityContext, PerplexityFinding } from '../src/data/perplexity.js';
import { SOURCE_WEIGHT, narrativeMaterial } from '../src/score-service.js';

const now = new Date().toISOString();
const item = (independent: boolean): PerplexityFinding => ({ date: '2026-10-01', what: 'x', source: null, independent });

const report = (independentItems: number, model: PerplexityContext['model'] = 'sonar-pro'): PerplexityContext => ({
  model, synthesis: 'text', citations: [], fetchedAt: now,
  findings: { events: Array.from({ length: independentItems }, () => item(true)), bearEvidence: [item(false)], bullClaims: [] },
});
const prose: PerplexityContext = { model: 'sonar-pro', synthesis: 'a report in prose', citations: [], fetchedAt: now };
const dossier = { ticker: 'X', baseUrl: '', fetchedAt: now, company: { content: 'Some commentary.', periodEnd: now } } as unknown as DistillBundle;

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe('the narrative\'s weight from its sources', () => {
  it('gives a brief its full share at six independent items, and a share of it below', () => {
    close(narrativeMaterial(null, report(6)).confidence, SOURCE_WEIGHT.perplexity);
    close(narrativeMaterial(null, report(3)).confidence, SOURCE_WEIGHT.perplexity / 2);
    close(narrativeMaterial(null, report(0)).confidence, 0);
  });

  it('counts deep research beside the brief rather than as the better of the two', () => {
    const both = narrativeMaterial(null, report(6), undefined, report(6, 'sonar-deep-research'));
    close(both.confidence, SOURCE_WEIGHT.perplexity + SOURCE_WEIGHT.deepResearch);
    assert.deepEqual(both.sources, ['perplexity', 'perplexity-deep']);
  });

  it('gives a report that came back as prose half its share', () => {
    close(narrativeMaterial(null, prose).confidence, SOURCE_WEIGHT.perplexity / 2);
  });

  it('weighs a Distill dossier below the brief', () => {
    close(narrativeMaterial(dossier).confidence, SOURCE_WEIGHT.companyDossier);
    assert.ok(SOURCE_WEIGHT.companyDossier < SOURCE_WEIGHT.deepResearch);
    assert.ok(SOURCE_WEIGHT.deepResearch < SOURCE_WEIGHT.perplexity);
  });

  it('skips the stage when nothing arrived', () => {
    assert.equal(narrativeMaterial(null, null).empty, true);
  });
});
