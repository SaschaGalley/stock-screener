/**
 * The morning's message: the kinds in their order, the rest counted rather
 * than listed, and nothing at all on a quiet night.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { digestAlert, eventKey } from '../src/digest.js';
import type { FeedEvent } from '../src/stock-history-service.js';

const event = (over: Partial<FeedEvent>): FeedEvent => ({
  day: '2026-10-01', kind: 'analyst', title: 'Morgan Stanley: Kursziel gesenkt', detail: '$360 → $355',
  tone: 'negative', symbol: 'AAPL', name: 'Apple', ...over,
});

describe('the daily digest', () => {
  it('sends nothing without news, even with a report coming up', () => {
    assert.equal(digestAlert([], [event({ kind: 'earnings', title: 'Nächste Quartalszahlen' })]), null);
  });

  it('lists the quarter first, then insiders, then the analysts', () => {
    const a = digestAlert([
      event({}),
      event({ symbol: 'MSFT', kind: 'insider', tone: 'negative', title: 'CFO: Verkauf', detail: null }),
      event({ symbol: 'NOW', kind: 'earnings', tone: 'positive', title: 'Quartal bis 2026-09-30: EPS $1.20', detail: null }),
    ], [event({ symbol: 'ASML', day: '2026-10-14', kind: 'earnings' })])!;
    assert.equal(a.title, 'Watchlist: 3 Neuigkeiten bei 3 Werten');
    assert.deepEqual(a.detail!.split('\n'), [
      'NOW ▲ Quartal bis 2026-09-30: EPS $1.20',
      'MSFT ▼ CFO: Verkauf',
      'AAPL ▼ Morgan Stanley: Kursziel gesenkt — $360 → $355',
      'Quartalszahlen bald: ASML Mi 14.10.',
    ]);
  });

  it('counts what does not fit, and cuts long lines', () => {
    const many = Array.from({ length: 25 }, (_, k) => event({ symbol: `S${String(k).padStart(2, '0')}`, title: 'x'.repeat(300) }));
    const lines = digestAlert(many, [])!.detail!.split('\n');
    assert.equal(lines.length, 21);
    assert.match(lines[20], /^\+ 5 weitere/);
    assert.ok(lines[0].length <= 160);
  });

  it('knows an event again by what it is, not when it was sent', () => {
    assert.equal(eventKey(event({})), eventKey(event({ name: 'Apple Inc.' })));
    assert.notEqual(eventKey(event({})), eventKey(event({ day: '2026-10-02' })));
  });
});
