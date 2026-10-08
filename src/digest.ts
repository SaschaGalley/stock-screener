/**
 * The morning's message: what happened across the watchlist since the last one.
 *
 * The feed (`watchlistFeed`) answers the question when someone opens the page;
 * this answers it without them having to — after the night's watchlist pass,
 * to the webhook the verdict changes already go to. Rating changes, insider
 * trades, the quarter's numbers, the days a price jumped and the developments
 * the research found, and the reports due in the next days. Headlines are
 * left out (there are too many to be news), and so are verdict changes, which
 * are announced on their own once they hold.
 *
 * What was sent is remembered by event, not by date: a rating change dated
 * yesterday afternoon is archived tonight, after yesterday's message went out,
 * and a cut-off by day would lose it.
 */

import { sendAlert, type Alert } from './alerts.js';
import { readAppConfig } from './app-config.js';
import { readAppState, writeAppState } from './db/admin.js';
import { watchlistFeed, type FeedEvent } from './stock-history-service.js';
import type { TimelineKind } from './analysis/timeline.js';
import { logger } from './utils/logger.js';

/** The kinds a message carries, in the order it lists them. */
export const DIGEST_KINDS: readonly TimelineKind[] = ['earnings', 'insider', 'analyst', 'move', 'event'];
/** How far back the message looks for what it has not sent yet. */
const LOOKBACK_DAYS = 7;
/** Reports this close are mentioned. */
const UPCOMING_DAYS = 3;
/** ntfy takes 4 KB and Discord 2,000 characters: the rest is counted, not listed. */
const MAX_LINES = 20;
const MAX_LINE = 160;
const SENT_KEY = 'digest.sent';

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const MARK = { positive: '▲', negative: '▼', neutral: '·' } as const;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const fmtDay = (day: string) => `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.`;

export const eventKey = (e: FeedEvent) => `${e.symbol}|${e.day}|${e.kind}|${e.title}`;

function line(e: FeedEvent): string {
  const text = `${e.symbol} ${MARK[e.tone]} ${e.title}${e.detail ? ` — ${e.detail}` : ''}`;
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
}

/**
 * The message for a set of new events, with the reports due soon below them;
 * null without events — a report coming up is not news on a quiet night. Pure.
 */
export function digestAlert(events: readonly FeedEvent[], upcoming: readonly FeedEvent[]): Alert | null {
  if (events.length === 0) return null;
  const order = (e: FeedEvent) => DIGEST_KINDS.indexOf(e.kind);
  const sorted = [...events].sort((a, b) => order(a) - order(b) || a.symbol.localeCompare(b.symbol) || b.day.localeCompare(a.day));
  const lines = sorted.slice(0, MAX_LINES).map(line);
  if (sorted.length > MAX_LINES) lines.push(`+ ${sorted.length - MAX_LINES} weitere — alles unter „Was ist passiert“`);
  if (upcoming.length) lines.push(`Quartalszahlen bald: ${upcoming.map((e) => `${e.symbol} ${fmtDay(e.day)}`).join(', ')}`);
  const symbols = new Set(events.map((e) => e.symbol)).size;
  const title = `Watchlist: ${events.length} ${events.length === 1 ? 'Neuigkeit' : 'Neuigkeiten'} bei ${symbols} ${symbols === 1 ? 'Wert' : 'Werten'}`;
  return {
    title,
    text: `${title}\n${lines.join('\n')}`,
    detail: lines.join('\n'),
    tags: ['newspaper'],
    fields: { events: sorted.map((e) => ({ symbol: e.symbol, day: e.day, kind: e.kind, tone: e.tone, title: e.title, detail: e.detail ?? null })),
      upcoming: upcoming.map((e) => ({ symbol: e.symbol, day: e.day })) },
  };
}

/**
 * Send what is new since the last message. A test sends the last day as it
 * would arrive, marked as a test, and remembers nothing — the night's message
 * is not shortened by it.
 */
export async function sendDigest(opts: { test?: boolean } = {}): Promise<{ ok: boolean; events: number; reason: string | null }> {
  const { webhookUrl, format, digest } = (await readAppConfig()).alerts;
  if (!webhookUrl) return { ok: false, events: 0, reason: 'Keine Webhook-URL gespeichert' };
  if (!digest && !opts.test) return { ok: false, events: 0, reason: 'Täglicher Überblick ist aus' };

  const feed = await watchlistFeed(LOOKBACK_DAYS, true);
  let sent: Record<string, string> = {};
  try { sent = JSON.parse((await readAppState(SENT_KEY)) ?? '{}') as Record<string, string>; } catch { /* start over */ }
  // The first message has no memory: it reports the last day, not the whole week.
  const first = Object.keys(sent).length === 0;
  const since = isoDay(Date.now() - DAY_MS);
  const fresh = feed.events.filter((e) => DIGEST_KINDS.includes(e.kind)
    && (opts.test || first ? e.day >= since : !sent[eventKey(e)]));
  const soon = feed.upcoming.filter((e) => e.kind === 'earnings' && e.day <= isoDay(Date.now() + UPCOMING_DAYS * DAY_MS));

  const alert = digestAlert(fresh, soon);
  if (!alert) return { ok: true, events: 0, reason: null };
  const result = await sendAlert(webhookUrl, format, opts.test
    ? { ...alert, title: `Test · ${alert.title}`, text: `Test · ${alert.text}`, fields: { ...alert.fields, test: true } }
    : alert);
  if (result.ok && !opts.test) {
    // Everything in the window counts as sent once a message went out, and
    // keys older than the window are dropped: nothing can come back into it.
    const cutoff = isoDay(Date.now() - (LOOKBACK_DAYS + 1) * DAY_MS);
    const next: Record<string, string> = {};
    for (const [k, day] of Object.entries(sent)) if (day >= cutoff) next[k] = day;
    for (const e of feed.events) if (DIGEST_KINDS.includes(e.kind)) next[eventKey(e)] = e.day;
    await writeAppState(SENT_KEY, JSON.stringify(next));
    logger.info(`Digest sent: ${fresh.length} events, ${soon.length} reports due`);
  }
  return { ok: result.ok, events: fresh.length, reason: result.reason };
}
