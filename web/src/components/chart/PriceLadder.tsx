import { useEffect, useRef, useState, type ReactNode } from 'react';
import Tip from '../Tip';

/** What a mark on the ladder is, which decides its colour and its line. */
export type MarkKind = 'resistance' | 'support' | 'average' | 'target' | 'neutral';

export interface LadderMark {
  price:  number;
  kind:   MarkKind;
  /** What it is: "Widerstand", "50-Tage-Linie", "Ziel Bear". */
  label:  string;
  /** A word after it, quieter: "stark", "zweimal umgekehrt". */
  note?:  string;
  /** 0–1: drawn thicker the stronger it is. */
  strength?: number;
  /** The whole story, on hover. */
  tip?:   ReactNode;
}

export interface LadderBand {
  from:  number;
  to:    number;
  kind:  'channel' | 'gap' | 'zone';
  label: string;
}

const LINE: Record<MarkKind, string> = {
  resistance: '#d77279',
  support:    '#6cb892',
  average:    '#8b93a1',
  target:     '#d6a865',
  neutral:    '#8b93a1',
};
const TEXT: Record<MarkKind, string> = {
  resistance: 'text-red-400',
  support:    'text-emerald-400',
  average:    'text-ink-300',
  target:     'text-amber-300',
  neutral:    'text-ink-300',
};
const BAND: Record<LadderBand['kind'], string> = {
  channel: 'rgba(125, 160, 220, 0.10)',
  gap:     'rgba(214, 168, 101, 0.16)',
  zone:    'rgba(139, 147, 161, 0.10)',
};

/** Rows of label this many pixels apart at least. */
const ROW = 22;
/** Where the drawing ends and the labels begin, in percent of the width — less on a narrow screen. */
const SPLIT_WIDE = 30;
const SPLIT_NARROW = 14;

/**
 * Prices as a ladder: today's price across the middle, every mark above and
 * below it at its height, the stronger ones drawn heavier, and on the right
 * what each is and how far — in words a reader can take in at a look, where
 * a table of prices, distances and "ATR" had to be read row by row.
 *
 * The scale is logarithmic, so ten percent up and ten percent down are the
 * same height. Labels that would collide are pushed apart and joined to their
 * line by a thin stroke.
 */
export default function PriceLadder({ price, marks, bands = [], fmt, priceLabel = 'Kurs', minSpan = 0.12, maxSpan = 0.4 }: {
  price: number;
  marks: LadderMark[];
  bands?: LadderBand[];
  fmt: (n: number) => string;
  priceLabel?: string;
  /** The scale reaches at least this far each way, so a quiet chart is not blown up. */
  minSpan?: number;
  /** Marks further away than this are left off. */
  maxSpan?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const SPLIT = wide ? SPLIT_WIDE : SPLIT_NARROW;
  const shown = marks.filter((m) => m.price > 0 && Math.abs(Math.log(m.price / price)) <= Math.log(1 + maxSpan));
  const prices = [price, ...shown.map((m) => m.price), ...bands.flatMap((b) => [b.from, b.to]).filter((p) => Math.abs(Math.log(p / price)) <= Math.log(1 + maxSpan))];
  const lo = Math.min(Math.log(price * (1 - minSpan)), ...prices.map(Math.log));
  const hi = Math.max(Math.log(price * (1 + minSpan)), ...prices.map(Math.log));
  const pad = (hi - lo) * 0.06;
  const top = hi + pad, bottom = lo - pad;

  // One row per mark plus the price; the height grows with the rows so none have to overlap.
  const rows = shown.length + 1;
  const height = Math.max(300, rows * ROW + 40);
  const y = (p: number) => ((top - Math.log(p)) / (top - bottom)) * height;

  // The labels: at their line where there is room, pushed apart where there is not.
  type Row = { key: string; y: number; at: number; node: ReactNode };
  const labelRows: Row[] = [
    ...shown.map((m, k) => ({ key: `m${k}`, y: y(m.price), at: y(m.price), node: <MarkLabel m={m} price={price} fmt={fmt} /> })),
    {
      key: 'price', y: y(price), at: y(price),
      node: <span className="rounded bg-ink-100 px-1.5 py-px font-mono text-xs font-semibold text-ink-950">{priceLabel} {fmt(price)}</span>,
    },
  ].sort((a, b) => a.y - b.y);
  for (let k = 0; k < labelRows.length; k++) {
    const min = k === 0 ? ROW / 2 : labelRows[k - 1].y + ROW;
    if (labelRows[k].y < min) labelRows[k].y = min;
  }
  const overflow = labelRows.length ? labelRows[labelRows.length - 1].y - (height - ROW / 2) : 0;
  if (overflow > 0) {
    for (let k = labelRows.length - 1; k >= 0; k--) {
      const max = k === labelRows.length - 1 ? height - ROW / 2 : labelRows[k + 1].y - ROW;
      if (labelRows[k].y > max) labelRows[k].y = max;
    }
  }

  return (
    <div ref={box} className="relative w-full select-none" style={{ height }}>
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden>
        {bands.map((b, k) => {
          const y1 = y(Math.max(b.from, b.to)), y2 = y(Math.min(b.from, b.to));
          return <rect key={k} x={0} y={y1} width={SPLIT} height={Math.max(2, y2 - y1)} fill={BAND[b.kind]} />;
        })}
        {shown.map((m, k) => (
          <line
            key={k} x1={m.kind === 'average' ? 6 : 0} x2={SPLIT} y1={y(m.price)} y2={y(m.price)}
            stroke={LINE[m.kind]} strokeWidth={m.kind === 'average' ? 1 : 1 + 2.5 * (m.strength ?? 0.4)}
            strokeDasharray={m.kind === 'average' ? '3 3' : m.kind === 'target' ? '6 3' : undefined}
            vectorEffect="non-scaling-stroke" opacity={0.9}
          />
        ))}
        <line x1={0} x2={SPLIT} y1={y(price)} y2={y(price)} stroke="#e5e7eb" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        {/* A thin stroke from each line to its label where the label had to move. */}
        {labelRows.map((r) => (
          <polyline
            key={r.key}
            points={`${SPLIT},${r.at} ${SPLIT + 3},${r.at} ${SPLIT + 6},${r.y} ${SPLIT + 8},${r.y}`}
            fill="none" stroke="#4b5563" strokeWidth={1} vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {bands.map((b, k) => (
        <span
          key={k}
          className="absolute left-1 text-2xs text-ink-500"
          style={{ top: y(Math.max(b.from, b.to)) + 2 }}
        >
          {b.label}
        </span>
      ))}
      {labelRows.map((r) => (
        <div key={r.key} className="absolute right-0 flex min-w-0 items-center overflow-hidden whitespace-nowrap" style={{ left: `calc(${SPLIT + 8}% + 4px)`, top: r.y, transform: 'translateY(-50%)' }}>
          {r.node}
        </div>
      ))}
    </div>
  );
}

function MarkLabel({ m, price, fmt }: { m: LadderMark; price: number; fmt: (n: number) => string }) {
  const d = m.price / price - 1;
  const body = (
    <span className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className="w-20 shrink-0 text-right font-mono text-ink-100">{fmt(m.price)}</span>
      <span className="w-14 shrink-0 text-right font-mono text-ink-400">
        {`${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`}
      </span>
      <span className={`truncate ${TEXT[m.kind]}`}>{m.label}{m.note && <span className="ml-1.5 text-ink-500">{m.note}</span>}</span>
    </span>
  );
  return m.tip ? <Tip focusable={false} content={m.tip}>{body}</Tip> : body;
}
