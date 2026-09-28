/**
 * A verdict change is recorded when it happens and announced once it holds.
 *
 * A score on a band's edge flips with every refresh; announcing every flip
 * would train everyone to ignore the announcements. These tests pin when the
 * webhook speaks and when it keeps quiet.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SETTLE_MS, alertRequest, verdictAlert, verdictEvents, type VerdictPoint } from '../src/alerts.js';

const t0 = Date.parse('2026-09-20T00:30:00Z');
const at = (hours: number, verdict: string, score = 5): VerdictPoint => ({ at: new Date(t0 + hours * 3_600_000), verdict, score });

describe('verdict alerts', () => {
  it('takes a stock\'s first reading as where it stands, not as news', () => {
    const e = verdictEvents([at(0, 'HOLD')], null);
    assert.equal(e.announce, null);
    assert.equal(e.announced, 'HOLD');
  });

  it('records a flip at once but announces it only after it held through a later refresh', () => {
    const fresh = verdictEvents([at(0, 'HOLD'), at(24, 'BUY', 6.6)], 'HOLD');
    assert.deepEqual(fresh.change && [fresh.change.from, fresh.change.to], ['HOLD', 'BUY']);
    assert.equal(fresh.announce, null, 'one night is not yet a change');

    const held = verdictEvents([at(0, 'HOLD'), at(24, 'BUY', 6.6), at(48, 'BUY', 6.8)], 'HOLD');
    assert.equal(held.change, null);
    assert.deepEqual(held.announce, { from: 'HOLD', to: 'BUY', score: 6.8 });
    assert.equal(held.announced, 'BUY');
  });

  it('does not count a second write of the same night as holding', () => {
    // The data step and the analysis write minutes apart.
    const e = verdictEvents([at(0, 'HOLD'), at(24, 'BUY'), at(24.2, 'BUY')], 'HOLD');
    assert.ok(0.2 * 3_600_000 < SETTLE_MS);
    assert.equal(e.announce, null);
  });

  it('stays quiet about a stock that went there and back', () => {
    const e = verdictEvents([at(0, 'HOLD'), at(24, 'BUY'), at(48, 'HOLD'), at(72, 'HOLD')], 'HOLD');
    assert.equal(e.announce, null);
    assert.equal(e.announced, null);
  });
});

describe('delivering an announcement', () => {
  const alert = verdictAlert('MSFT', { from: 'HOLD', to: 'BUY', score: 6.74 });

  it('posts JSON with the line as text for Slack and content for Discord, and the facts as fields', () => {
    const { url, init } = alertRequest('https://hooks.example.com/x', 'json', alert);
    assert.equal(url, 'https://hooks.example.com/x');
    const body = JSON.parse(init.body as string);
    assert.equal(body.text, 'MSFT: HOLD → BUY (6.7)');
    assert.equal(body.content, body.text);
    assert.deepEqual([body.symbol, body.from, body.to, body.score], ['MSFT', 'HOLD', 'BUY', 6.74]);
  });

  it('posts to an ntfy topic as text, with the title and an emoji tag in the query', () => {
    const { url, init } = alertRequest('https://ntfy.example.com/stocks?priority=4', 'ntfy', alert);
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, 'https://ntfy.example.com/stocks');
    assert.equal(u.searchParams.get('priority'), '4', 'what the URL already carried stays');
    assert.equal(u.searchParams.get('title'), 'MSFT: HOLD → BUY');
    assert.equal(u.searchParams.get('tags'), 'chart_with_upwards_trend');
    assert.match(init.body as string, /^Score 6,7 — /);
  });

  it('tags a downgrade with the falling chart', () => {
    assert.deepEqual(verdictAlert('X', { from: 'BUY', to: 'SELL', score: null }).tags, ['chart_with_downwards_trend']);
  });
});
