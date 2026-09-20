import { useState, type MutableRefObject } from 'react';
import type { OverviewRow } from '../types';
import { api } from '../api';
import { fmtBig } from '../format';
import StockListControls from './StockListControls';
import { StockIdentity, StockScore, rowTitle, ROW_HEIGHT } from './StockRowCells';
import { useListScroll, type ListScrollAnchor } from './useListScroll';
import { type ListView } from './stockList';

interface Props {
  /** Already filtered and sorted — see `applyListView`. */
  rows:  OverviewRow[];
  /** How many stocks exist before filtering. */
  total: number;
  /** Symbol → stages the queue currently has in flight for it. */
  activity?: Record<string, string[]>;
  view:     ListView;
  onViewChange: (next: ListView) => void;
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
  onDeleted: (symbol: string) => void;
  /** Shared with the table, so collapsing the columns doesn't move the list. */
  scrollAnchor: MutableRefObject<ListScrollAnchor>;
  /** Hidden rather than unmounted while the table is up — see `useListScroll`. */
  visible: boolean;
}

/**
 * The stock list at rail width, beside an open analysis.
 *
 * The same rows in the same order — and, for the columns both have room for,
 * the same markup at the same height (see `StockRowCells`). This is the table
 * with the columns 320px cannot hold taken away; nothing about the rows that
 * stay is redrawn differently, so clicking a stock folds the list rather than
 * replacing it.
 */
export default function StockRail({
  rows, total, activity = {}, view, onViewChange,
  selectedSymbol, onSelect, onDeleted, scrollAnchor, visible,
}: Props) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const { containerRef, onScroll } = useListScroll(scrollAnchor, visible, selectedSymbol, rows.length);

  async function handleDelete(symbol: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete all cached data for ${symbol}? This removes financials, market signals, news, all analyses and reports.`)) return;
    setDeleting(symbol);
    try {
      await api.deleteStock(symbol);
      onDeleted(symbol);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <aside className="flex h-full w-80 flex-col border-r border-ink-700 bg-ink-900">
      {/* One control tall, matching the table's header exactly — see the
          `badge` note in StockListControls. Sorting and the watchlist filter
          live in the table, where you order the list; the rail inherits that
          order and spends its height on stocks. */}
      <div className="border-b border-ink-700 px-3 py-2">
        <StockListControls
          view={view}
          onChange={onViewChange}
          layout="rail"
          badge={rows.length !== total ? `${rows.length}/${total}` : String(total)}
        />
      </div>

      <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-center text-sm text-ink-500">
            {total === 0 ? 'Noch keine Aktien im Cache — unten eine hinzufügen.' : 'Keine Treffer'}
          </div>
        ) : (
          <ul>
            <li className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-700 bg-ink-900 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              <span>Aktie</span>
              <span>Score</span>
            </li>
            {rows.map((r) => {
              const active = r.symbol === selectedSymbol;
              const isDeleting = deleting === r.symbol;
              return (
                <li
                  key={r.symbol}
                  data-stock-row
                  data-symbol={r.symbol}
                  data-selected={active}
                  className="group relative"
                >
                  <button
                    onClick={() => onSelect(r.symbol)}
                    disabled={isDeleting}
                    title={active
                      ? `${rowTitle(r, fmtBig)} · Klick schließt die Analyse`
                      : rowTitle(r, fmtBig)}
                    className={`${ROW_HEIGHT} flex w-full items-center gap-2 border-b border-ink-800 py-2 pr-7 text-left transition disabled:opacity-50 ${
                      active
                        ? 'border-l-2 border-l-accent bg-accent-soft pl-[10px]'
                        : 'pl-3 hover:bg-ink-800'
                    }`}
                  >
                    <StockIdentity row={r} active={active} stages={activity[r.symbol]} />
                    <StockScore row={r} />
                  </button>
                  <button
                    onClick={(e) => handleDelete(r.symbol, e)}
                    disabled={isDeleting}
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-600 opacity-0 transition hover:bg-red-900 hover:text-red-400 group-hover:opacity-100"
                    title={`Delete ${r.symbol} cache`}
                  >
                    {isDeleting ? '…' : '🗑'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
