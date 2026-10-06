import type { ReactNode } from 'react';
import { api } from '../api';
import { useMoney } from '../currency';
import type { ComputedMetrics, ScoreCard, StockFinancials } from '../types';
import type { SectorMedians } from '../../../src/types';
import type { ChartAnalysis, ChartResponse } from '../../../src/analysis/chart';
import type { TimelineEvent } from '../../../src/analysis/timeline';
import { useArchive } from './useArchive';
import { KIND_DOT, TONE_MARK, TONE_TEXT } from './timelineStyle';
import type { StockTab } from './StockTabs';

/**
 * One card per topic at the top of the stock page: what the topic says, in a
 * sentence the numbers decide, two to four figures, and a click to the tab
 * with the rest. The page is read from here down; a tab is opened only for
 * what the card made worth a look.
 */

type Tone = 'bull' | 'bear' | 'neutral';

const TONE_DOT: Record<Tone, string> = { bull: 'bg-emerald-500', bear: 'bg-red-500', neutral: 'bg-ink-500' };

const de = (x: number, d = 1) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`);
const share = (x: number | null | undefined, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${de(x * 100, d)} %`);
const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;
const DAY_MS = 86_400_000;

interface Props {
  symbol:   string;
  f:        StockFinancials;
  m:        ComputedMetrics;
  sector:   SectorMedians | null;
  card:     ScoreCard | null;
  onTab:    (tab: StockTab) => void;
}

export default function OverviewCards({ symbol, f, m, sector, card, onTab }: Props) {
  const chart = useArchive<ChartResponse>(() => api.getChart(symbol).then((r) => ({ data: r })), [symbol]).data;
  const timeline = useArchive(() => api.getTimeline(symbol, 90), [symbol]).data;
  const pillar = (key: string) => card?.factor.pillars.find((p) => p.key === key)?.score ?? null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <ChartCard a={chart === undefined ? undefined : chart?.analysis ?? null} bars={chart?.bars ?? []} onTab={onTab} />
      <ValuationCard f={f} m={m} sector={sector} pillar={pillar('valuation')} onTab={onTab} />
      <BusinessCard f={f} sector={sector} quality={pillar('quality')} health={pillar('health')} onTab={onTab} />
      <OwnersCard f={f} onTab={onTab} />
      <EventsCard events={timeline === undefined ? undefined : timeline?.events ?? []} upcoming={timeline?.upcoming ?? []} onTab={onTab} />
    </div>
  );
}

function TopicCard({ tab, label, headline, tone, children, onTab, className = '' }: {
  tab: StockTab; label: string; headline: ReactNode; tone: Tone; children: ReactNode; onTab: (t: StockTab) => void; className?: string;
}) {
  return (
    <button
      onClick={() => onTab(tab)}
      className={`group flex flex-col rounded-lg border border-ink-700 bg-ink-900 p-3 text-left transition hover:border-ink-600 hover:bg-ink-800 ${className}`}
    >
      <div className="flex items-center justify-between text-xs font-semibold text-ink-400">{label}<span className="font-normal text-accent opacity-0 transition group-hover:opacity-100">Details →</span></div>
      <div className="mt-1.5 flex gap-2 text-base font-semibold leading-snug text-ink-50">
        <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        <span>{headline}</span>
      </div>
      <div className="mt-3 flex-1 text-sm text-ink-400">{children}</div>
    </button>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-500">{k}</dt>
          <dd className="text-right font-mono text-ink-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────

const TREND = { up: 'Aufwärtstrend', down: 'Abwärtstrend', sideways: 'Seitwärts' } as const;

function ChartCard({ a, bars, onTab }: { a: ChartAnalysis | null | undefined; bars: ChartResponse['bars']; onTab: (t: StockTab) => void }) {
  if (a === undefined) return <TopicCard tab="chart" label="Chart" headline="…" tone="neutral" onTab={onTab}>Lade Kursdaten …</TopicCard>;
  if (a === null) return <TopicCard tab="chart" label="Chart" headline="Zu wenige Kurse" tone="neutral" onTab={onTab}>Für eine Chartanalyse fehlen die Tageskurse.</TopicCard>;
  const q = a.channels.find((c) => c.sessions === 63);
  const where = !q ? '' : q.z <= -1 ? ', unten im Kanal' : q.z >= 1 ? ', oben im Kanal' : ', Mitte des Kanals';
  const sup = a.levels.filter((l) => l.kind === 'support')[0];
  const res = a.levels.filter((l) => l.kind === 'resistance').at(-1);
  return (
    <TopicCard
      tab="chart" label="Chart" onTab={onTab} className="sm:col-span-2"
      tone={a.structure.trend === 'up' ? 'bull' : a.structure.trend === 'down' ? 'bear' : 'neutral'}
      headline={`${TREND[a.structure.trend]}${where}`}
    >
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[3fr_2fr]">
      <Spark closes={bars.slice(-126).map((b) => b.close)} support={sup?.price ?? null} resistance={res?.price ?? null} />
      <Facts rows={[
        ['Widerstand', res ? `${de(res.price, 2)} (${pct(res.distance)})` : '—'],
        ['Unterstützung', sup ? `${de(sup.price, 2)} (${pct(sup.distance)})` : '—'],
        ['RSI 14', a.rsi14 !== null ? de(a.rsi14, 0) : '—'],
        ['vs. SMA 200', a.ma.sma200 !== null ? pct(a.close / a.ma.sma200 - 1) : '—'],
      ]} />
      </div>
    </TopicCard>
  );
}

/** Half a year of closes, with the nearest support and resistance as dashed lines. */
function Spark({ closes, support, resistance }: { closes: number[]; support: number | null; resistance: number | null }) {
  if (closes.length < 2) return null;
  const W = 200, H = 44;
  const lo = Math.min(...closes, support ?? Infinity), hi = Math.max(...closes, resistance ?? -Infinity);
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
  const pts = closes.map((c, k) => `${(k / (closes.length - 1)) * W},${y(c).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full" aria-hidden>
      {resistance !== null && <line x1={0} x2={W} y1={y(resistance)} y2={y(resistance)} stroke="var(--color-danger)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      {support !== null && <line x1={0} x2={W} y1={y(support)} y2={y(support)} stroke="var(--color-success)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      <polyline points={pts} fill="none" stroke="var(--color-text)" strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── Valuation ────────────────────────────────────────────────────────────────

/** Within this of the fair value the price is fair; the models are not finer than that. */
const FAIR_BAND = 0.1;

function ValuationCard({ f, m, sector, pillar, onTab }: {
  f: StockFinancials; m: ComputedMetrics; sector: SectorMedians | null; pillar: number | null; onTab: (t: StockTab) => void;
}) {
  const { fmtPrice } = useMoney();
  const t = m.composite.primary;
  const mos = t.marginOfSafety;
  const headline = mos === null ? 'Kein fairer Wert'
    : Math.abs(mos) <= FAIR_BAND ? 'Fair bewertet'
    : mos > 0 ? `Unterbewertet: fairer Wert ${pct(mos, 0)}`
    : `Überbewertet: fairer Wert ${pct(mos, 0)}`;
  const pe = m.ratios.pe, sectorPe = sector?.pe ?? null;
  const ev = m.evMultiples.evToEbitda, sectorEv = sector?.evToEbitda ?? null;
  return (
    <TopicCard
      tab="valuation" label="Bewertung" onTab={onTab} headline={headline}
      tone={mos === null || Math.abs(mos) <= FAIR_BAND ? 'neutral' : mos > 0 ? 'bull' : 'bear'}
    >
      <RangeBar price={f.price} t={t} />
      <Facts rows={[
        ['Fairer Wert', t.median !== null ? fmtPrice(t.median) : '—'],
        ['KGV · Branche', `${pe !== null ? de(pe, 1) : '—'} · ${sectorPe !== null ? de(sectorPe, 1) : '—'}`],
        ['EV/EBITDA · Branche', `${ev !== null ? de(ev, 1) : '—'} · ${sectorEv !== null ? de(sectorEv, 1) : '—'}`],
        ...(pillar !== null ? [['Säule Bewertung', `${de(pillar, 1)}/10`] as [string, string]] : []),
      ]} />
    </TopicCard>
  );
}

/** The models' middle half as a band, their full spread as a line, the price as a tick. */
function RangeBar({ price, t }: { price: number; t: ComputedMetrics['composite']['primary'] }) {
  if (t.min === null || t.max === null || t.p25 === null || t.p75 === null || !(price > 0)) return null;
  const lo = Math.min(t.min, price), hi = Math.max(t.max, price);
  const x = (v: number) => `${((v - lo) / (hi - lo || 1)) * 100}%`;
  return (
    <div className="relative mb-3 mt-1 h-2.5">
      <div className="absolute inset-y-1 rounded bg-ink-800" style={{ left: x(t.min), right: `calc(100% - ${x(t.max)})` }} />
      <div className="absolute inset-y-0 rounded bg-emerald-900" style={{ left: x(t.p25), right: `calc(100% - ${x(t.p75)})` }} />
      <div className="absolute -inset-y-1 w-0.5 bg-ink-50" style={{ left: x(price) }} title="Kurs" />
    </div>
  );
}

// ── Business ─────────────────────────────────────────────────────────────────

const level = (s: number | null, high: string, low: string) => (s === null ? null : s >= 6.5 ? high : s <= 3.5 ? low : 'mittel');

function BusinessCard({ f, sector, quality, health, onTab }: {
  f: StockFinancials; sector: SectorMedians | null; quality: number | null; health: number | null; onTab: (t: StockTab) => void;
}) {
  const q = level(quality, 'hoch', 'schwach');
  const h = level(health, 'solide', 'angespannt');
  const headline = q && h ? `Qualität ${q}, Bilanz ${h}` : q ? `Qualität ${q}` : h ? `Bilanz ${h}` : 'Geschäftszahlen';
  const avg = quality !== null && health !== null ? (quality + health) / 2 : quality ?? health;
  return (
    <TopicCard
      tab="business" label="Geschäft & Zahlen" onTab={onTab} headline={headline}
      tone={avg === null ? 'neutral' : avg >= 6.5 ? 'bull' : avg <= 3.5 ? 'bear' : 'neutral'}
    >
      <Facts rows={[
        ['Umsatz', pct(f.revenueGrowth)],
        ['Op. Marge · Branche', `${share(f.operatingMargin)} · ${share(sector?.operatingMargin)}`],
        ['ROIC', share(f.roic)],
        ['Nächste Zahlen', f.nextEarningsDate ? dayDe(f.nextEarningsDate) + f.nextEarningsDate.slice(2, 4) : '—'],
      ]} />
    </TopicCard>
  );
}

// ── Owners ───────────────────────────────────────────────────────────────────

function OwnersCard({ f, onTab }: { f: StockFinancials; onTab: (t: StockTab) => void }) {
  const buy = f.insiderBuyValue ?? 0, sell = f.insiderSellValue ?? 0;
  const short = f.shortPercentOfFloat;
  const crowdedShort = short !== null && short >= 0.1;
  const insiders = (f.insiderBuyCount ?? 0) > 0 && buy > sell ? 'Insider kaufen netto'
    : sell > 0 ? 'Insider verkaufen' : 'Keine Insider-Geschäfte';
  const { fmtBig } = useMoney();
  return (
    <TopicCard
      tab="analysts" label="Analysten & Eigentümer" onTab={onTab}
      headline={`${insiders}${crowdedShort ? ', viele Leerverkäufer' : ''}`}
      tone={crowdedShort ? 'bear' : (f.insiderBuyCount ?? 0) > 0 && buy > sell ? 'bull' : 'neutral'}
    >
      <Facts rows={[
        ['Insider 6 M', `+${fmtBig(buy)} / −${fmtBig(sell)}`],
        ['Institutionen', share(f.institutionsPercentHeld)],
        ['Leerverkauft', share(short, 1)],
        ['Analysten', f.analystCount ? `${f.analystCount}` : '—'],
      ]} />
    </TopicCard>
  );
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Own notes have a tab of their own, and headlines outnumber everything else; both stay out of the card. */
const QUIET: TimelineEvent['kind'][] = ['journal', 'news'];

function EventsCard({ events, upcoming, onTab }: { events: TimelineEvent[] | undefined; upcoming: TimelineEvent[]; onTab: (t: StockTab) => void }) {
  if (events === undefined) return <TopicCard tab="history" label="Zuletzt passiert" headline="…" tone="neutral" onTab={onTab}>Lade Ereignisse …</TopicCard>;
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const recent = events.filter((e) => e.day >= since && !QUIET.includes(e.kind)).sort((a, b) => b.day.localeCompare(a.day));
  const next = upcoming[0];
  return (
    <TopicCard
      tab="history" label="Zuletzt passiert" onTab={onTab} tone="neutral"
      headline={recent.length === 0 ? 'Ruhige 30 Tage' : `${recent.length} ${recent.length === 1 ? 'Ereignis' : 'Ereignisse'} in 30 Tagen`}
    >
      <ul className="space-y-1">
        {recent.slice(0, 3).map((e, k) => (
          <li key={k} className="flex gap-1.5 leading-snug">
            <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[e.kind]}`} />
            <span className="min-w-0">
              <span className="text-ink-500">{dayDe(e.day)}</span>{' '}
              <span className={TONE_TEXT[e.tone]}>{TONE_MARK[e.tone]}</span>{' '}
              <span className="text-ink-300">{e.title}</span>
            </span>
          </li>
        ))}
      </ul>
      {next && <div className="mt-1.5 text-ink-500">Als Nächstes: {dayDe(next.day)} {next.title}</div>}
    </TopicCard>
  );
}
