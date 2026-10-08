/**
 * The watchlist feed a page at a time: a page closes at the end of a day,
 * the switches count what is left out, and the search narrows both.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pageFeed, type Feed, type FeedEvent } from '../src/stock-history-service.js';

const ev = (day: string, symbol: string, kind: FeedEvent['kind'], title: string): FeedEvent =>
  ({ day, symbol, name: `${symbol} AG`, kind, title, tone: 'neutral' });

const feed: Feed = {
  events: [
    ev('2026-03-05', 'AAA', 'analyst', 'Kursziel erhöht'),
    ev('2026-03-05', 'BBB', 'earnings', 'Quartalszahlen'),
    ev('2026-03-05', 'CCC', 'news', 'Eine Schlagzeile'),
    ev('2026-03-04', 'AAA', 'insider', 'Kauf von Erika Muster'),
    ev('2026-03-03', 'BBB', 'move', 'Kurssprung +9 %'),
  ],
  upcoming: [ev('2026-03-12', 'CCC', 'earnings', 'Nächste Quartalszahlen')],
  market: [{ day: '2026-03-18', event: 'Zinsentscheid', watch: 'Zinspfad' }],
  from: '2026-02-27',
  symbols: 3,
};

describe('the feed, a page at a time', () => {
  it('closes a page at the end of its last day and says where the next starts', () => {
    const p = pageFeed(feed, { days: 7, off: ['news'], limit: 1 });
    assert.deepEqual(p.events.map((e) => e.title), ['Kursziel erhöht', 'Quartalszahlen']);
    assert.equal(p.next, 2);
    assert.equal(p.total, 4);
    const rest = pageFeed(feed, { days: 7, off: ['news'], offset: p.next!, limit: 10 });
    assert.deepEqual(rest.events.map((e) => e.day), ['2026-03-04', '2026-03-03']);
    assert.equal(rest.next, null);
  });

  it('counts the kinds left out, so a switch says what it would bring back', () => {
    const p = pageFeed(feed, { days: 7, off: ['news'] });
    assert.equal(p.counts.news, 1);
    assert.ok(p.events.every((e) => e.kind !== 'news'));
    assert.deepEqual(p.perDay.map((d) => d.day), ['2026-03-03', '2026-03-04', '2026-03-05']);
    assert.deepEqual(p.perDay[2].counts, { analyst: 1, earnings: 1 });
  });

  it('searches the ticker, the name and the title, the coming reports included', () => {
    assert.deepEqual(pageFeed(feed, { days: 7, q: 'bbb' }).events.map((e) => e.kind), ['earnings', 'move']);
    assert.deepEqual(pageFeed(feed, { days: 7, q: 'erika' }).events.map((e) => e.symbol), ['AAA']);
    assert.equal(pageFeed(feed, { days: 7, q: 'ccc' }).upcoming.length, 1);
    assert.equal(pageFeed(feed, { days: 7, q: 'aaa' }).upcoming.length, 0);
  });
});
