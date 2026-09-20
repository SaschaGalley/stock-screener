import type { OverviewRow } from '../types';
import StockLogo, { initialsFromName } from './StockLogo';
import ConsensusBar from './ConsensusBar';
import { scoreColor } from './stockList';

/**
 * The part of a row that both densities show.
 *
 * The table and the rail are one list, so the columns they share must be the
 * same markup at the same size — not two renderings that happen to look
 * similar. Anything else and clicking a stock makes every row jump: the list
 * was 56px tall on one side of the click and 30px on the other, which reads as
 * arriving somewhere new rather than as the same list with its extra columns
 * folded away.
 *
 * Only the columns that disappear are allowed to differ. The sector is the one
 * exception inside this block: it is drawn when there is width for it, which in
 * practice means the table.
 */

interface IdentityProps {
  row:     OverviewRow;
  active:  boolean;
  /** Stages the queue has in flight for this symbol; replaces the ticker. */
  stages?: string[];
  /** Append `· Sector` to the ticker. Off at rail width, where it doesn't fit. */
  showSector?: boolean;
}

export function StockIdentity({ row, active, stages = [], showSector = false }: IdentityProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ConsensusBar consensus={row.consensus} height={22} />
      <StockLogo
        domain={row.logoDomain}
        symbol={row.symbol}
        fallbackInitials={initialsFromName(row.companyName)}
        size={20}
      />
      {/* A stock outside the watchlist recedes rather than carrying a badge:
          at rail width a badge costs more room than the fact is worth, and the
          two densities have to agree. The title says it in full. */}
      <span
        className={`min-w-0 flex-1 truncate text-sm font-medium ${
          active ? 'text-ink-50' : row.watched ? 'text-ink-200' : 'text-ink-400'
        }`}
      >
        {row.companyName}
      </span>

      {stages.length > 0 ? (
        // Replaces the ticker rather than sitting beside it: while something is
        // running that is the more useful of the two.
        <span
          className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-accent"
          title={`Running: ${stages.join(', ')}`}
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {stages[0]}
        </span>
      ) : (
        <span className="shrink-0 truncate font-mono text-[11px] text-ink-500">
          {row.symbol}
          {showSector && row.sector && <span className="text-ink-600"> · {row.sector}</span>}
        </span>
      )}
    </div>
  );
}

/**
 * Score and its change since the first recorded verdict.
 *
 * Both sit in fixed-width slots so the numbers line up down the list — a
 * ranking whose ranking column wanders is hard to read — and so the block is
 * exactly as wide in the rail as in the table.
 */
export function StockScore({ row }: { row: OverviewRow }) {
  const delta = row.scoreDelta;
  return (
    <span className="flex shrink-0 items-center justify-end gap-0.5">
      <span
        className={`w-7 text-right text-[9px] tabular ${
          (delta ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'
        }`}
        title={delta ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)} seit dem ersten Verdict` : undefined}
      >
        {delta ? `${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(1)}` : ''}
      </span>
      <span className={`w-6 text-right font-mono text-sm font-semibold tabular ${scoreColor(row.aiScore)}`}>
        {row.aiScore === null ? '—' : row.aiScore.toFixed(1)}
      </span>
    </span>
  );
}

/** What the `title` of a row says, in either density. */
export function rowTitle(row: OverviewRow, fmtBig: (n: number | null, c: string | null) => string): string {
  return [
    row.companyName,
    row.sector ?? '—',
    fmtBig(row.marketCap, row.currency),
    row.aiScore === null ? 'nicht bewertet' : `Score ${row.aiScore.toFixed(1)}`,
    row.watched ? null : 'nicht in der Watchlist — wird vom nächtlichen Lauf übersprungen',
  ].filter(Boolean).join(' · ');
}
