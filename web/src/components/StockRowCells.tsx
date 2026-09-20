import type { OverviewRow } from '../types';
import StockLogo, { initialsFromName } from './StockLogo';
import ConsensusBar from './ConsensusBar';
import { scoreColor } from './stockList';
import ScoreSplit from './ScoreSplit';

/**
 * The part of a row that both densities show.
 *
 * The table and the rail are one list, so the columns they share must be the
 * same markup at the same size — not two renderings that happen to look
 * similar. Anything else and clicking a stock makes every row jump, which
 * reads as arriving somewhere new rather than as the same list with its extra
 * columns folded away.
 *
 * Two lines, because that is the shape the overview has always had: the name
 * to read, the ticker and sector to place it by. The rail is narrower, so both
 * lines truncate sooner there — but they are the same two lines.
 */

/**
 * One row, both densities. Declared rather than left to the content, because
 * the tallest cell decides otherwise — and the table has cells the rail does
 * not, so the two lists would drift apart by a pixel or two per row and the
 * stock you clicked would not be where you left it.
 */
export const ROW_HEIGHT = 'h-14';

interface IdentityProps {
  row:    OverviewRow;
  active: boolean;
  /** Stages the queue has in flight for this symbol; takes over the lower line. */
  stages?: string[];
}

export function StockIdentity({ row, active, stages = [] }: IdentityProps) {
  return (
    // `flex-1` is what pushes the score to the right edge in the rail, where
    // the two blocks are siblings in one flex row. In the table each sits in
    // its own cell and the cell does the aligning, so it costs nothing there.
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <ConsensusBar consensus={row.consensus} height={34} />
      <StockLogo
        domain={row.logoDomain}
        symbol={row.symbol}
        fallbackInitials={initialsFromName(row.companyName)}
        size={22}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm font-medium ${active ? 'text-ink-50' : 'text-ink-100'}`}>
            {row.companyName}
          </span>
          {!row.watched && (
            <span
              className="shrink-0 rounded border border-ink-700 px-1 text-[9px] uppercase text-ink-500"
              title="Nicht in der Watchlist — wird vom nächtlichen Lauf übersprungen"
            >
              pausiert
            </span>
          )}
        </div>
        {stages.length > 0 ? (
          // Takes the lower line rather than sitting beside the ticker: while
          // something is running that is the more useful of the two.
          <div
            className="flex items-center gap-1 font-mono text-[10px] text-accent"
            title={`Running: ${stages.join(', ')}`}
          >
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {stages[0]}
          </div>
        ) : (
          <div className="truncate font-mono text-[10px] text-ink-500">
            {row.symbol}{row.sector ? ` · ${row.sector}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Score and its change since the first recorded point.
 *
 * Both sit in fixed-width slots so the numbers line up down the list — a
 * ranking whose ranking column wanders is hard to read — and so the block is
 * exactly as wide in the rail as in the table.
 *
 * The split underneath it is the provenance: the headline is a blend of a
 * deterministic score and a prose-only one, and a single digit hides which of
 * them is carrying it. It renders only where there is room — the rail has
 * none, and the two densities are allowed to differ exactly where a column
 * folds away.
 */
export function StockScore({ row, split = false }: { row: OverviewRow; split?: boolean }) {
  const delta = row.scoreDelta;
  return (
    <span className="flex shrink-0 flex-col items-end">
      <span className="flex items-baseline justify-end gap-1">
        <span
          className={`w-8 text-right text-[10px] tabular ${
            (delta ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
          title={delta ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)} seit dem ersten Verdict` : undefined}
        >
          {delta ? `${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(1)}` : ''}
        </span>
        <span className={`w-8 text-right font-mono text-base font-semibold tabular ${scoreColor(row.score)}`}>
          {row.score === null ? '—' : row.score.toFixed(1)}
        </span>
      </span>
      {split && <ScoreSplit row={row} />}
    </span>
  );
}

/** What the `title` of a row says, in either density. */
export function rowTitle(row: OverviewRow, fmtBig: (n: number | null, c: string | null) => string): string {
  return [
    row.companyName,
    row.sector ?? '—',
    fmtBig(row.marketCap, row.currency),
    row.score === null ? 'nicht bewertet' : `Score ${row.score.toFixed(1)}`,
    row.watched ? null : 'nicht in der Watchlist',
  ].filter(Boolean).join(' · ');
}
