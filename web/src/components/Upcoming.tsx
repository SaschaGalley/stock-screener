import { useState } from 'react';
import Tip from './Tip';
import { KIND_DOT } from './timelineStyle';
import { TIMELINE_LABEL, type TimelineKind } from '../../../src/analysis/timeline';

/** One date ahead: a stock's — a report, a dividend, a catalyst — or the market's. */
export interface UpcomingItem {
  day:     string;
  /** Null for the market's own dates. */
  symbol:  string | null;
  name?:   string | null;
  kind:    TimelineKind | 'market';
  title:   string;
  detail?: string | null;
}

const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const shortDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
};
const inDays = (day: string) => {
  const n = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)) / 86_400_000);
  return n === 0 ? 'heute' : n === 1 ? 'morgen' : `in ${n} Tagen`;
};

/**
 * What is coming, by day: each stock's dates with its ticker in front, the
 * market's with „Markt“, what to watch after a dash. The first days show, the
 * rest on request — a month of a watchlist is long.
 */
export default function Upcoming({ items, onSelect, first = 12 }: {
  items: UpcomingItem[]; onSelect?: (symbol: string) => void; first?: number;
}) {
  const [all, setAll] = useState(false);
  const sorted = [...items].sort((a, b) => a.day.localeCompare(b.day) || (a.symbol ?? '').localeCompare(b.symbol ?? ''));
  const shown = all ? sorted : sorted.slice(0, first);
  const days = [...new Set(shown.map((x) => x.day))];
  return (
    <div>
      <ul className="space-y-1.5">
        {days.map((day) => (
          <li key={day} className="flex gap-3">
            <Tip focusable={false} content={inDays(day)}>
              <span className="w-16 shrink-0 font-mono text-xs leading-5 text-ink-500">{shortDay(day)}</span>
            </Tip>
            <ul className="min-w-0 flex-1 space-y-0.5">
              {shown.filter((x) => x.day === day).map((x, k) => (
                <li key={k} className="flex min-w-0 items-start gap-2 text-xs leading-5">
                  {x.symbol ? (
                    <Tip focusable={false} content={x.name ?? x.symbol}>
                      <button
                        onClick={onSelect ? () => onSelect(x.symbol!) : undefined}
                        className="w-16 shrink-0 truncate rounded border border-ink-700 px-1.5 text-left font-mono text-ink-200 transition hover:border-accent hover:text-accent"
                      >
                        {x.symbol}
                      </button>
                    </Tip>
                  ) : (
                    <span className="w-16 shrink-0 rounded border border-ink-800 px-1.5 text-ink-400">Markt</span>
                  )}
                  <Tip focusable={false} content={x.kind === 'market' ? 'Markttermin aus der Marktlage' : TIMELINE_LABEL[x.kind]}>
                    <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${x.kind === 'market' ? 'bg-ink-400' : KIND_DOT[x.kind]}`} />
                  </Tip>
                  {/* German runs long: "Bewertungsmultiplikatoren" is wider than a phone's column. */}
                  <span className="min-w-0 text-ink-200 hyphens-auto [overflow-wrap:anywhere]">
                    {x.title}{x.detail && <span className="text-ink-500"> — {x.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {sorted.length > first && (
        <button onClick={() => setAll(!all)} className="mt-2 text-xs text-ink-400 hover:text-ink-100">
          {all ? 'weniger' : `alle ${sorted.length} zeigen`}
        </button>
      )}
    </div>
  );
}
