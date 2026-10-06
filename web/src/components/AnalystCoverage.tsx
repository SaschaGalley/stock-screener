import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useMoney } from '../currency';
import { fmtSignedPct } from '../format';
import Tip from './Tip';
import type { FirmWord, RatingBucket } from '../../../src/analysis/analyst-history';
import type { CoverageView } from '../../../src/stock-history-service';
import Term from './Term';

/**
 * The analyst consensus, firm by firm.
 *
 * Yahoo's card figures — a mean, a low, a high, five counts — are the street
 * with its names taken off. The rating history puts them back: each firm's
 * newest target and grade from the last twelve months, the same list the
 * backtest rebuilds a past day's consensus from. The strip shows where every
 * target sits against the price; the table says who set it and when.
 */

const BUCKET_LABEL: Record<RatingBucket, string> = {
  strongBuy: 'Strong Buy', buy: 'Buy', hold: 'Hold', sell: 'Sell', strongSell: 'Strong Sell',
};

/** Filled for the strong steps, lighter for the plain ones — the rating bar's convention. */
function bucketFill(b: RatingBucket | undefined): { className: string; style?: CSSProperties } {
  switch (b) {
    case 'strongBuy':  return { className: 'bg-emerald-500' };
    case 'buy':        return { className: 'bg-emerald-500', style: { opacity: 0.65 } };
    case 'hold':       return { className: 'bg-amber-500' };
    case 'sell':       return { className: 'bg-red-500', style: { opacity: 0.65 } };
    case 'strongSell': return { className: 'bg-red-500' };
    default:           return { className: 'bg-ink-500' };
  }
}

function bucketText(b: RatingBucket | undefined): string {
  if (b === 'strongBuy' || b === 'buy') return 'text-emerald-400';
  if (b === 'sell' || b === 'strongSell') return 'text-red-400';
  if (b === 'hold') return 'text-amber-400';
  return 'text-ink-400';
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

/** Which way the firm last moved its grade, as Yahoo files it. */
function gradeMove(w: FirmWord): { mark: string; cls: string; word: string } | null {
  switch (w.grade?.action) {
    case 'up':   return { mark: '↑', cls: 'text-emerald-400', word: 'hochgestuft' };
    case 'down': return { mark: '↓', cls: 'text-red-400', word: 'herabgestuft' };
    case 'init': return { mark: '•', cls: 'text-accent', word: 'Abdeckung aufgenommen' };
    default:     return null;
  }
}

function firmTip(w: FirmWord, price: number, fmtPrice: (n: number) => string) {
  const move = gradeMove(w);
  return (
    <>
      <div className="font-semibold text-ink-100">{w.firm}</div>
      {w.grade && (
        <div>
          <span className={bucketText(w.grade.bucket)}>{w.grade.label}</span>
          {move ? ` — ${move.word}` : ''}
          {w.grade.from && w.grade.from !== w.grade.label ? ` (vorher ${w.grade.from})` : ''}
          <span className="text-ink-500"> · {fmtDay(w.grade.day)}</span>
        </div>
      )}
      {w.target && (
        <div>
          Kursziel {fmtPrice(w.target.value)}{' '}
          <span className={w.target.value >= price ? 'text-emerald-400' : 'text-red-400'}>
            ({fmtSignedPct(w.target.value / price - 1, 0)} zum Kurs)
          </span>
          {w.target.prior !== null && Math.abs(w.target.prior - w.target.value) > 1e-9 && (
            <span className="text-ink-400"> · vorher {fmtPrice(w.target.prior)}</span>
          )}
          <span className="text-ink-500"> · {fmtDay(w.target.day)}</span>
        </div>
      )}
    </>
  );
}

const DOT = 8;
const ROW_GAP = 2;
/** Beyond this the strip stops growing and the last row overlaps — a crowd is a crowd. */
const MAX_ROWS = 7;

/**
 * Every firm's target as a dot on one axis with the price, stacked where they
 * crowd. A mean of $305 with every dot between $280 and $330 is a different
 * statement from the same mean with dots from $180 to $515.
 */
export function CoverageStrip({ coverage, price, mean }: { coverage: CoverageView; price: number; mean: number | null }) {
  const { fmtPrice } = useMoney();
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const withTarget = coverage.firms.filter((f) => f.target);
  if (withTarget.length === 0) return null;
  const values = withTarget.map((f) => f.target!.value);
  const lo = Math.min(price, ...values);
  const hi = Math.max(price, ...values);
  const pad = (hi - lo) * 0.04 || hi * 0.05;
  const min = lo - pad;
  const max = hi + pad;
  const x = (v: number) => ((v - min) / (max - min)) * width;

  // Greedy rows: each dot goes into the lowest row it does not overlap in.
  const rowEnds: number[] = [];
  const placed = [...withTarget]
    .sort((a, b) => a.target!.value - b.target!.value)
    .map((f) => {
      const cx = x(f.target!.value);
      let row = rowEnds.findIndex((end) => cx - DOT / 2 >= end + 1);
      if (row === -1) {
        row = Math.min(rowEnds.length, MAX_ROWS - 1);
        if (row === rowEnds.length) rowEnds.push(-Infinity);
      }
      rowEnds[row] = cx + DOT / 2;
      return { f, cx, row };
    });
  const height = Math.max(1, rowEnds.length) * (DOT + ROW_GAP) + 4;

  const marker = (v: number, label: string, line: string, text: string) => (
    <div className="absolute top-0 bottom-0" style={{ left: x(v) }}>
      <div className={`absolute top-0 bottom-0 w-px ${line}`} />
      <div className={`absolute top-full mt-0.5 -translate-x-1/2 whitespace-nowrap text-3xs ${text}`}>{label}</div>
    </div>
  );

  return (
    <div className="mt-2 mb-3">
      <Term k="concept.coverageStrip" className="mb-1 block text-2xs text-ink-500">Kursziele je Haus</Term>
      <div ref={ref} className="relative border-b border-ink-700" style={{ height }}>
        {width > 0 && (
          <>
            {mean !== null && marker(mean, 'Ø', 'bg-accent', 'text-accent')}
            {marker(price, 'Kurs', 'bg-ink-200', 'text-ink-200')}
            {placed.map(({ f, cx, row }) => {
              const fill = bucketFill(f.grade?.bucket);
              return (
                <Tip
                  key={f.firm}
                  focusable={false}
                  content={firmTip(f, price, fmtPrice)}
                  className={`absolute rounded-full ring-1 ring-ink-900 ${fill.className}`}
                  style={{ ...fill.style, width: DOT, height: DOT, left: cx - DOT / 2, bottom: 2 + row * (DOT + ROW_GAP) }}
                >
                  {null}
                </Tip>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/** The same list as a table, highest target first — who, what, how far from the price, since when. */
export function CoverageTable({ coverage, price, analystCount }: { coverage: CoverageView; price: number; analystCount: number | null }) {
  const { fmtPrice } = useMoney();
  const targets = coverage.firms.flatMap((f) => (f.target ? [f.target.value] : [])).sort((a, b) => a - b);
  const mean = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;
  const median = targets.length
    ? (targets.length % 2 ? targets[(targets.length - 1) / 2] : (targets[targets.length / 2 - 1] + targets[targets.length / 2]) / 2)
    : null;

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xs font-semibold text-ink-300">Die Häuser einzeln</h3>
        <span className="text-xs text-ink-500">
          {coverage.firms.length} Häuser mit einem Wort in den letzten {Math.round(coverage.windowDays / 30)} Monaten
          {mean !== null && <> · Mittel ihrer Ziele <span className="font-mono text-ink-300">{fmtPrice(mean)}</span></>}
          {median !== null && <> · Median <span className="font-mono text-ink-300">{fmtPrice(median)}</span></>}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular">
          <thead>
            <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
              <th className="py-1 pr-2 text-left font-normal">Haus</th>
              <th className="py-1 pr-2 text-left font-normal">Rating</th>
              <th className="py-1 px-2 text-right font-normal">Kursziel</th>
              <th className="py-1 px-2 text-right font-normal">zum Kurs</th>
              <th className="hidden py-1 px-2 text-right font-normal sm:table-cell">vorher</th>
              <th className="py-1 pl-2 text-right font-normal">Stand</th>
            </tr>
          </thead>
          <tbody>
            {coverage.firms.map((w) => {
              const move = gradeMove(w);
              const t = w.target;
              const changed = t && t.prior !== null && Math.abs(t.prior - t.value) > 1e-9;
              const newest = [t?.day, w.grade?.day].filter(Boolean).sort().at(-1)!;
              return (
                <tr key={w.firm} className="border-b border-ink-800">
                  <td className="py-1 pr-2 text-ink-200">{w.firm}</td>
                  <td className="whitespace-nowrap py-1 pr-2">
                    {w.grade ? (
                      <Tip
                        content={`${w.grade.label} — zählt als ${BUCKET_LABEL[w.grade.bucket]}${
                          w.grade.from && w.grade.from !== w.grade.label ? `, vorher ${w.grade.from}` : ''
                        }${move ? ` (${move.word})` : ''}, am ${fmtDay(w.grade.day)}`}
                      >
                        <span className={bucketText(w.grade.bucket)}>{w.grade.label}</span>
                        {move && <span className={`ml-1 ${move.cls}`}>{move.mark}</span>}
                      </Tip>
                    ) : <span className="text-ink-600">—</span>}
                  </td>
                  <td className="py-1 px-2 text-right font-mono text-ink-100">{t ? fmtPrice(t.value) : '—'}</td>
                  <td className={`py-1 px-2 text-right font-mono ${t ? (t.value >= price ? 'text-emerald-400' : 'text-red-400') : 'text-ink-600'}`}>
                    {t ? fmtSignedPct(t.value / price - 1, 0) : '—'}
                  </td>
                  <td className="hidden py-1 px-2 text-right font-mono sm:table-cell">
                    {changed
                      ? <span className={t!.value > t!.prior! ? 'text-emerald-400' : 'text-red-400'}>{t!.value > t!.prior! ? '↑' : '↓'} {fmtPrice(t!.prior!)}</span>
                      : <span className="text-ink-600">—</span>}
                  </td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right font-mono text-ink-400">{fmtDay(newest)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        Aus Yahoos Analysten-Historie: das jeweils neueste Kursziel und Rating jedes Hauses, Ziele aus der Zeit vor einem
        Aktiensplit auf die heutige Basis umgerechnet. Die Kopfzahlen der Karte
        {analystCount ? ` (${analystCount} Analysten)` : ''} stammen aus Yahoos Konsensdaten, die keine Namen nennen;
        die Historie kennt nicht jedes Haus, das dort mitzählt. Anzahl und Mittel können deshalb abweichen.
      </p>
    </div>
  );
}
