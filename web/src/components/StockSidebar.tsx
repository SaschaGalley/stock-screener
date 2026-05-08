import { useState, useMemo } from 'react';
import type { StockSummary } from '../types';
import { api } from '../api';
import StockLogo, { initialsFromName } from './StockLogo';

interface Props {
  stocks: StockSummary[];
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
  onDeleted: (symbol: string) => void;
}

function fmtMcap(n: number | null): string {
  if (n === null) return '';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

export default function StockSidebar({ stocks, selectedSymbol, onSelect, onDeleted }: Props) {
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
              return (
                <li key={s.symbol} className="group relative">
                  <button
                    onClick={() => onSelect(s.symbol)}
                    disabled={isDeleting}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 pr-9 text-left transition disabled:opacity-50 ${
                      active
                        ? 'bg-accent-soft border-l-2 border-l-accent'
                        : 'border-l-2 border-l-transparent hover:bg-ink-800'
                    }`}
                  >
                    <StockLogo
                      domain={s.logoDomain}
                      symbol={s.symbol}
                      fallbackInitials={initialsFromName(s.companyName)}
                      size={28}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-sm font-medium ${active ? 'text-ink-50' : 'text-ink-200'}`}>
                          {s.companyName}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-ink-500">{s.symbol}</span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 text-[11px] text-ink-500">
                        <span className="truncate">{s.sector ?? '—'}</span>
                        <span className="tabular shrink-0">{fmtMcap(s.marketCap)}</span>
                      </div>
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
