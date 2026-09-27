/**
 * Verdict changes on the watchlist: recorded when they happen, announced once
 * they hold.
 *
 * A stock whose score sits on a band's edge — 6.5 is BUY, 6.4 is HOLD — flips
 * with every refresh, and a notification per flip trains everyone to ignore
 * them. So there are two steps. Every flip is recorded (`verdict_changes`) and
 * shown on the overview. A change is *announced* — to the webhook configured
 * in the admin page — only once the new verdict has held through a refresh at
 * least `SETTLE_MS` later, and only if it differs from the verdict announced
 * last. A stock that goes HOLD → BUY → HOLD overnight announces nothing.
 *
 * The comparison is always against the stored series, which a re-score after
 * a model change rewrites too: a new scoring model changes verdicts in bulk,
 * and that is a deploy, not news about the companies.
 */

import { readAppConfig } from './app-config.js';
import {
  announcedVerdict, isReferenceSymbol, recentVerdictPoints, recordVerdictChange, setAnnouncedVerdict,
} from './db/store.js';
import { logger } from './utils/logger.js';

/** How long a new verdict must have held before it is announced: past the next nightly refresh. */
export const SETTLE_MS = 18 * 60 * 60 * 1000;

export interface VerdictPoint { at: Date; verdict: string; score: number | null }

export interface VerdictEvents {
  /** The newest point moved to another band: record it. */
  change:   { from: string; to: string; fromScore: number | null; toScore: number | null; at: Date } | null;
  /** The newest verdict has held long enough and was not announced yet. */
  announce: { from: string; to: string; score: number | null } | null;
  /** What to store as announced, where that changes; set silently the first time. */
  announced: string | null;
}

/**
 * What the newest point means, given the points before it (oldest first) and
 * the verdict announced last. Pure, so the rules above are testable.
 */
export function verdictEvents(points: VerdictPoint[], announced: string | null): VerdictEvents {
  const none: VerdictEvents = { change: null, announce: null, announced: null };
  if (points.length === 0) return none;
  const current = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;

  const change = previous && previous.verdict !== current.verdict
    ? { from: previous.verdict, to: current.verdict, fromScore: previous.score, toScore: current.score, at: current.at }
    : null;

  // Where the current run of this verdict began.
  let start = current;
  for (let i = points.length - 2; i >= 0 && points[i].verdict === current.verdict; i--) start = points[i];
  const settled = current.at.getTime() - start.at.getTime() >= SETTLE_MS;

  if (announced === null) {
    // The first reading of a stock is where it stands, not a change.
    return { change, announce: null, announced: current.verdict };
  }
  if (settled && current.verdict !== announced) {
    return { change, announce: { from: announced, to: current.verdict, score: current.score }, announced: current.verdict };
  }
  return { change, announce: null, announced: null };
}

/** POST one message to a webhook; Slack reads `text`, Discord `content`, anything else the fields. */
export async function sendWebhook(url: string, payload: Record<string, unknown> & { text: string }): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: payload.text, ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn(`Alert webhook answered HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    logger.warn(`Alert webhook failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Look at a watchlist stock's newest recorded verdict: record a change, and
 * announce one that has held. Best effort — an alert must never cost a refresh.
 */
export async function noteVerdict(symbol: string, source: 'refresh' | 'analysis'): Promise<void> {
  try {
    if (await isReferenceSymbol(symbol)) return;
    const points = await recentVerdictPoints(symbol, 14);
    const events = verdictEvents(points, await announcedVerdict(symbol));
    if (events.change) {
      await recordVerdictChange(symbol, events.change, source);
      logger.info(`${symbol}: ${events.change.from} → ${events.change.to}`);
    }
    if (events.announce) {
      const url = (await readAppConfig()).alerts.webhookUrl;
      const { from, to, score } = events.announce;
      if (url) {
        await sendWebhook(url, {
          text: `${symbol}: ${from} → ${to}${score !== null ? ` (${score.toFixed(1)})` : ''}`,
          symbol, from, to, score,
        });
      }
    }
    if (events.announced !== null) {
      const current = points[points.length - 1];
      await setAnnouncedVerdict(symbol, events.announced, current?.score ?? null);
    }
  } catch (e) {
    logger.warn(`${symbol}: verdict alert skipped — ${(e as Error).message}`);
  }
}
