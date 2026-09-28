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
 *
 * Two formats reach most places a phone or a team channel listens on: a JSON
 * POST for Slack, Discord and any generic webhook, and ntfy's own — the text
 * as the body, the title and an emoji tag as query parameters, which ntfy
 * accepts in place of its headers and which carry an arrow or an umlaut where
 * a header could not.
 */

import { readAppConfig, type AppConfig } from './app-config.js';
import { RECOMMENDATIONS } from './verdict.js';
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

export type AlertFormat = AppConfig['alerts']['format'];

/** One announcement, in the parts every format picks from. */
export interface Alert {
  /** Heading: ntfy's title. */
  title:  string;
  /** The whole message in one line: what Slack and Discord show. */
  text:   string;
  /** The line under the heading, where a format has one (ntfy); `text` otherwise. */
  detail?: string;
  /** ntfy tags; a tag that names an emoji shows as that emoji. */
  tags?:  string[];
  /** The facts as fields, for a JSON receiver that wants more than a line. */
  fields?: Record<string, unknown>;
}

/**
 * Credentials written into the URL, as the header that carries them.
 *
 * A protected receiver — an ntfy server of one's own, most often — is
 * configured as `https://user:password@host/topic`, and Node's fetch refuses
 * to send a URL that carries credentials at all. So they leave the URL and
 * travel as `Authorization`: Basic for a user and password, Bearer for an
 * ntfy access token given without a user (`https://:tk_…@host/topic`).
 */
function credentialsApart(url: string): { url: string; authorization: string | null } {
  const u = new URL(url);
  if (!u.username && !u.password) return { url, authorization: null };
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const authorization = !user && password.startsWith('tk_')
    ? `Bearer ${password}`
    : `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  return { url: u.toString(), authorization };
}

/** The request that delivers `alert` to `url` in `format`. Pure, so each format is testable. */
export function alertRequest(url: string, format: AlertFormat, alert: Alert): { url: string; init: RequestInit } {
  const { url: bare, authorization } = credentialsApart(url);
  const auth: Record<string, string> = authorization ? { Authorization: authorization } : {};
  if (format === 'ntfy') {
    const target = new URL(bare);
    target.searchParams.set('title', alert.title);
    if (alert.tags?.length) target.searchParams.set('tags', alert.tags.join(','));
    return {
      url: target.toString(),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...auth },
        body: alert.detail ?? alert.text,
      },
    };
  }
  // Slack reads `text`, Discord `content`, anything else the fields.
  return {
    url: bare,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ content: alert.text, text: alert.text, ...alert.fields }),
    },
  };
}

/** What a receiver said when it refused: ntfy answers `{"error": "forbidden", …}`, others with a line of text. */
function refusal(status: number, body: string): string {
  let said = body.trim();
  try {
    const json = JSON.parse(said) as { error?: unknown; message?: unknown };
    const text = json.error ?? json.message;
    if (typeof text === 'string') said = text;
  } catch { /* not JSON: the text as it came */ }
  return said ? `HTTP ${status}: ${said.slice(0, 200)}` : `HTTP ${status}`;
}

/**
 * Deliver one alert. Not delivered, it says why — the receiver's status and
 * answer, or why it could not be reached — for the log and the admin page's
 * test, which is where a wrong URL or a missing password shows.
 */
export async function sendAlert(url: string, format: AlertFormat, alert: Alert): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const { url: target, init } = alertRequest(url, format, alert);
    const res = await fetch(target, { ...init, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, reason: null };
    const reason = refusal(res.status, await res.text().catch(() => ''));
    logger.warn(`Alert webhook refused: ${reason}`);
    return { ok: false, reason };
  } catch (e) {
    // fetch reports an unreachable host as "fetch failed" and keeps the why in `cause`.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const reason = [(e as Error).message, cause?.code ?? cause?.message].filter(Boolean).join(': ');
    logger.warn(`Alert webhook failed: ${reason}`);
    return { ok: false, reason };
  }
}

/** The announcement of a verdict that has held. */
export function verdictAlert(symbol: string, a: { from: string; to: string; score: number | null }): Alert {
  // Earlier in the list is the more bullish verdict.
  const rank = (v: string) => RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);
  const up = rank(a.to) < rank(a.from);
  const score = a.score !== null ? a.score.toFixed(1) : null;
  return {
    title:  `${symbol}: ${a.from} → ${a.to}`,
    text:   `${symbol}: ${a.from} → ${a.to}${score !== null ? ` (${score})` : ''}`,
    detail: `${score !== null ? `Score ${score.replace('.', ',')} — ` : ''}das neue Urteil hat einen weiteren Nachtlauf gehalten.`,
    tags:   [up ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
    fields: { symbol, from: a.from, to: a.to, score: a.score },
  };
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
      const { webhookUrl, format } = (await readAppConfig()).alerts;
      if (webhookUrl) await sendAlert(webhookUrl, format, verdictAlert(symbol, events.announce));
    }
    if (events.announced !== null) {
      const current = points[points.length - 1];
      await setAnnouncedVerdict(symbol, events.announced, current?.score ?? null);
    }
  } catch (e) {
    logger.warn(`${symbol}: verdict alert skipped — ${(e as Error).message}`);
  }
}
