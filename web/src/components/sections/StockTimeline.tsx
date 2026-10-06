import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useArchive } from '../useArchive';
import { useSectionFinding } from '../Section';
import ReactECharts from '../charts/ECharts';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import { useMoney } from '../../currency';
import {
  TIMELINE_KINDS, TIMELINE_LABEL, type TimelineEvent, type TimelineKind,
} from '../../../../src/analysis/timeline';
import type { ChartBar } from '../../../../src/analysis/chart';
import { KIND_DOT, KIND_HEX, KIND_SHORT, KIND_TAG, TONE_MARK, TONE_TEXT } from '../timelineStyle';

const RANGES = [{ days: 90, label: '3 M' }, { days: 365, label: '1 J' }, { days: 1095, label: '3 J' }] as const;
const SPAN: Record<number, string> = { 90: 'drei Monaten', 365: 'einem Jahr', 1095: 'drei Jahren' };
/** News outnumber everything else several times over; shown on request. */
const DEFAULT_OFF: TimelineKind[] = ['news'];
/** Days shown before "weitere Tage": a screen's worth. */
const PAGE = 12;
/** Events of one kind on one day beyond this are folded into "+ N weitere". */
const SAME_DAY = 2;

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAY = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const fmtDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;

/**
 * What happened to the stock, and what the price did around it.
 *
 * It was a list of log lines — a date, a mark, "NEWSTEAD JENNIFER (General
 * Counsel): Verkauf — 12000 Aktien · $3.2M" — a hundred of them, with nothing
 * to say which mattered. The price is drawn first now, with every event as a
 * mark on the day it happened, so a downgrade before a fall or a report
 * before a jump is seen rather than looked up. Under it the days, each with
 * its events tagged by kind, title over detail, and a run of one kind on one
 * day folded.
 */
export default function StockTimeline({ symbol }: { symbol: string }) {
  const [days, setDays] = useState<number>(365);
  const { data, error } = useArchive(() => api.getTimeline(symbol, days), [symbol, days]);
  const bars = useArchive(() => api.getChart(symbol).then((r) => ({ data: r.bars })), [symbol]).data ?? null;
  const [off, setOff] = useState<Set<TimelineKind>>(() => new Set(DEFAULT_OFF));
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => {
    const c = new Map<TimelineKind, number>();
    for (const e of data?.events ?? []) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [data]);
  const shown = useMemo(() => (data?.events ?? []).filter((e) => !off.has(e.kind)), [data, off]);
  const byDay = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>();
    for (const e of shown) m.set(e.day, [...(m.get(e.day) ?? []), e]);
    return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [shown]);

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {TIMELINE_KINDS.filter((k) => counts.has(k)).map((k) => (
          <button
            key={k}
            onClick={() => toggle(k)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
              off.has(k) ? 'border-ink-800 text-ink-600' : 'border-ink-700 bg-ink-950 text-ink-200'
            }`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${off.has(k) ? 'bg-ink-700' : KIND_DOT[k]}`} />
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
        <div className="rounded border border-ink-800 bg-ink-950 px-3 py-2 text-sm text-ink-300">
          <span className="text-xs font-semibold text-ink-400">Demnächst: </span>
          {data.upcoming.map((e) => `${e.title} am ${fmtDay(e.day)}`).join(' · ')}
        </div>
      )}

      {data && bars && bars.length > 1 && <EventChart bars={bars} days={byDay} from={data.from} />}

      {data && shown.length === 0 && <p className="text-sm text-ink-500">Keine Ereignisse im gewählten Zeitraum.</p>}
      {data && <DayList days={byDay.slice(0, limit)} />}
      {data && byDay.length > limit && (
        <button onClick={() => setLimit((l) => l + PAGE)} className="text-xs text-ink-400 hover:text-ink-100">
          + {byDay.length - limit} weitere Tage
        </button>
      )}
    </div>
  );
}

/**
 * The price over the timeline's window, every day with events marked on it —
 * one mark per kind, in the kind's colour; the tooltip names the events.
 */
function EventChart({ bars, days, from }: { bars: ChartBar[]; days: [string, TimelineEvent[]][]; from: string }) {
  const { fmtPrice } = useMoney();
  const option = useMemo(() => {
    const shown = bars.filter((b) => b.day >= from);
    const index = new Map(shown.map((b, k) => [b.day, k]));
    // An event on a weekend or holiday is marked on the next trading day.
    const at = (day: string) => {
      if (index.has(day)) return index.get(day)!;
      const k = shown.findIndex((b) => b.day > day);
      return k === -1 ? null : k;
    };
    const kinds = [...new Set(days.flatMap(([, es]) => es.map((e) => e.kind)))];
    const marks = (kind: TimelineKind) => {
      const pts: (number | null)[] = shown.map(() => null);
      const titles = new Map<number, string[]>();
      for (const [day, es] of days) {
        const mine = es.filter((e) => e.kind === kind);
        const k = at(day);
        if (!mine.length || k === null) continue;
        pts[k] = shown[k].close;
        titles.set(k, [...(titles.get(k) ?? []), ...mine.map((e) => e.title)]);
      }
      return { pts, titles };
    };
    const series = kinds.map((kind) => {
      const { pts } = marks(kind);
      return {
        name: KIND_SHORT[kind], type: 'scatter', data: pts, symbolSize: 9, z: 3,
        itemStyle: { color: KIND_HEX[kind], borderColor: CHART_COLORS.bg, borderWidth: 1 },
      };
    });
    const titlesAt = new Map<number, { kind: TimelineKind; titles: string[] }[]>();
    for (const kind of kinds) {
      for (const [k, t] of marks(kind).titles) titlesAt.set(k, [...(titlesAt.get(k) ?? []), { kind, titles: t }]);
    }
    return {
      animation: false,
      textStyle: baseTextStyle,
      grid: { top: 12, left: 8, right: 64, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: CHART_COLORS.ink } },
        backgroundColor: CHART_COLORS.bg,
        borderColor: CHART_COLORS.grid,
        textStyle: { color: CHART_COLORS.text, fontSize: 12 },
        extraCssText: 'max-width: 360px; white-space: normal;',
        formatter: (items: { dataIndex: number }[]) => {
          const k = items[0]?.dataIndex ?? 0;
          const b = shown[k];
          if (!b) return '';
          const d = new Date(`${b.day}T00:00:00Z`);
          const head = `<b>${WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()}. ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}</b> · ${fmtPrice(b.close)}`;
          const evs = (titlesAt.get(k) ?? []).flatMap(({ kind, titles }) =>
            titles.slice(0, 3).map((t) => `<span style="color:${KIND_HEX[kind]}">●</span> ${t}`));
          return [head, ...evs].join('<br/>');
        },
      },
      xAxis: {
        type: 'category', data: shown.map((b) => b.day), boundaryGap: false,
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}` },
        axisLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      yAxis: {
        type: 'value', scale: true, position: 'right',
        axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
        splitLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      series: [
        {
          name: 'Kurs', type: 'line', data: shown.map((b) => b.close), showSymbol: false,
          lineStyle: { color: CHART_COLORS.text, width: 1.4 }, itemStyle: { color: CHART_COLORS.text }, z: 2,
        },
        ...series,
      ],
    };
  }, [bars, days, from, fmtPrice]);

  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 240 }}>
      <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
    </div>
  );
}

/** The days, newest first, under their month: a date, then each event as a tag, a title and its detail. */
function DayList({ days }: { days: [string, TimelineEvent[]][] }) {
  const months: { month: string; days: [string, TimelineEvent[]][] }[] = [];
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
            {g.days.map(([day, es]) => <Day key={day} day={day} events={es} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Day({ day, events }: { day: string; events: TimelineEvent[] }) {
  const [open, setOpen] = useState(false);
  const d = new Date(`${day}T00:00:00Z`);
  // A run of one kind on one day — five analysts after a report — folds after the first two.
  const byKind = new Map<TimelineKind, TimelineEvent[]>();
  for (const e of events) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  const hidden = [...byKind.values()].reduce((n, es) => n + Math.max(0, es.length - SAME_DAY), 0);
  const visible = open ? events : [...byKind.values()].flatMap((es) => es.slice(0, SAME_DAY));
  return (
    <li className="flex gap-4 px-3 py-2.5">
      <div className="w-16 shrink-0 text-right">
        <div className="whitespace-nowrap font-mono text-sm text-ink-200">{d.getUTCDate()}. {MON[d.getUTCMonth()]}</div>
        <div className="text-2xs text-ink-500">{WEEKDAY[d.getUTCDay()]}</div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {visible.map((e, i) => (
          <div key={i} className="flex items-start gap-2">
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
