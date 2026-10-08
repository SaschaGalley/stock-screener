/** What is scheduled for a made-up stock. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { upcomingOf } from '../src/analysis/timeline.js';

const money = (n: number) => `${n.toFixed(2)} $`;

describe('upcoming dates', () => {
  it('lists the report, the dividend days and the catalysts ahead, the report once', () => {
    const xs = upcomingOf(
      { nextEarningsDate: '2026-10-28', exDividendDate: '2026-11-05', dividendPayDate: '2026-11-20', nextDividendAmount: 0.42 },
      [
        { date: '2026-10-27', event: 'Q3 earnings release', watch: 'Marge im Cloud-Geschäft' },
        { date: '2026-11-12', event: 'Investorentag', watch: 'Ziele für 2028' },
        { date: '2026-09-01', event: 'Vorbei', watch: '' },
        { date: null, event: 'Irgendwann', watch: '' },
      ],
      '2026-10-08', money,
    );
    assert.deepEqual(xs.map((x) => [x.day, x.kind, x.title]), [
      ['2026-10-28', 'earnings', 'Quartalszahlen'],
      ['2026-11-05', 'dividend', 'Ex-Dividende'],
      ['2026-11-12', 'event', 'Investorentag'],
      ['2026-11-20', 'dividend', 'Dividendenzahlung'],
    ]);
    assert.equal(xs[0].detail, 'Marge im Cloud-Geschäft');
    assert.equal(xs[1].detail, '0.42 $ je Aktie');
  });

  it('leaves out what is past', () => {
    assert.deepEqual(upcomingOf(
      { nextEarningsDate: '2026-10-01', exDividendDate: '2026-09-01', dividendPayDate: null, nextDividendAmount: null }, [], '2026-10-08', money,
    ), []);
  });
});
