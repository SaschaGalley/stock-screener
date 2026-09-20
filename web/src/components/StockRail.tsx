import { useEffect, useRef, useState } from 'react';
import type { OverviewRow } from '../types';
import { api } from '../api';
import { fmtBig } from '../format';
import StockLogo, { initialsFromName } from './StockLogo';
import ConsensusBar from './ConsensusBar';
import StockListControls from './StockListControls';
import { scoreColor, type ListView } from './stockList';

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
}

/**
 * The stock list at rail width, beside an open analysis.
 *
 * The same rows in the same order as `StockTable` — this is that table with
 * the columns it has no room for taken away, which is why the score stays: it
 * is the number the default order is built on, and a ranked list that doesn't
 * show its ranking number is just a list. Watchlist state recedes into the
 * name's tone instead of the table's badge; at 320px a badge would cost more
 * width than the fact is worth here.
 */
export default function StockRail({
  rows, total, activity = {}, view, onViewChange,
  selectedSymbol, onSelect, onDeleted,
}: Props) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const selectedRef = useRef<HTMLLIElement | null>(null);

  // Arriving from the table — or stepping through symbols — should never leave
  // the current one scrolled out of sight.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedSymbol]);

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
      {/* Two rows, as the old sidebar had: every row of chrome here is a stock
          the list cannot show. Sorting and the watchlist filter live in the
          table, and the rail inherits whatever order was chosen there. */}
      <div className="flex flex-col gap-2 border-b border-ink-700 px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
          Übersicht{' '}
          <span className="font-normal normal-case tracking-normal text-ink-600">
            ({rows.length}{rows.length !== total ? ` von ${total}` : ''})
          </span>
        </h2>
        <StockListControls view={view} onChange={onViewChange} layout="rail" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-center text-sm text-ink-500">
            {total === 0 ? 'Noch keine Aktien im Cache — unten eine hinzufügen.' : 'Keine Treffer'}
          </div>
        ) : (
          <ul className="py-1">
            {rows.map((r) => {
              const active = r.symbol === selectedSymbol;
              const isDeleting = deleting === r.symbol;
              const stages = activity[r.symbol] ?? [];
              return (
                <li key={r.symbol} ref={active ? selectedRef : undefined} className="group relative">
                  <button
                    onClick={() => onSelect(r.symbol)}
                    disabled={isDeleting}
                    className={`flex w-full items-center gap-1.5 px-3 py-1 pr-8 text-left transition disabled:opacity-50 ${
                      active
                        ? 'bg-accent-soft border-l-2 border-l-accent'
                        : 'border-l-2 border-l-transparent hover:bg-ink-800'
                    }`}
                    title={[
                      r.companyName,
                      r.sector ?? '—',
                      fmtBig(r.marketCap, r.currency),
                      r.aiScore === null ? 'nicht bewertet' : `Score ${r.aiScore.toFixed(1)}`,
                      r.watched ? null : 'nicht in der Watchlist',
                    ].filter(Boolean).join(' · ')}
                  >
                    <ConsensusBar consensus={r.consensus} height={22} />
                    <StockLogo
                      domain={r.logoDomain}
                      symbol={r.symbol}
                      fallbackInitials={initialsFromName(r.companyName)}
                      size={20}
                    />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm font-medium ${
                        active ? 'text-ink-50' : r.watched ? 'text-ink-200' : 'text-ink-400'
                      }`}
                    >
                      {r.companyName}
                    </span>

                    {stages.length > 0 ? (
                      // Replaces the ticker rather than sitting beside it: the
                      // row is narrow, and while something is running that is
                      // the more useful of the two.
                      <span
                        className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-accent"
                        title={`Running: ${stages.join(', ')}`}
                      >
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                        {stages[0]}
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-[11px] text-ink-500">{r.symbol}</span>
                    )}

                    {/* The direction marker sits in a fixed slot ahead of the
                        number, so the scores stay a column: a triangle appended
                        after the digits shifts them, and a ranked list whose
                        ranking numbers don't line up is hard to read down. */}
                    <span
                      className={`w-2 shrink-0 text-right text-[8px] ${
                        (r.scoreDelta ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                      title={r.scoreDelta
                        ? `${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta.toFixed(1)} seit dem ersten Verdict`
                        : undefined}
                    >
                      {r.scoreDelta ? (r.scoreDelta > 0 ? '▲' : '▼') : ''}
                    </span>
                    <span className={`w-6 shrink-0 text-right font-mono text-xs font-semibold tabular ${scoreColor(r.aiScore)}`}>
                      {r.aiScore === null ? '—' : r.aiScore.toFixed(1)}
                    </span>
                  </button>
                  <button
                    onClick={(e) => handleDelete(r.symbol, e)}
                    disabled={isDeleting}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-ink-600 opacity-0 transition hover:bg-red-900 hover:text-red-400 group-hover:opacity-100"
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
