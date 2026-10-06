import type { OverviewRow } from '../types';
import { deNumber } from '../format';
import StockListControls from './StockListControls';
import { averageScore, scoreColor, type ListView } from './stockList';
import { NavIcons, type NavKey } from './AppNav';

/**
 * The bar over the list, the same whether the table or a stock is open.
 *
 * The search, the watchlist filter, the sort and the grouping used to sit in
 * the table's header, and when a stock opened they became a search field in
 * the rail's corner — so the one control wanted most moved every time the
 * view did. Here it stays: same place, same width, both views.
 */
export default function AppBar({ view, onViewChange, rows, total, nav, onNavigate, detail }: {
  view:         ListView;
  onViewChange: (next: ListView) => void;
  /** The rows the filter lets through. */
  rows:         OverviewRow[];
  total:        number;
  nav:          NavKey | null;
  onNavigate:   (k: NavKey) => void;
  /** A stock is open: on a phone the filters give their row to the page. */
  detail:       boolean;
}) {
  const avg = averageScore(rows);
  const filtered = rows.length !== total;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700 bg-ink-900 px-3 py-2 sm:px-4">
      <div className={`order-last w-full md:order-none md:w-auto ${detail ? 'hidden md:block' : ''}`}>
        <StockListControls view={view} onChange={onViewChange} layout="bar" />
      </div>
      <span className="text-xs text-ink-500">
        <span className="text-ink-300">{rows.length}</span>{filtered ? ` von ${total}` : ''} Aktien
        {avg && (
          <>
            {' '}· Ø Score <span className={`font-mono ${scoreColor(avg.avg)}`}>{deNumber(avg.avg, 1)}</span>
          </>
        )}
      </span>
      <div className="ml-auto">
        <NavIcons active={nav} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
