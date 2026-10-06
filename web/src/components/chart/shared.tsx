import type { ReactNode } from 'react';
import type { Tone } from '../../../../src/analysis/chart-reading';

export const de = (x: number, d = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
export const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`);
/** "9.9.26" */
export const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(2, 4)}`;
/** "9.9." — within the year on show. */
export const dayShort = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;

export const TONE_TEXT: Record<Tone, string> = { bull: 'text-emerald-400', bear: 'text-red-400', neutral: 'text-ink-100' };
export const TONE_BORDER: Record<Tone, string> = { bull: 'border-l-emerald-500', bear: 'border-l-red-500', neutral: 'border-l-ink-600' };
export const TONE_MARK: Record<Tone, string> = { bull: '▲', bear: '▼', neutral: '•' };

/**
 * A question and its answer in a word, the reasons under it — the shape
 * every reading on the chart page takes before its numbers.
 */
export function AnswerCard({ question, answer, tone, why, children }: {
  question: ReactNode; answer: ReactNode; tone: Tone; why?: string[]; children?: ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-ink-700 border-l-4 bg-ink-950 px-3 py-2.5 ${TONE_BORDER[tone]}`}>
      <div className="text-xs font-semibold text-ink-400">{question}</div>
      <div className={`mt-0.5 text-base font-semibold leading-snug ${TONE_TEXT[tone]}`}>{answer}</div>
      {why && why.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[13px] leading-snug text-ink-300">
          {why.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {children}
    </div>
  );
}

/** A heading inside a section: what the block below answers. */
export function Question({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
      <h3 className="text-sm font-semibold text-ink-100">{children}</h3>
      {note && <span className="text-xs text-ink-500">{note}</span>}
    </div>
  );
}

/**
 * Where a value sits between two ends: a bar with a marker, the ends named
 * under it. For a channel, a year's range, an oscillator.
 */
export function RangeMarker({ at, left, right, middle, marker, zones }: {
  /** 0–1; outside the ends is drawn at the edge with an arrow. */
  at: number;
  left: ReactNode; right: ReactNode; middle?: ReactNode;
  marker?: ReactNode;
  /** Shaded stretches, 0–1, e.g. the RSI's overbought zone. */
  zones?: { from: number; to: number; cls: string }[];
}) {
  const x = Math.min(1, Math.max(0, at));
  const outside = at < 0 ? '◂' : at > 1 ? '▸' : null;
  return (
    <div className="min-w-0">
      <div className="relative h-2 rounded-full bg-ink-800">
        {zones?.map((z, k) => (
          <div key={k} className={`absolute inset-y-0 ${z.cls}`} style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }} />
        ))}
        <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-950 bg-ink-100" style={{ left: `${x * 100}%` }} />
        {outside && <span className="absolute -top-1 text-xs text-ink-100" style={{ left: at < 0 ? '-10px' : 'calc(100% + 2px)' }}>{outside}</span>}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-2xs text-ink-500">
        <span>{left}</span>
        {middle && <span>{middle}</span>}
        <span className="text-right">{right}</span>
      </div>
      {marker}
    </div>
  );
}
