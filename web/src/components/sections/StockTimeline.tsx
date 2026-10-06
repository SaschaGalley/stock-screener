import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useArchive } from '../useArchive';
import { useSectionFinding } from '../Section';
import {
  TIMELINE_KINDS, TIMELINE_LABEL, type TimelineEvent, type TimelineKind,
} from '../../../../src/analysis/timeline';
import { KIND_DOT, TONE_MARK, TONE_TEXT } from '../timelineStyle';

const RANGES = [{ days: 90, label: '3 M' }, { days: 365, label: '1 J' }, { days: 1095, label: '3 J' }] as const;
const SPAN: Record<number, string> = { 90: 'drei Monaten', 365: 'einem Jahr', 1095: 'drei Jahren' };
/** News outnumber everything else several times over; shown on request. */
const DEFAULT_OFF: TimelineKind[] = ['news'];
/** A screen's worth; the rest is a click away. */
const PAGE = 20;


const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * What happened to the stock, in order: rating changes, insider trades, the
 * quarter's numbers, dividends, our own verdict changes, dated developments
 * from the research briefs, headlines and the days the price jumped. The
 * question a price chart raises and cannot answer — what happened then.
 */
export default function StockTimeline({ symbol }: { symbol: string }) {
  const [days, setDays] = useState<number>(365);
  const { data, error } = useArchive(() => api.getTimeline(symbol, days), [symbol, days]);
  const [off, setOff] = useState<Set<TimelineKind>>(() => new Set(DEFAULT_OFF));
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => {
    const c = new Map<TimelineKind, number>();
    for (const e of data?.events ?? []) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [data]);
  const shown = (data?.events ?? []).filter((e) => !off.has(e.kind));
  // Own notes are the journal tab's; the header names the newest of the rest.
  const newest = shown.filter((e) => e.kind !== 'journal').reduce<TimelineEvent | null>((n, e) => (!n || e.day > n.day ? e : n), null);
  useSectionFinding(data ? [
    `${shown.length} Ereignisse in ${SPAN[days] ?? `${days} Tagen`}`,
    newest && `zuletzt ${fmtDay(newest.day).slice(0, -4)} ${newest.title}`,
  ].filter(Boolean).join(' · ') : null);

  const toggle = (k: TimelineKind) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="space-y-3">
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
        <div className="ml-auto flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => { setDays(r.days); setLimit(PAGE); }}
              className={`rounded px-2 py-0.5 text-xs ${days === r.days ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:bg-ink-800'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400">Nicht verfügbar: {error}</p>}
      {data === undefined && <p className="text-xs text-ink-500">Lade Zeitleiste …</p>}
      {data && data.upcoming.length > 0 && (
        <div className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-xs text-ink-300">
          <span className="text-2xs uppercase tracking-wider text-ink-500">Demnächst · </span>
          {data.upcoming.map((e) => `${e.title} am ${fmtDay(e.day)}`).join(' · ')}
        </div>
      )}
      {data && shown.length === 0 && <p className="text-xs text-ink-500">Keine Ereignisse im gewählten Zeitraum.</p>}
      {data && <Grouped events={shown.slice(0, limit)} />}
      {data && shown.length > limit && (
        <button onClick={() => setLimit((l) => l + PAGE)} className="text-xs text-ink-400 hover:text-ink-100">
          + {shown.length - limit} weitere
        </button>
      )}
    </div>
  );
}

function fmtDay(day: string): string {
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;
}

function Grouped({ events }: { events: TimelineEvent[] }) {
  const groups: { month: string; events: TimelineEvent[] }[] = [];
  for (const e of events) {
    const month = e.day.slice(0, 7);
    const g = groups[groups.length - 1];
    if (g && g.month === month) g.events.push(e); else groups.push({ month, events: [e] });
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.month}>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">
            {MONTHS[Number(g.month.slice(5, 7)) - 1]} {g.month.slice(0, 4)}
          </div>
          <ul className="space-y-1 border-l border-ink-800 pl-3">
            {g.events.map((e, i) => (
              <li key={i} className="relative flex gap-2 text-xs leading-snug">
                <span className={`absolute -left-[15.5px] top-1.5 h-1.5 w-1.5 rounded-full ${KIND_DOT[e.kind]}`} />
                <span className="w-9 shrink-0 font-mono text-xs text-ink-500">{e.day.slice(8, 10)}.{e.day.slice(5, 7)}.</span>
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
        </div>
      ))}
    </div>
  );
}
