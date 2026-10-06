import { useEffect, useMemo, useState } from 'react';
import ReactECharts from '../charts/ECharts';
import { useSectionFinding } from '../Section';
import { api } from '../../api';
import { useMoney } from '../../currency';
import { deNumber, fmt, fmtPct, fmtSignedPct } from '../../format';
import { CHART_COLORS, baseTextStyle } from '../charts/chartTheme';
import {
  HISTORY_MULTIPLES, discountRange, growthVsPrice, multipleStats, normalPE,
  type HistoryMultiple, type SectorMultiples, type ValuationHistory as History,
} from '../../../../src/analysis/valuation-history';
import type { FairRatio } from '../../../../src/analysis/fair-ratio';
import Tip from '../Tip';
import Term from '../Term';
import { HISTORY_MULTIPLE_TERMS, type GlossaryKey } from '../../glossary';

type FairRatios = Partial<Record<HistoryMultiple, FairRatio>>;

type View = 'fair' | 'earnings' | 'multiples';

interface Props {
  symbol: string;
  /** Today's headline composite, drawn as its own point beside the rebuilt line. */
  liveFairValue: number | null;
}

/**
 * The last five years, month-end by month-end — the one thing a single day's
 * numbers cannot say: whether today is unusual for this stock.
 *
 * Three readings of one series. Fair value against price, with the range the
 * gap usually sat in. Price against earnings times the P/E the stock normally
 * carries, the FAST-Graphs picture of whether the price follows the earnings.
 * And each multiple against its own three- and five-year median, which is the
 * comparison a peer median cannot make: a quality company is always dearer
 * than its sector, and the question is whether it is dearer than itself.
 */
export default function ValuationHistory({ symbol, liveFairValue }: Props) {
  const [history, setHistory] = useState<History | null | undefined>(undefined);
  const [sector, setSector] = useState<SectorMultiples | null>(null);
  const [fair, setFair] = useState<FairRatios>({});
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('fair');

  useEffect(() => {
    let live = true;
    setHistory(undefined);
    setError(null);
    api.getValuationHistory(symbol)
      .then((r) => { if (live) { setHistory(r.history); setSector(r.sector); setFair(r.fair ?? {}); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [symbol]);

  // The header's line: today's first multiple with a history, against its own five years.
  useSectionFinding(history ? historyFinding(history) : null);

  // A series without a fair value opens on the earnings view instead of a
  // disabled tab.
  useEffect(() => {
    if (history && history.source !== 'sec' && view === 'fair') setView('earnings');
  }, [history, view]);

  if (error) return <p className="text-xs text-red-400">Historie nicht verfügbar: {error}</p>;
  if (history === undefined) {
    return (
      <p className="text-xs text-ink-500">
        Rekonstruiere fünf Jahre Monat für Monat … beim ersten Öffnen am Tag dauert das einige Sekunden.
      </p>
    );
  }
  if (history === null || history.points.length < 12) {
    return <p className="text-xs text-ink-500">Für diesen Wert lässt sich keine Kurshistorie rekonstruieren.</p>;
  }

  const views: { key: View; label: string; term: GlossaryKey; disabled?: string }[] = [
    { key: 'fair', label: 'Fair Value vs. Kurs', term: 'concept.vh.fair', disabled: history.source !== 'sec' ? 'Nur für Werte mit SEC-Filings' : undefined },
    { key: 'earnings', label: 'Kurs vs. Gewinn', term: 'concept.vh.earnings' },
    { key: 'multiples', label: 'Multiples', term: 'concept.vh.multiples' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1">
        {views.map((v) => (
          <button
            key={v.key}
            disabled={!!v.disabled}
            title={v.disabled}
            onClick={() => setView(v.key)}
            className={`rounded border px-2.5 py-1 text-xs transition ${
              view === v.key
                ? 'border-accent bg-accent-soft text-ink-100'
                : v.disabled
                  ? 'cursor-not-allowed border-ink-800 bg-ink-950 text-ink-600'
                  : 'border-ink-700 bg-ink-950 text-ink-400 hover:bg-ink-800'
            }`}
          >
            <Term k={v.term} extra={v.disabled} focusable={false}>{v.label}</Term>
          </button>
        ))}
      </div>

      {view === 'fair' && <FairValueView history={history} liveFairValue={liveFairValue} />}
      {view === 'earnings' && <EarningsView history={history} />}
      {view === 'multiples' && <MultiplesView history={history} />}

      <FairLede fair={fair} />
      <MultiplesTable history={history} sector={sector} fair={fair} />

      <p className="text-xs leading-relaxed text-ink-500">
        {history.source === 'sec'
          ? 'Jeder Monatsultimo aus den SEC-Filings rekonstruiert, die an dem Tag bekannt waren, und mit den heutigen Modellen gerechnet. '
            + 'Das Analysten-Kursziel ist aus der Rating-Historie rekonstruiert (je Haus das neueste der zwölf Monate davor). '
            + 'Peer-Multiples lassen sich für einen Wert allein nicht nachrechnen und fehlen — der rekonstruierte Fair Value weicht '
            + 'deshalb vom heutigen Headline-Wert ab, ist aber über alle Monate gleich gerechnet.'
          : 'Ohne SEC-Filings: aus den von Yahoo gemeldeten Geschäftsjahren, jedes ab einem Quartal nach Jahresende. '
            + 'Für einen rekonstruierten Fair Value reicht das nicht.'}
      </p>
    </div>
  );
}

// ── Shared chart scaffolding ─────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monthLabel = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(2, 4)}`;

function baseOption(dates: string[], yFormatter: (v: number) => string) {
  return {
    grid: { top: 32, left: 56, right: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: CHART_COLORS.bg,
      borderColor: CHART_COLORS.grid,
      textStyle: { color: CHART_COLORS.text, fontSize: 13 },
      valueFormatter: (v: unknown) => (typeof v === 'number' ? yFormatter(v) : '—'),
    },
    legend: { textStyle: { color: CHART_COLORS.text, fontSize: 12 }, top: 0, right: 8 },
    xAxis: {
      type: 'category',
      data: dates.map(monthLabel),
      axisLabel: { color: CHART_COLORS.ink, fontSize: 11 },
      axisLine: { lineStyle: { color: CHART_COLORS.grid } },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: CHART_COLORS.ink, fontSize: 11, formatter: yFormatter },
      splitLine: { lineStyle: { color: CHART_COLORS.grid } },
    },
    textStyle: baseTextStyle,
  };
}

const line = (name: string, data: (number | null)[], color: string, extra: Record<string, unknown> = {}) => ({
  name, type: 'line', data, showSymbol: false, connectNulls: false,
  itemStyle: { color }, lineStyle: { color, width: 2 }, ...extra,
});

function Chart({ option }: { option: unknown }) {
  return (
    <div style={{ height: 280 }}>
      <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option as object} />
    </div>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-300">{children}</p>;
}

/** "64 % darüber" / "20 % darunter" — the margin of safety read as a position. */
/**
 * Where the price sat against the fair value, from the margin of safety
 * (fair − price) / price. The words measure from the fair value — "62 % unter
 * dem Fair Value" is a price at 38 % of it — since a margin of 164 % read as
 * "164 % darunter" puts the price below zero.
 */
const priceGap = (mos: number) => 1 / (1 + mos) - 1;

function gapWords(mos: number): string {
  const g = priceGap(mos);
  return `${Math.round(Math.abs(g) * 100)} % ${g <= 0 ? 'darunter' : 'darüber'}`;
}

// ── Views ────────────────────────────────────────────────────────────────────

function FairValueView({ history, liveFairValue }: { history: History; liveFairValue: number | null }) {
  const { fmtPrice } = useMoney();
  const pts = history.points;
  const range = discountRange(pts);
  const dates = pts.map((p) => p.date);

  const live = liveFairValue !== null
    ? [{
      name: 'Fair Value heute (live)', type: 'scatter', symbol: 'diamond', symbolSize: 11,
      data: dates.map((_, i) => (i === dates.length - 1 ? liveFairValue : null)),
      itemStyle: { color: CHART_COLORS.amber },
    }]
    : [];

  const option = {
    ...baseOption(dates, (v) => fmtPrice(v)),
    series: [
      line('Kurs', pts.map((p) => p.price), CHART_COLORS.text),
      line('Fair Value (rekonstruiert)', pts.map((p) => p.fairValue), CHART_COLORS.green),
      line('Konservativ', pts.map((p) => p.conservative), CHART_COLORS.green, { lineStyle: { color: CHART_COLORS.green, width: 1, type: 'dashed' } }),
      ...live,
    ],
  };

  return (
    <div className="space-y-2">
      {range && (
        <Lede>
          In den letzten {Math.round(range.months / 12)} Jahren notierte die Aktie meist{' '}
          <strong className="text-ink-100">{rangeWords(range.p25, range.p75)}</strong> rekonstruierten Fair Value;
          heute <strong className="text-ink-100">{gapWords(range.latest)}</strong> — {range.rank >= 0.5
            ? `günstiger als in ${Math.round(range.rank * 100)} % der Monate`
            : `teurer als in ${Math.round((1 - range.rank) * 100)} % der Monate`}.
        </Lede>
      )}
      <Chart option={option} />
    </div>
  );
}

/** The middle half of the months (margins of safety `lo` ≤ `hi`), worded by which side of fair value the price lay on. */
function rangeWords(lo: number, hi: number): string {
  const p = (x: number) => Math.round(Math.abs(priceGap(x)) * 100);
  if (lo >= 0) return `${p(lo)}–${p(hi)} % unter dem`;
  if (hi <= 0) return `${p(hi)}–${p(lo)} % über dem`;
  return `zwischen ${p(lo)} % über und ${p(hi)} % unter dem`;
}

function EarningsView({ history }: { history: History }) {
  const { fmtPrice } = useMoney();
  const pts = history.points;
  const pe = normalPE(pts);
  const dates = pts.map((p) => p.date);
  const justified = pts.map((p) => (pe !== null && p.eps !== null && p.eps > 0 ? p.eps * pe : null));
  const last = pts[pts.length - 1];
  const lastJustified = justified[justified.length - 1];
  const g = growthVsPrice(pts);

  const base = baseOption(dates, (v) => fmtPrice(v));
  const option = {
    ...base,
    tooltip: {
      ...base.tooltip,
      formatter: (items: { dataIndex: number; marker: string; seriesName: string; value: number | null }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const p = pts[i];
        const rows = items.map((it) => `${it.marker}${it.seriesName}: ${it.value == null ? '—' : fmtPrice(it.value)}`);
        return [monthLabel(p.date), ...rows, `EPS (TTM): ${p.eps == null ? '—' : fmtPrice(p.eps)}`,
          `KGV: ${fmt(p.pe, '', 1)}`].join('<br/>');
      },
    },
    series: [
      line(pe !== null ? `Gewinn × Median-KGV ${deNumber(pe, 1)}` : 'Gewinn × Median-KGV', justified, CHART_COLORS.green, {
        areaStyle: { color: CHART_COLORS.green, opacity: 0.12 },
      }),
      line('Kurs', pts.map((p) => p.price), CHART_COLORS.text),
    ],
  };

  return (
    <div className="space-y-2">
      <Lede>
        Die grüne Fläche ist der Kurs, den der jeweilige Gewinn je Aktie beim üblichen KGV der Aktie
        {pe !== null ? <> (Median {deNumber(pe, 1)})</> : null} ergäbe. Läuft der Kurs darüber, zahlt der Markt mehr als
        sonst für denselben Gewinn
        {lastJustified != null && last
          ? <> — heute <strong className="text-ink-100">{fmtSignedPct(last.price / lastJustified - 1, 0)}</strong>.</>
          : '.'}
      </Lede>
      {g && (
        <Lede>
          Über {g.years} Jahre wuchs der Gewinn je Aktie um{' '}
          <strong className="text-ink-100">{fmtSignedPct(g.epsCagr, 0)}</strong> pro Jahr, der Kurs um{' '}
          <strong className="text-ink-100">{fmtSignedPct(g.priceCagr, 0)}</strong>
          {' — '}
          {Math.abs(g.epsCagr - g.priceCagr) < 0.03
            ? 'der Kurs ist dem Gewinn gefolgt.'
            : g.priceCagr < g.epsCagr
              ? 'der Kurs hinkt dem Gewinn hinterher, die Bewertung ist gesunken.'
              : 'der Kurs ist dem Gewinn vorausgelaufen, die Bewertung ist gestiegen.'}
        </Lede>
      )}
      <Chart option={option} />
    </div>
  );
}

function MultiplesView({ history }: { history: History }) {
  const pts = history.points;
  const available = HISTORY_MULTIPLES.filter((m) => pts.some((p) => p[m.key] !== null && p[m.key]! > 0));
  const [key, setKey] = useState<HistoryMultiple>(available[0]?.key ?? 'pe');
  const stats = useMemo(() => multipleStats(pts, key), [pts, key]);
  const dates = pts.map((p) => p.date);
  const fmtX = (v: number) => fmt(v, 'x', 1);

  const flat = (v: number | null) => dates.map(() => v);
  // Capped near the top of the range rather than at its peak: ServiceNow's P/E
  // of 640 on near-zero 2021 earnings would otherwise flatten five years of
  // readings between 50 and 150 into the floor.
  const values = pts.flatMap((p) => (p[key] !== null && p[key]! > 0 ? [p[key]!] : [])).sort((a, b) => a - b);
  const p95 = values.length ? values[Math.floor((values.length - 1) * 0.95)] : null;
  const base = baseOption(dates, fmtX);
  const option = {
    ...base,
    yAxis: { ...base.yAxis, max: p95 !== null && values[values.length - 1] > p95 * 1.2 ? Math.ceil(p95 * 1.2) : undefined },
    series: [
      line(HISTORY_MULTIPLES.find((m) => m.key === key)!.label, pts.map((p) => (p[key] !== null && p[key]! > 0 ? p[key] : null)), CHART_COLORS.blue),
      line('Median 3J', flat(stats.median3), CHART_COLORS.amber, { lineStyle: { color: CHART_COLORS.amber, width: 1, type: 'dashed' } }),
      line(`Median ${Math.min(5, Math.max(1, Math.round(stats.months / 12)))}J`, flat(stats.median5), CHART_COLORS.purple, { lineStyle: { color: CHART_COLORS.purple, width: 1, type: 'dashed' } }),
    ],
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {available.map((m) => (
          <button
            key={m.key}
            onClick={() => setKey(m.key)}
            className={`rounded px-2 py-0.5 font-mono text-xs transition ${
              key === m.key ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:bg-ink-800'
            }`}
          >
            <Term k={HISTORY_MULTIPLE_TERMS[m.key]} focusable={false}>{m.label}</Term>
          </button>
        ))}
      </div>
      <Chart option={option} />
    </div>
  );
}

/**
 * Every multiple against its own past and against its industry, in one table
 * — the part of the view that should not need a click. The two comparisons
 * answer different questions: a quality company is always dearer than its
 * industry, and only its own history says whether it is dearer than usual.
 */
function MultiplesTable({ history, sector, fair }: { history: History; sector: SectorMultiples | null; fair: FairRatios }) {
  const { fmtPrice } = useMoney();
  const rows = HISTORY_MULTIPLES
    .map((m) => ({ ...m, s: multipleStats(history.points, m.key) }))
    .filter((r) => r.s.median5 !== null);
  if (rows.length === 0) return null;
  const x = (v: number | null) => fmt(v, 'x', 1);
  // Five years where the filings reach that far; an annual series starts a
  // quarter after its first fiscal year and says so.
  const span = `${Math.min(5, Math.max(1, Math.round(Math.max(...rows.map((r) => r.s.months)) / 12)))}J`;
  const hasFair = Object.keys(fair).length > 0;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">
        <Term k="concept.vh.multiplesTable">Multiples gegen Historie und Branche</Term>
      </h3>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="text-2xs uppercase tracking-wider text-ink-500">
            <th />
            <th />
            <th colSpan={5} className="border-b border-ink-800 pb-0.5 text-center font-normal">Gegen die eigene Historie</th>
            {sector && (
              <th colSpan={2} className="hidden border-b border-ink-800 pb-0.5 text-center font-normal md:table-cell">
                <Term k="concept.vh.sector">{sector.level === 'industry' ? 'Branche' : 'Sektor'} · {sector.group}</Term>
              </th>
            )}
            {hasFair && <th className="hidden border-b border-ink-800 pb-0.5 text-center font-normal md:table-cell"><Term k="concept.vh.fairRatio">Modell</Term></th>}
          </tr>
          <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal" />
            <th className="py-1 text-right font-normal">Heute</th>
            <th className="py-1 text-right font-normal"><Term k="concept.vh.median">Median 3J</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.vh.median">Median {span}</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.vh.vs">vs. {span}</Term></th>
            <th className="hidden py-1 text-right font-normal sm:table-cell"><Term k="concept.vh.rank">Teurer als</Term></th>
            <th className="py-1 text-right font-normal"><Term k="concept.vh.impliedPrice">Kurs beim {span}-Median</Term></th>
            {sector && (
              <>
                <th className="hidden py-1 text-right font-normal md:table-cell">Median</th>
                <th className="hidden py-1 text-right font-normal md:table-cell">Teurer als</th>
              </>
            )}
            {hasFair && <th className="hidden py-1 text-right font-normal md:table-cell">Fair</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, s }) => {
            const vs = s.latest !== null && s.median5 !== null ? s.latest / s.median5 - 1 : null;
            return (
              <tr key={key} className="border-b border-ink-800">
                <td className="py-1 pr-2 text-ink-400"><Term k={HISTORY_MULTIPLE_TERMS[key]}>{label}</Term></td>
                <td className="py-1 text-right font-mono text-ink-100">{x(s.latest)}</td>
                <td className="py-1 text-right font-mono text-ink-300">{x(s.median3)}</td>
                <td className="py-1 text-right font-mono text-ink-300">{x(s.median5)}</td>
                {/* Dearer than usual is the bad direction for a multiple. */}
                <td className={`py-1 text-right font-mono ${vs === null ? 'text-ink-500' : vs > 0.05 ? 'text-red-400' : vs < -0.05 ? 'text-emerald-400' : 'text-ink-300'}`}>
                  {vs === null ? '—' : fmtSignedPct(vs, 0)}
                </td>
                <td className="hidden py-1 text-right font-mono text-ink-400 sm:table-cell">
                  {s.rank === null ? '—' : `${Math.round(s.rank * 100)} % der Monate`}
                </td>
                <td className="py-1 text-right font-mono text-ink-300">{s.impliedPrice === null ? '—' : fmtPrice(s.impliedPrice)}</td>
                {sector && <SectorCells d={sector.multiples[key]} />}
                {hasFair && <FairCell f={fair[key]} />}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The industry's median and the stock's rank in it, from today's recorded multiples. */
function SectorCells({ d }: { d: SectorMultiples['multiples'][HistoryMultiple] }) {
  if (!d) {
    return (
      <>
        <td className="hidden py-1 text-right font-mono text-ink-600 md:table-cell">—</td>
        <td className="hidden py-1 text-right font-mono text-ink-600 md:table-cell">—</td>
      </>
    );
  }
  return (
    <>
      <td
        className="hidden py-1 text-right font-mono text-ink-300 md:table-cell"
        title={`Mittlere Hälfte ${fmt(d.p25, 'x', 1)} – ${fmt(d.p75, 'x', 1)}, ${deNumber(d.n, 0)} Werte`}
      >
        {fmt(d.median, 'x', 1)}
      </td>
      <td
        className={`hidden py-1 text-right font-mono md:table-cell ${d.rank === null ? 'text-ink-500' : d.rank > 0.75 ? 'text-red-400' : d.rank < 0.25 ? 'text-emerald-400' : 'text-ink-300'}`}
        title={d.own !== null ? `Heute ${fmt(d.own, 'x', 1)}, verglichen mit ${deNumber(d.n, 0)} Werten` : 'Kein positiver Wert heute'}
      >
        {d.rank === null ? '—' : `${Math.round(d.rank * 100)} % von ${deNumber(d.n, 0)}`}
      </td>
    </>
  );
}

const pctOf = (v: number | null) => fmtPct(v, 0);

/** The inputs and the fit behind a fair multiple, for its tooltip. */
function fairHint(f: FairRatio): string {
  const i = f.inputs;
  return `Erwartet aus Umsatzwachstum ${pctOf(i.revenueGrowth)}, operativer Marge ${pctOf(i.operatingMargin)}, `
    + `Bruttomarge ${pctOf(i.grossMargin)}, Beta ${fmt(i.beta, '', 2)} und Sektor ${i.sector ?? '—'} — `
    + `Regression über ${deNumber(f.n, 0)} Werte des Universums, R² ${deNumber(f.r2, 2)}.`;
}

/** The multiple the stock's growth, margins and risk would normally earn. */
function FairCell({ f }: { f: FairRatio | undefined }) {
  if (!f) return <td className="hidden py-1 text-right font-mono text-ink-600 md:table-cell">—</td>;
  const gap = f.actual !== null ? f.actual / f.fair - 1 : null;
  return (
    <td
      className={`hidden py-1 text-right font-mono md:table-cell ${gap === null ? 'text-ink-300' : gap > 0.15 ? 'text-red-400' : gap < -0.15 ? 'text-emerald-400' : 'text-ink-300'}`}
    >
      <Tip content={fairHint(f)}>{fmt(f.fair, 'x', 1)}</Tip>
    </td>
  );
}

/**
 * The fair multiple in a sentence — the P/S, which every company has, and
 * whether today's is above or below what the fundamentals normally earn.
 */
function FairLede({ fair }: { fair: FairRatios }) {
  const f = fair.ps ?? fair.pe;
  if (!f || f.actual === null) return null;
  const label = fair.ps ? 'KUV' : 'KGV';
  const gap = f.actual / f.fair - 1;
  return (
    <p className="text-xs leading-relaxed text-ink-300" title={fairHint(f)}>
      Wachstum, Margen und Risiko tragen über das ganze Universum gerechnet ein {label} von etwa{' '}
      <strong className="text-ink-100">{fmt(f.fair, 'x', 1)}</strong>; heute{' '}
      <strong className="text-ink-100">{fmt(f.actual, 'x', 1)}</strong>, {Math.abs(gap) < 0.1
        ? 'also etwa das, was die Zahlen tragen.'
        : gap > 0
          ? `${Math.round(gap * 100)} % mehr, als die Zahlen allein tragen — der Markt zahlt einen Aufschlag, den sie nicht erklären.`
          : `${Math.round(-gap * 100)} % weniger, als die Zahlen tragen — ein Abschlag, den sie nicht erklären.`}
      <span className="text-ink-500"> (R² {deNumber(f.r2, 2)})</span>
    </p>
  );
}

const deNum = (x: number, d = 1) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');

/** "KGV 38,3 gegen 29,1 im Fünfjahresmedian, höher als in 85 % der Monate" — is today unusual for this stock? */
function historyFinding(history: History): string | null {
  for (const m of HISTORY_MULTIPLES) {
    const st = multipleStats(history.points, m.key);
    if (st.latest === null || st.median5 === null) continue;
    const rank = st.rank === null ? '' : `, höher als in ${Math.round(st.rank * 100)} % der Monate`;
    return `${m.label} ${deNum(st.latest)} gegen ${deNum(st.median5)} im Fünfjahresmedian${rank}`;
  }
  return null;
}
