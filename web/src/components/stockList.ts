import type { OverviewRow } from '../types';
import { recommendationTone, verdictForScore } from '../format';

/**
 * The one list of stocks, as a model.
 *
 * The app shows this list at two densities — the wide table and the narrow rail
 * beside an analysis — and they are the same list: same rows, same order, same
 * filter. Only the number of columns differs. So ordering and filtering live
 * here rather than in either view, and switching density is a layout change
 * instead of a second implementation that drifts from the first.
 */

export type SortKey = 'score' | 'target' | 'composite' | 'marketCap' | 'name' | 'symbol';

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'score',      label: 'AI-Score' },
  { key: 'target',     label: 'Analysten-Potenzial' },
  { key: 'composite',  label: 'Modell-Potenzial' },
  { key: 'marketCap',  label: 'Marktkapitalisierung' },
  { key: 'name',       label: 'Name A–Z' },
  { key: 'symbol',     label: 'Symbol A–Z' },
];

/** What the user has done to the list: the state both densities share. */
export interface ListView {
  query:       string;
  sort:        SortKey;
  onlyWatched: boolean;
}

export const DEFAULT_LIST_VIEW: ListView = { query: '', sort: 'score', onlyWatched: false };

/** Nulls always sink, whatever the column — an empty cell is not a low value. */
function byNumberDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * The colour of a score, taken from the verdict it produces.
 *
 * Not its own thresholds. Those were green from 7 and amber from 5, against
 * bands that call 6.5 a BUY and 4.5 a HOLD — so a 4.6 printed a red number
 * beside an amber HOLD chip, and a 6.6 an amber number beside a green BUY one.
 * Two answers to one question, and the reader had to guess which was the real
 * boundary.
 *
 * STRONG gets no colour of its own here, the same rule the badge follows: the
 * word is already in the label, and strength is emphasis rather than a fourth
 * hue.
 */
export function scoreColor(score: number | null): string {
  if (score === null) return 'text-ink-500';
  switch (recommendationTone(verdictForScore(score))) {
    case 'positive': return 'text-emerald-400';
    case 'negative': return 'text-red-400';
    default:         return 'text-amber-400';
  }
}

/**
 * The same reading as a fill, for bars and meters.
 *
 * Paired with `scoreColor` the way `recommendationBarColor` is paired with
 * `recommendationColor`: a filled bar needs a stronger shade than text, and the
 * one thing that must not differ between them is where the colour changes.
 */
export function scoreBarColor(score: number | null): string {
  if (score === null) return 'bg-ink-700';
  switch (recommendationTone(verdictForScore(score))) {
    case 'positive': return 'bg-emerald-500';
    case 'negative': return 'bg-red-500';
    default:         return 'bg-amber-500';
  }
}

/**
 * Filter and order in one pass.
 *
 * Every numeric sort falls back to the symbol, so rows that tie — and the whole
 * block of rows with nothing to compare — keep a stable place instead of
 * shuffling each time the list is rebuilt.
 */
export function applyListView(rows: OverviewRow[], view: ListView): OverviewRow[] {
  const q = view.query.trim().toLowerCase();
  const list = rows.filter((r) => {
    if (view.onlyWatched && !r.watched) return false;
    if (!q) return true;
    return r.symbol.toLowerCase().includes(q)
      || r.companyName.toLowerCase().includes(q)
      || (r.sector ?? '').toLowerCase().includes(q);
  });

  const bySymbol = (a: OverviewRow, b: OverviewRow) => a.symbol.localeCompare(b.symbol);
  const byNumber = (pick: (r: OverviewRow) => number | null) =>
    (a: OverviewRow, b: OverviewRow) => byNumberDesc(pick(a), pick(b)) || bySymbol(a, b);

  const sorted = [...list];
  switch (view.sort) {
    case 'score':     sorted.sort(byNumber((r) => r.score)); break;
    case 'target':    sorted.sort(byNumber((r) => r.targetUpsidePct)); break;
    case 'composite': sorted.sort(byNumber((r) => r.compositeUpsidePct)); break;
    case 'marketCap': sorted.sort(byNumber((r) => r.marketCap)); break;
    case 'name':      sorted.sort((a, b) => a.companyName.localeCompare(b.companyName) || bySymbol(a, b)); break;
    case 'symbol':    sorted.sort(bySymbol); break;
  }
  return sorted;
}

/** Mean AI score over the rows that have one — the table header's one statistic. */
export function averageScore(rows: OverviewRow[]): { avg: number; count: number } | null {
  const scored = rows.filter((r) => r.score !== null);
  if (scored.length === 0) return null;
  return {
    avg:   scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length,
    count: scored.length,
  };
}
