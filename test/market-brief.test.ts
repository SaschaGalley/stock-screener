/** Reading the market brief's answer: what is kept, what is dropped, nothing filled in. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMarketBrief } from '../src/data/market-brief.js';

describe('the market brief', () => {
  it('keeps the sectors of the vocabulary with a direction, and drops the rest', () => {
    const b = parseMarketBrief(`Hier die Notiz:
\`\`\`json
{"state": "Der S&P 500 steht 2 % unter dem Hoch [1] [https://example.com/spx?x=1].", "rotation": "Aus Technologie in Versorger.",
 "sectors": [
   {"sector": "technology", "direction": "turning down", "why": "Gewinnmitnahmen", "source": "https://example.com/a"},
   {"sector": "Semiconductors", "direction": "strong", "why": "kein Sektor der Liste"},
   {"sector": "Utilities", "direction": "sideways", "why": "keine Richtung der Liste"}
 ],
 "drivers": [{"what": "Zinsen (https://example.com/fed)", "impact": "Gegenwind für Wachstumswerte"}, {"what": ""}],
 "problems": [{"what": "Kreditaufschläge steigen"}],
 "calendar": [{"date": "2026-10-28", "event": "Fed-Sitzung", "watch": "Zinspfad"}]}
\`\`\``);
    assert.ok(b);
    assert.equal(b.state, 'Der S&P 500 steht 2 % unter dem Hoch.');
    assert.deepEqual(b.sectors.map((s) => [s.sector, s.direction]), [['Technology', 'turning-down']]);
    assert.equal(b.drivers.length, 1);
    assert.equal(b.drivers[0].what, 'Zinsen');
    assert.equal(b.calendar[0].event, 'Fed-Sitzung');
  });

  it('is no brief without a picture of the market', () => {
    assert.equal(parseMarketBrief('{"rotation": "irgendwohin"}'), null);
    assert.equal(parseMarketBrief('Ich kann dazu nichts sagen.'), null);
  });
});
