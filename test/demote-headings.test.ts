/**
 * A Distill briefing is its own markdown document; the analysis prompt is
 * another one. Pasting the first into the second is the moment their heading
 * levels collide, and this is the seam that stops them from doing so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { demoteHeadings } from '../src/output/prompt.js';

describe('demoteHeadings', () => {
  it('pushes a briefing section below the heading that introduces it', () => {
    // `## Summary` next to `## Stock Analysis: …` makes the briefing's summary a
    // sibling of the whole analysis. Two levels down puts it where it belongs.
    assert.equal(demoteHeadings('## Summary', 2), '#### Summary');
  });

  it('preserves the relative structure inside the document', () => {
    const md = ['## Key Developments', 'text', '### Guidance', 'more'].join('\n');
    assert.equal(
      demoteHeadings(md, 2),
      ['#### Key Developments', 'text', '##### Guidance', 'more'].join('\n'),
    );
  });

  it('leaves body text and bullets alone', () => {
    const md = ['## Risks', '- margin fell to 55.4%', 'A #hashtag is not a heading.'].join('\n');
    assert.equal(
      demoteHeadings(md, 2),
      ['#### Risks', '- margin fell to 55.4%', 'A #hashtag is not a heading.'].join('\n'),
    );
  });

  it('stops at six, because markdown does', () => {
    assert.equal(demoteHeadings('##### Deep', 3), '###### Deep');
  });

  it('does not touch a # inside a fenced block — there it is content', () => {
    const md = ['## Summary', '```', '# not a heading', '```', '## Risks'].join('\n');
    assert.equal(
      demoteHeadings(md, 2),
      ['#### Summary', '```', '# not a heading', '```', '#### Risks'].join('\n'),
    );
  });

  it('handles a briefing with no headings at all', () => {
    assert.equal(demoteHeadings('Just a paragraph.', 2), 'Just a paragraph.');
  });
});
