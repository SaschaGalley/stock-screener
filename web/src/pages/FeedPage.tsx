import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { CloseIcon } from '../components/icons';
import { KIND_DOT, TONE_MARK, TONE_TEXT } from '../components/timelineStyle';
import {
  TIMELINE_KINDS, TIMELINE_LABEL, type TimelineKind,
} from '../../../src/analysis/timeline';
import type { Feed, FeedEvent } from '../../../src/stock-history-service';

const RANGES = [{ days: 1, label: 'Heute' }, { days: 7, label: '7 Tage' }, { days: 30, label: '30 Tage' }] as const;
/** Headlines outnumber everything else several times over; shown on request. */
const DEFAULT_OFF: TimelineKind[] = ['news'];
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const fmtDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.`;
};

/**
 * What happened across the watchlist: every stock's timeline over the last
 * days on one axis — rating changes, insider trades, the quarter's numbers,
 * our own verdict changes, the days a price jumped — and the reports due in
 * the next two weeks. The question the list raises each morning.
 */
export default function FeedPage({ onClose, onSelect }: { onClose: () => void; onSelect: (symbol: string) => void }) {
  const [days, setDays] = useState(7);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<TimelineKind>>(() => new Set(DEFAULT_OFF));

  useEffect(() => {
    let live = true;
    setFeed(null);
    setError(null);
    api.getFeed(days)
      .then((f) => { if (live) setFeed(f); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [days]);

  const counts = useMemo(() => {
    const c = new Map<TimelineKind, number>();
    for (const e of feed?.events ?? []) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [feed]);
  const shown = (feed?.events ?? []).filter((e) => !off.has(e.kind));
  const byDay = useMemo(() => {
    const groups: { day: string; events: FeedEvent[] }[] = [];
    for (const e of shown) {
      const g = groups[groups.length - 1];
      if (g && g.day === e.day) g.events.push(e); else groups.push({ day: e.day, events: [e] });
    }
    return groups;
  }, [shown]);

  const toggle = (k: TimelineKind) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-ink-100">Was ist passiert</h2>
          {feed && <span className="text-xs text-ink-500">{feed.symbols} Werte der Watchlist</span>}
          <div className="ml-auto flex items-center gap-1">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`rounded px-2.5 py-1 text-xs transition ${
                  r.days === days ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
                }`}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={onClose}
              title="Schließen (Esc)"
              className="ml-2 rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
        {!feed && !error && <div className="p-8 text-center text-sm text-ink-500">Lese die Zeitleisten der Watchlist…</div>}

        {feed && feed.upcoming.length > 0 && (
          <section className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
            <h3 className="mb-1.5 text-xs font-semibold text-ink-300">Quartalszahlen in den nächsten zwei Wochen</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {feed.upcoming.map((e) => (
                <button key={`${e.symbol}-${e.day}`} onClick={() => onSelect(e.symbol)} className="text-ink-300 hover:text-ink-100" title={e.name ?? e.symbol}>
                  <span className="font-mono text-ink-500">{fmtDay(e.day)}</span> <span className="font-mono text-ink-100">{e.symbol}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {feed && (
          <div className="flex flex-wrap items-center gap-1.5">
            {TIMELINE_KINDS.filter((k) => counts.has(k)).map((k) => (
              <button
                key={k}
                onClick={() => toggle(k)}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition ${
                  off.has(k) ? 'border-ink-800 text-ink-600' : 'border-ink-700 bg-ink-950 text-ink-300'
                }`}
              >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${off.has(k) ? 'bg-ink-700' : KIND_DOT[k]}`} />
                {TIMELINE_LABEL[k]} <span className="font-mono text-ink-500">{counts.get(k)}</span>
              </button>
            ))}
          </div>
        )}

        {feed && shown.length === 0 && (
          <p className="text-sm text-ink-500">Nichts im gewählten Zeitraum{off.size > 0 ? ' — oder nur in ausgeblendeten Arten' : ''}.</p>
        )}

        <div className="space-y-4">
          {byDay.map((g) => (
            <section key={g.day}>
              <h3 className="mb-1.5 text-xs font-semibold text-ink-300">{fmtDay(g.day)}{g.day.slice(0, 4) !== new Date().toISOString().slice(0, 4) ? g.day.slice(0, 4) : ''}</h3>
              <ul className="space-y-1 border-l border-ink-800 pl-3">
                {g.events.map((e, i) => (
                  <li key={i} className="relative flex gap-2 text-xs leading-snug">
                    <span className={`absolute -left-[15.5px] top-1.5 h-1.5 w-1.5 rounded-full ${KIND_DOT[e.kind]}`} />
                    <button
                      onClick={() => onSelect(e.symbol)}
                      title={e.name ?? e.symbol}
                      className="w-16 shrink-0 truncate text-left font-mono text-xs text-ink-200 hover:text-accent"
                    >
                      {e.symbol}
                    </button>
                    <span className={`shrink-0 ${TONE_TEXT[e.tone]}`}>{TONE_MARK[e.tone]}</span>
                    <span className="min-w-0 text-ink-300">
                      {e.url
                        ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:text-ink-100 hover:underline">{e.title}</a>
                        : e.title}
                      {e.detail && <span className="text-ink-500"> — {e.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
