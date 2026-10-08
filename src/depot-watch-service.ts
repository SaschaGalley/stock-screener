/**
 * The night watch, sent: after the night's watchlist pass, the signals the
 * depot view computes for each stock held (`analysis/depot-watch.ts`) are
 * compared with those announced before, and what is new goes to the webhook
 * the verdict changes and the morning's digest go to — in one message.
 *
 * The message names the stock, the signal and the prices it was read at;
 * never a quantity, a value or a gain.
 */

import { sendAlert, type Alert } from './alerts.js';
import { readAppConfig } from './app-config.js';
import { newSignals, type WatchKind, type WatchSignal } from './analysis/depot-watch.js';
import { writeAppState } from './db/admin.js';
import { readStateJson } from './depot-check-state.js';
import { readDepot } from './depot-service.js';
import { tradesSource } from './trades-service.js';
import { logger } from './utils/logger.js';

const STATE_KEY = () => `depot.watch.${tradesSource()}.announced`;

/** The message for what is new tonight; null when nothing is. Pure. */
export function watchAlert(fresh: { symbol: string; name: string; signal: WatchSignal }[]): Alert | null {
  if (fresh.length === 0) return null;
  const lines = fresh.map((x) => `${x.symbol} · ${x.signal.label}: ${x.signal.text}`);
  const title = `Depot: ${fresh.length} ${fresh.length === 1 ? 'Hinweis' : 'Hinweise'} des Wächters`;
  return {
    title,
    text: `${title}\n${lines.join('\n')}`,
    detail: lines.join('\n'),
    tags: ['rotating_light'],
    fields: { depotWatch: fresh.map((x) => ({ symbol: x.symbol, kind: x.signal.kind, text: x.signal.text })) },
  };
}

/** Announce tonight's new signals. Best effort: the night's run never waits on it. */
export async function watchDepot(): Promise<{ sent: number; reason: string | null }> {
  const { webhookUrl, format, depotWatch } = (await readAppConfig()).alerts;
  if (!webhookUrl || !depotWatch) return { sent: 0, reason: null };
  const view = (await readDepot()).view;
  if (!view) return { sent: 0, reason: null };

  const now: Record<string, WatchKind[]> = {};
  for (const p of view.positions) if (p.symbol && p.signals.length) now[p.symbol] = p.signals.map((s) => s.kind);
  const before = (await readStateJson<Record<string, WatchKind[]>>(STATE_KEY())) ?? {};
  const fresh = Object.entries(newSignals(now, before)).flatMap(([symbol, kinds]) => {
    const p = view.positions.find((x) => x.symbol === symbol)!;
    return p.signals.filter((s) => kinds.includes(s.kind)).map((signal) => ({ symbol, name: p.name, signal }));
  });

  const alert = watchAlert(fresh);
  const result = alert ? await sendAlert(webhookUrl, format, alert) : { ok: true, reason: null };
  // Remembered only once it went out: a refused message is tried again tomorrow.
  if (result.ok) await writeAppState(STATE_KEY(), JSON.stringify(now));
  if (fresh.length) logger.info(`Depot watch: ${fresh.length} new signals${result.ok ? '' : ` not sent — ${result.reason}`}`);
  return { sent: result.ok ? fresh.length : 0, reason: result.reason };
}
