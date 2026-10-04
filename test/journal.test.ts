/**
 * The journal: which stocks an entry is about, and how they moved since.
 *
 * A `$` in front of a ticker links the entry, a `$` in front of a number is a
 * price. The move is measured from the entry's day — or the last trading day
 * before it — and says nothing for an entry from today.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { journalHeadline, linkMentions, mentionedSymbols, normalizeSymbols } from '../src/journal.js';
import { JournalInputError, moveSince, parseJournalInput } from '../src/journal-service.js';

describe('naming stocks in an entry', () => {
  it('reads $TICKER and leaves prices alone', () => {
    assert.deepEqual(mentionedSymbols('$googl und $MSFT könnten das KI-Rennen gewinnen, Pro kostet $17.'), ['GOOGL', 'MSFT']);
  });

  it('keeps exchange suffixes and drops a full stop after the ticker', () => {
    assert.deepEqual(mentionedSymbols('Gekauft: $ENR.DE. Danach $NOW.'), ['ENR.DE', 'NOW']);
  });

  it('does not read an amount in the middle of a word', () => {
    assert.deepEqual(mentionedSymbols('US$NOW und a$b'), []);
  });

  it('normalises the field: upper case, once each, no dollar, nothing that is not a ticker', () => {
    assert.deepEqual(normalizeSymbols([' now', '$NOW', 'brk-b', 'two words', 42, '']), ['NOW', 'BRK-B']);
  });

  it('links mentions to the stock page', () => {
    assert.equal(linkMentions('Mehr $nvda.'), 'Mehr [$NVDA](#/stock/NVDA).');
  });

  it('gives the first line without markdown as the headline', () => {
    assert.equal(journalHeadline('\n## Gelesen: **Barron\'s** über [$NOW](x)\nmehr'), 'Gelesen: Barron\'s über $NOW');
  });
});

describe('an entry as sent', () => {
  it('links the stocks named in the field and in the text', () => {
    const e = parseJournalInput({ day: '2026-10-04', kind: 'note', symbols: ['now'], body: 'Wie $MSFT? ' });
    assert.deepEqual(e.symbols, ['NOW', 'MSFT']);
    assert.equal(e.body, 'Wie $MSFT?');
  });

  it('refuses a purchase without a stock', () => {
    assert.throws(() => parseJournalInput({ day: '2026-10-04', kind: 'buy', body: 'Gekauft' }), JournalInputError);
  });

  it('refuses an empty entry, an unknown kind and a broken date', () => {
    assert.throws(() => parseJournalInput({ day: '2026-10-04', body: '  ' }), JournalInputError);
    assert.throws(() => parseJournalInput({ day: '2026-10-04', kind: 'hold', body: 'x' }), JournalInputError);
    assert.throws(() => parseJournalInput({ day: '4.10.2026', body: 'x' }), JournalInputError);
  });
});

describe('the move since an entry', () => {
  const bars = [
    { day: '2026-09-30', close: 100 },
    { day: '2026-10-01', close: 110 },
    { day: '2026-10-02', close: 99 },
  ];

  it('runs from the entry day to the newest close', () => {
    const m = moveSince(bars, '2026-10-01')!;
    assert.equal(m.fromDay, '2026-10-01');
    assert.equal(m.toDay, '2026-10-02');
    assert.ok(Math.abs(m.change - (99 / 110 - 1)) < 1e-12);
  });

  it('takes the last close before a weekend entry', () => {
    assert.equal(moveSince([{ day: '2026-10-02', close: 100 }, { day: '2026-10-05', close: 105 }], '2026-10-04')!.fromDay, '2026-10-02');
  });

  it('says nothing for an entry from the newest day, or one older than the history', () => {
    assert.equal(moveSince(bars, '2026-10-02'), null);
    assert.equal(moveSince(bars, '2026-10-04'), null);
    assert.equal(moveSince(bars, '2026-08-01'), null);
  });
});
