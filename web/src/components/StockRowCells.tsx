import type { OverviewRow } from '../types';
import StockLogo, { initialsFromName } from './StockLogo';
import ConsensusBar from './ConsensusBar';
import { averageScore, scoreColor, type GroupKey, type ListGroup } from './stockList';
import ScoreSplit from './ScoreSplit';
import RecommendationBadge from './RecommendationBadge';
import Tip from './Tip';
import { RECOMMENDATIONS } from '../format';

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
export const ROW_HEIGHT = 'h-11';

/*
 * A row height is a minimum to a table, not a limit: one cell taller than the
 * rest grows the whole row past `ROW_HEIGHT`. So every two-line cell — name
 * over ticker, score over split, chip over model — sets its line heights
 * outright and stays within the row less its `py-1`. An inherited line height
 * is a ratio of whatever font size the parent happened to set.
 */

/** A group's heading row, in both densities — the same reasoning as above. */
export const GROUP_HEIGHT = 'h-7';

/**
 * And the column-label row above them, for the same reason plus one more: left
 * to its content it lands on 30.78px, because a 10px uppercase line is 13.78px
 * tall. Every row then sits on a fractional offset, the two lists disagree
 * about that fraction, and the scroll correction can only land on whole
 * pixels — which is exactly the one-pixel jump you see on the way in and out.
 */
export const HEADER_HEIGHT = 'h-8';

/**
 * The table's row rules, drawn as an inset shadow on the cells rather than as a
 * border. The rail's rows are buttons whose border sits inside their height;
 * a table row's border, collapsed or separate, is added to it. So the table's
 * rows came out at 45px against the rail's 44 and its labels at 33 against 32,
 * and folding the columns away shrank every row by a pixel — twenty rows down,
 * the stock you clicked had moved twenty pixels. A shadow takes no room.
 */
export const ROW_RULE = '*:shadow-[inset_0_-1px_0_var(--color-bg-elevated)]';
export const HEADER_RULE = '*:shadow-[inset_0_-1px_0_var(--color-border)]';
/** The same rule for a cell that carries its own background, as a sticky one does. */
export const CELL_RULE = 'shadow-[inset_0_-1px_0_var(--color-border)]';

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
      <ConsensusBar consensus={row.consensus} height={30} />
      <StockLogo
        domain={row.logoDomain}
        symbol={row.symbol}
        fallbackInitials={initialsFromName(row.companyName)}
        size={22}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm font-medium leading-5 ${active ? 'text-ink-50' : 'text-ink-100'}`}>
            {row.companyName}
          </span>
          {!row.watched && (
            <Tip
              focusable={false}
              className="shrink-0 rounded border border-ink-700 px-1 text-3xs uppercase leading-3.5 text-ink-500"
              content="Nicht in der Watchlist — wird vom nächtlichen Lauf übersprungen"
            >
              pausiert
            </Tip>
          )}
        </div>
        {stages.length > 0 ? (
          // Takes the lower line rather than sitting beside the ticker: while
          // something is running that is the more useful of the two.
          <div
            className="flex items-center gap-1 font-mono text-2xs leading-4 text-accent"
            title={`Running: ${stages.join(', ')}`}
          >
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {stages[0]}
          </div>
        ) : (
          <div className="truncate font-mono text-2xs leading-4 text-ink-500">
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
        <Tip
          focusable={false}
          className={`w-8 text-right text-2xs tabular ${
            (delta ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
          content={delta ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)} seit dem ersten Verdict` : null}
        >
          {delta ? `${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(1)}` : ''}
        </Tip>
        <span className={`w-8 text-right font-mono text-base font-semibold leading-5 tabular ${scoreColor(row.score)}`}>
          {row.score === null ? '—' : row.score.toFixed(1)}
        </span>
      </span>
      {split && <ScoreSplit row={row} />}
    </span>
  );
}

/**
 * A group's heading, left half: fold marker, name, how many.
 *
 * Grouped by verdict, the name is the verdict's own chip — the colour is
 * already how the list says BUY, and a heading in plain text would be the one
 * place it didn't.
 */
export function GroupName({ group, by, collapsed }: { group: ListGroup; by: GroupKey; collapsed: boolean }) {
  const chip = by === 'verdict' && (RECOMMENDATIONS as readonly string[]).includes(group.key);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs">
      <span aria-hidden className={`w-2 shrink-0 text-ink-500 transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
      {chip
        ? <RecommendationBadge rec={group.key} size="sm" />
        : <span className="truncate font-semibold text-ink-200">{group.label}</span>}
      <span className="shrink-0 font-mono text-2xs text-ink-500">{group.rows.length}</span>
    </span>
  );
}

/** …and right half: the group's mean score, under the score column. */
export function GroupAverage({ group }: { group: ListGroup }) {
  const avg = averageScore(group.rows);
  if (!avg) return null;
  return (
    <span className="whitespace-nowrap font-mono text-xs text-ink-500">
      Ø <span className={`inline-block w-8 text-right font-semibold ${scoreColor(avg.avg)}`}>{avg.avg.toFixed(1)}</span>
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
