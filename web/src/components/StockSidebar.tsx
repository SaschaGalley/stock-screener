import { useState, useMemo } from 'react';
import type { StockSummary } from '../types';
import { api } from '../api';
import { fmtBig } from '../format';
import StockLogo, { initialsFromName } from './StockLogo';
import ConsensusBar from './ConsensusBar';

interface Props {
  stocks: StockSummary[];
  /** Symbol → stages the queue currently has in flight for it. */
  activity?: Record<string, string[]>;
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
  onDeleted: (symbol: string) => void;
}

export default function StockSidebar({ stocks, activity = {}, selectedSymbol, onSelect, onDeleted }: Props) {
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!filter.trim()) return stocks;
    const q = filter.toLowerCase().trim();
    return stocks.filter(
      (s) =>
        s.symbol.toLowerCase().includes(q) ||
        s.companyName.toLowerCase().includes(q) ||
        (s.sector ?? '').toLowerCase().includes(q),
    );
  }, [stocks, filter]);

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
    <aside className="flex h-full w-72 flex-col border-r border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 px-3 py-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
          Cached Stocks ({stocks.length})
        </h2>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by symbol, name, sector…"
          className="w-full rounded border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-sm text-ink-500">
            {filter ? 'No matches' : 'No stocks cached yet — analyze one below.'}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((s) => {
              const active = s.symbol === selectedSymbol;
              const isDeleting = deleting === s.symbol;
              const stages = activity[s.symbol] ?? [];
              return (
                <li key={s.symbol} className="group relative">
                  <button
                    onClick={() => onSelect(s.symbol)}
                    disabled={isDeleting}
                    className={`flex w-full items-center gap-2 px-3 py-1 pr-9 text-left transition disabled:opacity-50 ${
                      active
                        ? 'bg-accent-soft border-l-2 border-l-accent'
                        : 'border-l-2 border-l-transparent hover:bg-ink-800'
                    }`}
                    title={`${s.companyName} · ${s.sector ?? '—'} · ${fmtBig(s.marketCap)}`}
                  >
                    <ConsensusBar consensus={s.consensus} height={22} />
                    <StockLogo
                      domain={s.logoDomain}
                      symbol={s.symbol}
                      fallbackInitials={initialsFromName(s.companyName)}
                      size={20}
                    />
                    <div className="min-w-0 flex-1 flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm font-medium ${active ? 'text-ink-50' : 'text-ink-200'}`}>
                        {s.companyName}
                      </span>
                      {stages.length > 0 ? (
                        // Replaces the ticker rather than sitting beside it:
                        // the row is narrow, and while something is running
                        // that is the more useful of the two.
                        <span
                          className="shrink-0 flex items-center gap-1 font-mono text-[11px] text-accent"
                          title={`Running: ${stages.join(', ')}`}
                        >
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                          {stages[0]}
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-[11px] text-ink-500">{s.symbol}</span>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={(e) => handleDelete(s.symbol, e)}
                    disabled={isDeleting}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-600 opacity-0 transition hover:bg-red-900 hover:text-red-400 group-hover:opacity-100"
                    title={`Delete ${s.symbol} cache`}
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
