import type { TimelineKind, Tone } from '../../../src/analysis/timeline';

/** How a timeline event is marked, on a stock's own timeline and in the watchlist feed alike. */
export const KIND_DOT: Record<TimelineKind, string> = {
  journal:  'bg-ink-100',
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

/** A kind as a word on its event, short enough for a tag: what the colour stands for, said. */
export const KIND_SHORT: Record<TimelineKind, string> = {
  journal:  'Journal',
  analyst:  'Analyst',
  insider:  'Insider',
  earnings: 'Zahlen',
  dividend: 'Dividende',
  verdict:  'Urteil',
  event:    'Ereignis',
  news:     'Nachricht',
  move:     'Kurssprung',
};

/** The tag itself: the kind's colour as a tint behind its word. */
export const KIND_TAG: Record<TimelineKind, string> = {
  journal:  'bg-ink-800 text-ink-100',
  analyst:  'bg-sky-500/15 text-sky-300',
  insider:  'bg-violet-500/15 text-violet-300',
  earnings: 'bg-emerald-950 text-emerald-400',
  dividend: 'bg-ink-800 text-ink-300',
  verdict:  'bg-amber-950 text-amber-400',
  event:    'bg-cyan-500/15 text-cyan-300',
  news:     'bg-ink-800 text-ink-400',
  move:     'bg-red-950 text-red-400',
};

/** The same colours for the marks on the price chart, which cannot read a class. */
export const KIND_HEX: Record<TimelineKind, string> = {
  journal:  '#e5e7eb',
  analyst:  '#38bdf8',
  insider:  '#a78bfa',
  earnings: '#6cb892',
  dividend: '#8b93a1',
  verdict:  '#d6a865',
  event:    '#22d3ee',
  news:     '#6b7280',
  move:     '#d77279',
};
