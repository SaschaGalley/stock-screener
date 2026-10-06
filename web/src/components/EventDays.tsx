import { useState, type ReactNode } from 'react';
import type { TimelineEvent, TimelineKind } from '../../../src/analysis/timeline';
import { KIND_SHORT, KIND_TAG, TONE_MARK, TONE_TEXT } from './timelineStyle';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Events by day, newest day first, each day's events in the order given. */
export function groupByDay<T extends TimelineEvent>(events: readonly T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const e of events) m.set(e.day, [...(m.get(e.day) ?? []), e]);
  return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
}

/**
 * The days, newest first, under their month: a date, then each event as a
 * tag, a title and its detail. One stock's timeline and the watchlist's
 * events read the same; the watchlist puts the stock in front (`lead`).
 */
export default function EventDays<T extends TimelineEvent>({ days, lead, sameDay = 2 }: {
  days: [string, T[]][];
  /** What goes before an event's tag — the stock it belongs to, in the watchlist's list. */
  lead?: (e: T) => ReactNode;
  /** Events of one kind on one day beyond this fold into "+ N weitere". */
  sameDay?: number;
}) {
  const months: { month: string; days: [string, T[]][] }[] = [];
  for (const d of days) {
    const month = d[0].slice(0, 7);
    const g = months[months.length - 1];
    if (g && g.month === month) g.days.push(d); else months.push({ month, days: [d] });
  }
  return (
    <div className="space-y-5">
      {months.map((g) => (
        <div key={g.month}>
          <h4 className="mb-2 text-xs font-semibold text-ink-300">{MONTHS[Number(g.month.slice(5, 7)) - 1]} {g.month.slice(0, 4)}</h4>
          <ul className="divide-y divide-ink-800 rounded border border-ink-800">
            {g.days.map(([day, es]) => <Day key={day} day={day} events={es} lead={lead} sameDay={sameDay} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Day<T extends TimelineEvent>({ day, events, lead, sameDay }: {
  day: string; events: T[]; lead?: (e: T) => ReactNode; sameDay: number;
}) {
  const [open, setOpen] = useState(false);
  const d = new Date(`${day}T00:00:00Z`);
  // A run of one kind on one day — five analysts after a report — folds after the first few.
  const byKind = new Map<TimelineKind, T[]>();
  for (const e of events) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  const hidden = [...byKind.values()].reduce((n, es) => n + Math.max(0, es.length - sameDay), 0);
  const visible = open ? events : [...byKind.values()].flatMap((es) => es.slice(0, sameDay));
  return (
    <li className="flex gap-4 px-3 py-2.5">
      <div className="w-16 shrink-0 text-right">
        <div className="whitespace-nowrap font-mono text-sm text-ink-200">{d.getUTCDate()}. {MON[d.getUTCMonth()]}</div>
        <div className="text-2xs text-ink-500">{WEEKDAY[d.getUTCDay()]}</div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {visible.map((e, i) => (
          <div key={i} className="flex items-start gap-2">
            {lead?.(e)}
            <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-2xs font-semibold ${KIND_TAG[e.kind]}`}>{KIND_SHORT[e.kind]}</span>
            <div className="min-w-0">
              <div className="text-sm leading-snug text-ink-100">
                {e.tone !== 'neutral' && <span className={`mr-1 ${TONE_TEXT[e.tone]}`}>{TONE_MARK[e.tone]}</span>}
                {e.url
                  ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:underline">{e.title}</a>
                  : e.title}
              </div>
              {e.detail && <div className="text-xs text-ink-500">{e.detail}</div>}
            </div>
          </div>
        ))}
        {hidden > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="text-xs text-ink-400 hover:text-ink-100">
            {open ? 'weniger' : `+ ${hidden} weitere an diesem Tag`}
          </button>
        )}
      </div>
    </li>
  );
}
