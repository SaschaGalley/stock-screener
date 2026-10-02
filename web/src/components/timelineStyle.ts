import type { TimelineKind, Tone } from '../../../src/analysis/timeline';

/** How a timeline event is marked, on a stock's own timeline and in the watchlist feed alike. */
export const KIND_DOT: Record<TimelineKind, string> = {
  analyst:  'bg-sky-500',
  insider:  'bg-violet-500',
  earnings: 'bg-emerald-500',
  dividend: 'bg-ink-500',
  verdict:  'bg-amber-500',
  event:    'bg-cyan-500',
  news:     'bg-ink-600',
  move:     'bg-red-500',
};

export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-emerald-400',
  negative: 'text-red-400',
  neutral:  'text-ink-500',
};

export const TONE_MARK: Record<Tone, string> = { positive: '▲', negative: '▼', neutral: '·' };
