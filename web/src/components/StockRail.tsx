import { Fragment, useEffect, useState, type MutableRefObject } from 'react';
import type { OverviewRow } from '../types';
import { api } from '../api';
import { deNumber, fmtBig } from '../format';
import StockListControls from './StockListControls';
import {
  StockIdentity, StockScore, GroupName, GroupAverage, rowTitle, ROW_HEIGHT, HEADER_HEIGHT, GROUP_HEIGHT,
} from './StockRowCells';
import { useListScroll, type ListScrollAnchor } from './useListScroll';
import { groupRows, scoreColor, toggleGroup, type ListView } from './stockList';
import Tip from './Tip';
import { Kbd } from './Shortcuts';
import Term from './Term';

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
  /** Down to tickers and scores, for the page's sake — wide screens only; the phone's drawer is always whole. */
  narrow?: boolean;
  onToggleNarrow?: () => void;
}

/** The width from which the rail is a column beside the page rather than a drawer over it — Tailwind's `lg`. */
const WIDE = '(min-width: 1024px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
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
  selectedSymbol, onSelect, onDeleted, scrollAnchor, visible, narrow = false, onToggleNarrow,
}: Props) {
  const wide = useWide();
  const slim = narrow && wide;
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

  const groups = groupRows(rows, view.group);

  // One stock — the same under a group heading as in the plain list.
  const renderRow = (r: OverviewRow) => {
    const active = r.symbol === selectedSymbol;
    if (slim) {
      return (
        <li key={r.symbol} data-stock-row data-symbol={r.symbol} data-selected={active}>
          <Tip focusable={false} className="block" content={
            <><div className="font-semibold text-ink-100">{r.companyName}</div><div className="text-ink-400">{rowTitle(r, fmtBig)}</div></>
          }>
            <button
              onClick={() => onSelect(r.symbol)}
              className={`${ROW_HEIGHT} flex w-full flex-col items-center justify-center border-b border-ink-800 leading-tight transition ${
                active ? 'border-l-2 border-l-accent bg-accent-soft' : 'hover:bg-ink-800'
              }`}
            >
              <span className={`font-mono text-xs ${active ? 'text-ink-50' : 'text-ink-200'}`}>{r.symbol}</span>
              <span className={`font-mono text-sm font-semibold tabular ${scoreColor(r.score)}`}>
                {r.score === null ? '—' : deNumber(r.score, 1)}
              </span>
            </button>
          </Tip>
        </li>
      );
    }
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
          className={`${ROW_HEIGHT} flex w-full items-center gap-2 border-b border-ink-800 py-1 pr-7 text-left transition disabled:opacity-50 ${
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
  };

  return (
    <aside className={`flex h-full flex-col border-r border-ink-700 bg-ink-900 ${slim ? 'w-[84px]' : 'w-80'}`}>
      {/* From `lg` up the search is in the bar above both lists, at the
          same place as over the table; below it the rail is a drawer over
          the page, and brings its own. */}
      <div className="border-b border-ink-700 px-3 py-2 lg:hidden">
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
            <li className={`${HEADER_HEIGHT} sticky top-0 z-10 flex items-center justify-between border-b border-ink-700 bg-ink-900 text-2xs font-semibold uppercase tracking-wider text-ink-500 ${slim ? 'justify-center' : 'pl-3 pr-1'}`}>
              {!slim && <span>Aktie</span>}
              <span className="flex items-center gap-1">
                {!slim && <Term k="list.score">Score</Term>}
                {onToggleNarrow && (
                  <Tip focusable={false} className="hidden lg:inline-flex" content={
                    <span className="flex items-center gap-2">{slim ? 'Liste breit' : 'Liste schmal, mehr Platz für die Aktie'} <Kbd>[</Kbd></span>
                  }>
                    <button
                      onClick={onToggleNarrow}
                      aria-label={slim ? 'Liste breit' : 'Liste schmal'}
                      className="rounded px-1.5 py-0.5 text-sm normal-case tracking-normal text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                    >
                      {slim ? '»' : '«'}
                    </button>
                  </Tip>
                )}
              </span>
            </li>
            {groups
              ? groups.map((g) => {
                  const shut = view.collapsed.includes(g.key);
                  return (
                    <Fragment key={g.key}>
                      {/* Sticky below the column labels, as in the table. */}
                      <li data-group-row className="sticky top-8 z-[5]">
                        <button
                          type="button"
                          aria-expanded={!shut}
                          onClick={() => onViewChange(toggleGroup(view, g.key))}
                          className={`${GROUP_HEIGHT} flex w-full items-center justify-between gap-2 border-b border-ink-700 bg-ink-900 transition hover:bg-ink-800 ${slim ? 'px-1.5' : 'pl-3 pr-7'}`}
                        >
                          {slim
                            ? <span className="w-full truncate text-center text-3xs uppercase tracking-wider text-ink-500">{shut ? '▸ ' : ''}{g.label}</span>
                            : <><GroupName group={g} by={view.group} collapsed={shut} /><GroupAverage group={g} /></>}
                        </button>
                      </li>
                      {!shut && g.rows.map(renderRow)}
                    </Fragment>
                  );
                })
              : rows.map(renderRow)}
          </ul>
        )}
      </div>
    </aside>
  );
}
