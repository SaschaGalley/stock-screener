/**
 * The chart's answers on made-up prices: which way, where in the channel,
 * the room each way, the push — and that the list beside them does not say
 * twice what they already say.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chartAnalysis, type ChartBar } from '../src/analysis/chart.js';
import { chartAnswers, notableFindings, rsiWord, trendAnswer } from '../src/analysis/chart-reading.js';

function bars(closes: number[]): ChartBar[] {
  const d = new Date('2024-01-01T00:00:00Z');
  const out: ChartBar[] = [];
  for (let k = 0; k < closes.length;) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const c = closes[k], prev = k > 0 ? closes[k - 1] : c;
      out.push({ day: d.toISOString().slice(0, 10), open: prev, high: Math.max(c, prev) * 1.005, low: Math.min(c, prev) * 0.995, close: c, volume: 1_000_000 });
      k++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A rise with pullbacks: up 30, back 12, up again — a year and more of it. */
const zig = (n: number, start: number, up: number) => {
  const xs: number[] = [];
  let p = start;
  for (let k = 0; k < n; k++) {
    p *= 1 + up + (k % 30 < 20 ? 0.006 : -0.009);
    xs.push(p);
  }
  return xs;
};

describe('the chart in answers', () => {
  it('calls a steady rise up and says why', () => {
    const a = chartAnalysis(bars(zig(300, 50, 0.001)))!;
    const t = trendAnswer(a);
    assert.equal(t.tone, 'bull');
    assert.match(t.answer, /ufwärts/);
    assert.ok(t.why.some((w) => /Linie|Durchschnitt/.test(w)) && t.why.some((w) => /Kanal steigt/.test(w)));
  });

  it('calls a steady fall down', () => {
    const a = chartAnalysis(bars(zig(300, 200, -0.0045)))!;
    assert.equal(trendAnswer(a).tone, 'bear');
  });

  it('answers the four questions with words, not σ or ATR', () => {
    const a = chartAnalysis(bars(zig(300, 50, 0.001)))!;
    const answers = chartAnswers(a, 0.04);
    assert.deepEqual(answers.map((x) => x.key).slice(0, 2), ['trend', 'place']);
    for (const x of answers) assert.ok(!/σ|ATR|R²/.test([x.answer, ...x.why].join(' ')), `${x.key}: ${x.why.join(' · ')}`);
  });

  it('leaves the levels, channel and averages out of the notable list — the answers say them', () => {
    const a = chartAnalysis(bars(zig(300, 50, 0.001)))!;
    const keys = notableFindings(a).map((f) => f.key);
    for (const k of ['support', 'resistance', 'room', 'ma', 'channel']) assert.ok(!keys.includes(k));
    for (const f of a.findings) assert.ok(f.title.length > 0 && f.title.length < 60, f.key);
  });

  it('reads the RSI in words', () => {
    assert.equal(rsiWord(75).word, 'Heiß gelaufen');
    assert.equal(rsiWord(50).word, 'Neutral');
    assert.equal(rsiWord(25).word, 'Ausverkauft');
  });
});
