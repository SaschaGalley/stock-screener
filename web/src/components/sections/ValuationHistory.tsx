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
import More from '../More';
import { RangeMarker } from '../chart/shared';
import { HISTORY_MULTIPLE_TERMS, type GlossaryKey } from '../../glossary';

type FairRatios = Partial<Record<HistoryMultiple, FairRatio>>;


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

  return (
    <div className="space-y-6">
      <div className={`grid gap-x-8 gap-y-6 ${history.source === 'sec' ? 'xl:grid-cols-2' : ''}`}>
        {history.source === 'sec' && (
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink-100"><Term k="concept.vh.fair">Lag der Kurs unter oder über dem fairen Wert?</Term></h3>
            <FairValueView history={history} liveFairValue={liveFairValue} />
          </div>
        )}
        <div>
          <h3 className="mb-1 text-sm font-semibold text-ink-100"><Term k="concept.vh.earnings">Ist der Kurs dem Gewinn gefolgt?</Term></h3>
          <EarningsView history={history} />
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink-100"><Term k="concept.vh.multiplesTable">Ist sie teurer als sonst — und als die Branche?</Term></h3>
        <FairLede fair={fair} />
        <MultiplesTable history={history} sector={sector} fair={fair} />
      </div>
      <More label="den Verlauf jedes Multiples">
        <MultiplesView history={history} />
      </More>

      <p className="text-xs leading-relaxed text-ink-500">
        {history.source === 'sec'
          ? 'Jeder Monatsultimo aus den SEC-Filings rekonstruiert, die an dem Tag bekannt waren, und mit den heutigen Modellen gerechnet. '
            + 'Das Analysten-Kursziel ist aus der Rating-Historie rekonstruiert (je Haus das neueste der zwölf Monate davor). '
            + 'Peer-Multiples lassen sich für einen Wert allein nicht nachrechnen und fehlen — der rekonstruierte faire Wert weicht '
            + 'deshalb vom heutigen Headline-Wert ab, ist aber über alle Monate gleich gerechnet.'
          : 'Ohne SEC-Filings: aus den von Yahoo gemeldeten Geschäftsjahren, jedes ab einem Quartal nach Jahresende. '
            + 'Für einen rekonstruierten fairen Wert reicht das nicht.'}
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
      name: 'Fairer Wert heute (live)', type: 'scatter', symbol: 'diamond', symbolSize: 11,
      data: dates.map((_, i) => (i === dates.length - 1 ? liveFairValue : null)),
      itemStyle: { color: CHART_COLORS.amber },
    }]
    : [];

  const option = {
    ...baseOption(dates, (v) => fmtPrice(v)),
    series: [
      line('Kurs', pts.map((p) => p.price), CHART_COLORS.text),
      line('Fairer Wert (rekonstruiert)', pts.map((p) => p.fairValue), CHART_COLORS.green),
      line('Konservativ', pts.map((p) => p.conservative), CHART_COLORS.green, { lineStyle: { color: CHART_COLORS.green, width: 1, type: 'dashed' } }),
      ...live,
    ],
  };

  return (
    <div className="space-y-2">
      {range && (
        <Lede>
          In den letzten {Math.round(range.months / 12)} Jahren notierte die Aktie meist{' '}
          <strong className="text-ink-100">{rangeWords(range.p25, range.p75)}</strong> rekonstruierten fairen Wert;
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

/** Every multiple over the years, each its own small chart with its medians — side by side, not one at a time. */
function MultiplesView({ history }: { history: History }) {
  const pts = history.points;
  const available = HISTORY_MULTIPLES.filter((m) => pts.some((p) => p[m.key] !== null && p[m.key]! > 0));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {available.map((m) => <MultipleChart key={m.key} history={history} k={m.key} label={m.label} />)}
    </div>
  );
}

function MultipleChart({ history, k, label }: { history: History; k: HistoryMultiple; label: string }) {
  const pts = history.points;
  const stats = useMemo(() => multipleStats(pts, k), [pts, k]);
  const dates = pts.map((p) => p.date);
  const fmtX = (v: number) => fmt(v, 'x', 1);
  const flat = (v: number | null) => dates.map(() => v);
  // Capped near the top of the range rather than at its peak: a P/E of 640 on
  // near-zero earnings would otherwise flatten five years into the floor.
  const values = pts.flatMap((p) => (p[k] !== null && p[k]! > 0 ? [p[k]!] : [])).sort((a, b) => a - b);
  const p95 = values.length ? values[Math.floor((values.length - 1) * 0.95)] : null;
  const base = baseOption(dates, fmtX);
  const option = {
    ...base,
    legend: { show: false },
    grid: { ...(base as { grid?: object }).grid, top: 10 },
    yAxis: { ...base.yAxis, max: p95 !== null && values[values.length - 1] > p95 * 1.2 ? Math.ceil(p95 * 1.2) : undefined },
    series: [
      line(label, pts.map((p) => (p[k] !== null && p[k]! > 0 ? p[k] : null)), CHART_COLORS.blue),
      line('Median 5J', flat(stats.median5), CHART_COLORS.purple, { lineStyle: { color: CHART_COLORS.purple, width: 1, type: 'dashed' } }),
    ],
  };
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <Term k={HISTORY_MULTIPLE_TERMS[k]}><span className="text-ink-100">{label}</span></Term>
        <span className="text-xs text-ink-500">heute {stats.latest !== null ? fmtX(stats.latest) : '—'} · Median {stats.median5 !== null ? fmtX(stats.median5) : '—'}</span>
      </div>
      <div style={{ height: 170 }}>
        <ReactECharts style={{ height: '100%', width: '100%' }} notMerge option={option} />
      </div>
    </div>
  );
}

/**
 * Every multiple against its own past and against its industry, a row each:
 * today's figure, then two bars that say where it stands — among the stock's
 * own months, among its industry's companies — in words under them. It was
 * a table of nine columns and two header rows.
 */
function MultiplesTable({ history, sector, fair }: { history: History; sector: SectorMultiples | null; fair: FairRatios }) {
  const { fmtPrice } = useMoney();
  const rows = HISTORY_MULTIPLES
    .map((m) => ({ ...m, s: multipleStats(history.points, m.key) }))
    .filter((r) => r.s.median5 !== null);
  if (rows.length === 0) return null;
  const x = (v: number | null) => fmt(v, 'x', 1);
  const years = Math.min(5, Math.max(1, Math.round(Math.max(...rows.map((r) => r.s.months)) / 12)));
  const group = sector ? (sector.level === 'industry' ? 'Branche' : 'Sektor') : null;
  const zones = [{ from: 0, to: 0.25, cls: 'bg-emerald-500/15' }, { from: 0.75, to: 1, cls: 'bg-red-500/15' }];

  return (
    <ul className="mt-3 divide-y divide-ink-800">
      {rows.map(({ key, label, s }) => {
        const peer = sector?.multiples[key] ?? null;
        const f = fair[key];
        return (
          <li key={key} className="grid gap-x-6 gap-y-2 py-3 md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <div className="text-sm text-ink-300"><Term k={HISTORY_MULTIPLE_TERMS[key]}>{label}</Term></div>
              <div className="font-mono text-lg font-semibold text-ink-50">{x(s.latest)}</div>
              {f && <Tip content={fairHint(f)}><div className="text-xs text-ink-500">angemessen {x(f.fair)}</div></Tip>}
            </div>
            <div>
              <div className="mb-1 text-xs text-ink-500">gegen die eigenen {years} Jahre</div>
              {s.rank !== null ? (
                <RangeMarker at={s.rank} left="so günstig wie nie" right="so teuer wie nie" zones={zones} />
              ) : <div className="text-xs text-ink-600">—</div>}
              <div className="mt-1 text-[13px] text-ink-300">
                {s.rank !== null && <>teurer als in {Math.round(s.rank * 100)} % der Monate · </>}Median {x(s.median5)}
                {s.impliedPrice !== null && <span className="text-ink-500"> · dazu passt ein Kurs von {fmtPrice(s.impliedPrice)}</span>}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-ink-500">{group ? <Term k="concept.vh.sector">gegen die {group} · {sector!.group}</Term> : 'gegen die Branche'}</div>
              {peer && peer.rank !== null ? (
                <RangeMarker at={peer.rank} left="günstigste" right="teuerste" zones={zones} />
              ) : <div className="text-xs text-ink-600">keine Vergleichswerte</div>}
              {peer && (
                <div className="mt-1 text-[13px] text-ink-300">
                  {peer.rank !== null && <>teurer als {Math.round(peer.rank * 100)} % von {deNumber(peer.n, 0)} · </>}Median {x(peer.median)}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
