import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Page from '../components/Page';
import Tip from '../components/Tip';
import EventDays, { groupByDay } from '../components/EventDays';
import ReactECharts from '../components/charts/ECharts';
import { CHART_COLORS, baseTextStyle } from '../components/charts/chartTheme';
import { KIND_DOT, KIND_HEX, KIND_SHORT } from '../components/timelineStyle';
import { SearchIcon } from '../components/icons';
import {
  TIMELINE_KINDS, TIMELINE_LABEL, type TimelineKind,
} from '../../../src/analysis/timeline';
import type { FeedEvent, FeedPage as Page_ } from '../../../src/stock-history-service';

const RANGES = [
  { days: 1, label: 'Heute' }, { days: 7, label: '7 Tage' }, { days: 30, label: '30 Tage' }, { days: 90, label: '90 Tage' },
] as const;
const SPAN: Record<number, string> = { 1: 'seit gestern', 7: 'in 7 Tagen', 30: 'in 30 Tagen', 90: 'in 90 Tagen' };
/** Headlines outnumber everything else several times over; shown on request. */
const DEFAULT_OFF: TimelineKind[] = ['news'];
const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const shortDay = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
};

/**
 * What happened across the watchlist: every stock's timeline over the last
 * days on one axis — rating changes, insider trades, the quarter's numbers,
 * our own verdict changes, the days a price jumped — and the reports due in
 * the next two weeks. The question the list raises each morning.
 *
 * It read like a log: one line per event, a dot, a ticker, a title and its
 * detail run together, and the whole window at once — thirty days with the
 * news were thousands of lines. It reads like a stock's own timeline now —
 * the days under their months, each event tagged by kind with its stock in
 * front — over a chart of how much happened when; and it comes a page at a
 * time, searched and filtered on the server.
 */
export default function FeedPage({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [days, setDays] = useState(7);
  const [off, setOff] = useState<Set<TimelineKind>>(() => new Set(DEFAULT_OFF));
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page_ | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  // The search waits for a pause in the typing rather than asking on every key.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const offList = useMemo(() => [...off].sort(), [off]);
  useEffect(() => {
    let live = true;
    setError(null);
    api.getFeed({ days, off: offList, q })
      .then((p) => { if (live) { setPage(p); setEvents(p.events); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [days, offList, q]);

  async function loadMore() {
    if (!page || page.next === null || more) return;
    setMore(true);
    try {
      const p = await api.getFeed({ days, off: offList, q, offset: page.next });
      setPage(p);
      setEvents((prev) => [...prev, ...p.events]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  }

  const toggle = (k: TimelineKind) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const byDay = useMemo(() => groupByDay(events), [events]);
  const rest = page ? page.total - events.length : 0;

  return (
    <Page
      title="Ereignisse"
      subtitle={page
        ? `${page.total.toLocaleString('de-DE')} ${page.total === 1 ? 'Ereignis' : 'Ereignisse'} ${SPAN[days] ?? `in ${days} Tagen`} · ${page.symbols} Werte der Watchlist`
        : 'Was in der Watchlist passiert ist'}
      width="max-w-5xl"
      actions={RANGES.map((r) => (
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
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="relative w-full sm:w-64">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500"><SearchIcon size={14} /></span>
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Aktie oder Stichwort …"
            className="w-full rounded border border-ink-700 bg-ink-950 py-1.5 pl-8 pr-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {page && TIMELINE_KINDS.filter((k) => page.counts[k]).map((k) => (
            <button
              key={k}
              onClick={() => toggle(k)}
              aria-pressed={!off.has(k)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
                off.has(k) ? 'border-ink-800 text-ink-600' : 'border-ink-700 bg-ink-950 text-ink-200'
              }`}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${off.has(k) ? 'bg-ink-700' : KIND_DOT[k]}`} />
              {TIMELINE_LABEL[k]} <span className="font-mono text-ink-500">{page.counts[k]!.toLocaleString('de-DE')}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
      {!page && !error && <div className="p-8 text-center text-sm text-ink-500">Lese die Zeitleisten der Watchlist …</div>}

      {page && page.upcoming.length > 0 && (
        <section className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold text-ink-300">Quartalszahlen in den nächsten zwei Wochen</h3>
          <div className="flex flex-wrap gap-1.5">
            {page.upcoming.map((e) => (
              <Tip key={`${e.symbol}-${e.day}`} focusable={false} content={e.name ?? e.symbol}>
                <button
                  onClick={() => onSelect(e.symbol)}
                  className="rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-xs text-ink-300 transition hover:border-accent hover:text-ink-100"
                >
                  <span className="text-ink-500">{shortDay(e.day)}</span> <span className="font-mono text-ink-100">{e.symbol}</span>
                </button>
              </Tip>
            ))}
          </div>
        </section>
      )}

      {page && days > 1 && page.perDay.length > 0 && <PerDayChart page={page} days={days} />}

      {page && page.total === 0 && (
        <p className="text-sm text-ink-500">
          Nichts {SPAN[days] ?? `in ${days} Tagen`}{q ? ` zu „${q}“` : ''}{off.size > 0 ? ' — oder nur in ausgeblendeten Arten' : ''}.
        </p>
      )}

      <EventDays
        days={byDay}
        sameDay={3}
        lead={(e) => (
          <Tip focusable={false} content={e.name ?? e.symbol}>
            <button
              onClick={() => onSelect(e.symbol)}
              className="mt-px w-16 shrink-0 truncate rounded border border-ink-700 px-1.5 text-left font-mono text-xs text-ink-200 transition hover:border-accent hover:text-accent"
            >
              {e.symbol}
            </button>
          </Tip>
        )}
      />

      {page && page.next !== null && (
        <button
          onClick={() => void loadMore()}
          disabled={more}
          className="w-full rounded border border-dashed border-ink-700 py-2 text-sm text-ink-400 transition hover:border-ink-600 hover:text-ink-100 disabled:opacity-50"
        >
          {more ? 'Lade …' : `Weitere laden — noch ${rest.toLocaleString('de-DE')} ${rest === 1 ? 'Ereignis' : 'Ereignisse'}`}
        </button>
      )}
    </Page>
  );
}

/** How much happened on each day of the window, by kind — the shape of the list before reading it. */
function PerDayChart({ page, days }: { page: Page_; days: number }) {
  const option = useMemo(() => {
    // Every day of the window, the quiet ones too, so a gap reads as a gap.
    const axis: string[] = [];
    const end = new Date();
    for (let t = new Date(`${page.from}T12:00:00Z`); t <= end; t = new Date(t.getTime() + 86_400_000)) {
      axis.push(t.toISOString().slice(0, 10));
    }
    const at = new Map(page.perDay.map((d) => [d.day, d.counts]));
    const kinds = TIMELINE_KINDS.filter((k) => page.perDay.some((d) => d.counts[k]));
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: { top: 8, left: 8, right: 36, bottom: 22 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: CHART_COLORS.bg,
        borderColor: CHART_COLORS.grid,
        textStyle: { color: CHART_COLORS.text, fontSize: 12 },
        formatter: (items: { dataIndex: number }[]) => {
          const day = axis[items[0]?.dataIndex ?? 0];
          const c = at.get(day) ?? {};
          const lines = kinds.filter((k) => c[k]).map((k) => `<span style="color:${KIND_HEX[k]}">●</span> ${KIND_SHORT[k]} ${c[k]}`);
          return [`<b>${shortDay(day)}</b>`, ...(lines.length ? lines : ['nichts'])].join('<br/>');
        },
      },
      xAxis: {
        type: 'category', data: axis,
        axisLabel: {
          color: CHART_COLORS.ink, fontSize: 11, hideOverlap: true,
          formatter: (d: string) => `${Number(d.slice(8, 10))}. ${MON[Number(d.slice(5, 7)) - 1]}`,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      yAxis: {
        type: 'value', position: 'right', minInterval: 1,
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      series: kinds.map((k) => ({
        name: KIND_SHORT[k], type: 'bar', stack: 'day', barMaxWidth: days > 30 ? 8 : 18,
        data: axis.map((d) => at.get(d)?.[k] ?? 0),
        itemStyle: { color: KIND_HEX[k] },
      })),
    };
  }, [page, days]);
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 150 }}>
      <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
    </div>
  );
}
