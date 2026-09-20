import type { OverviewRow } from '../types';

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

export function scoreColor(score: number | null): string {
  if (score === null) return 'text-ink-500';
  if (score >= 7) return 'text-emerald-400';
  if (score >= 5) return 'text-amber-400';
  return 'text-red-400';
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
    case 'score':     sorted.sort(byNumber((r) => r.aiScore)); break;
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
  const scored = rows.filter((r) => r.aiScore !== null);
  if (scored.length === 0) return null;
  return {
    avg:   scored.reduce((sum, r) => sum + (r.aiScore ?? 0), 0) / scored.length,
    count: scored.length,
  };
}
