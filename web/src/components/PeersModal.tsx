import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { PeerRow, PeersResponse } from '../types';
import { deNumber, fmtBig } from '../format';
import { scoreColor } from './stockList';
import StockLogo, { initialsFromName } from './StockLogo';
import { CloseIcon } from './icons';

interface Props {
  symbol: string;
  onClose: () => void;
  /** Show a stock that is on the list — the dialog closes and the analysis switches. */
  onOpen: (symbol: string) => void;
  /** A peer joined the list, so the list behind the dialog should show it. */
  onAdded: () => void;
}

type SortKey = 'score' | 'marketCap';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'score',     label: 'Score' },
  { key: 'marketCap', label: 'Größe' },
];

/** An add in flight, or the error it ended with. Absent once it succeeded. */
type AddState = { busy: true } | { busy: false; error: string };

/** Descending, with the rows that have no value at the bottom in the order they came. */
function sortRows(rows: PeerRow[], key: SortKey): PeerRow[] {
  const value = (r: PeerRow) => (key === 'score' ? r.score : r.marketCap);
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va;
  });
}

/**
 * Who a stock competes with, and a way to put them on the list.
 *
 * A dialog from the header rather than one more section at the bottom of the
 * analysis: the question „who else is in this business?" comes up when a stock
 * is opened, not after scrolling past its valuation models, and answering it
 * ends in adding companies to the list — a moment, not a state.
 *
 * Two groups, because they answer slightly different questions. Finnhub's peer
 * group is what the peer medians on the analysis page are computed from; the
 * industry is Yahoo's classification across everything stored, which also
 * covers the European listings Finnhub's free tier has no peers for.
 */
export default function PeersModal({ symbol, onClose, onOpen, onAdded }: Props) {
  const [data, setData] = useState<PeersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('score');
  const [adds, setAdds] = useState<Record<string, AddState>>({});

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.getPeers(symbol)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [symbol]);

  // Esc closes this and nothing else — the app's own Esc handler stands down
  // while it is open, so the analysis underneath is not closed along with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Add one peer: the data layer only, exactly like the field at the bottom of
   * the window. The row becomes a list row in place rather than the dialog
   * reloading, so the rows do not reshuffle under the pointer.
   */
  async function add(row: PeerRow) {
    setAdds((s) => ({ ...s, [row.symbol]: { busy: true } }));
    try {
      const res = await api.addStock(row.symbol);
      const patch = (r: PeerRow): PeerRow => r.symbol !== row.symbol ? r : {
        ...r,
        // The refresh may tidy the ticker; open what was actually stored.
        symbol:      res.symbol,
        companyName: res.summary?.companyName ?? r.companyName,
        logoDomain:  res.summary?.logoDomain ?? r.logoDomain,
        price:       res.summary?.price ?? r.price,
        marketCap:   res.summary?.marketCap ?? r.marketCap,
        currency:    res.summary?.currency ?? r.currency,
        status:      'list',
      };
      setData((d) => d && { ...d, peers: d.peers.map(patch), industryPeers: d.industryPeers.map(patch) });
      setAdds((s) => {
        const { [row.symbol]: _, ...rest } = s;
        return rest;
      });
      onAdded();
    } catch (e) {
      setAdds((s) => ({ ...s, [row.symbol]: { busy: false, error: (e as Error).message } }));
    }
  }

  const peers = useMemo(() => (data ? sortRows(data.peers, sort) : []), [data, sort]);
  const industryPeers = useMemo(() => (data ? sortRows(data.industryPeers, sort) : []), [data, sort]);
  const addable = [...peers, ...industryPeers].filter((r) => r.status !== 'list').length;

  const line = (row: PeerRow) => (
    <PeerLine
      key={row.symbol}
      row={row}
      add={adds[row.symbol]}
      onAdd={() => { void add(row); }}
      onOpen={() => onOpen(row.symbol)}
    />
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Peers von ${symbol}`}
    >
      <div
        // Clicks inside must not reach the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink-100">
              Peers &amp; Konkurrenten <span className="font-mono text-ink-400">{symbol}</span>
            </h2>
            {data && (
              <p className="mt-0.5 text-xs text-ink-500">
                {addable === 0 ? 'Alle schon auf der Liste' : `${addable} noch nicht auf der Liste`}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded border border-ink-700 text-xs" role="group" aria-label="Sortierung">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSort(s.key)}
                  aria-pressed={sort === s.key}
                  className={`px-2 py-1 transition ${
                    sort === s.key ? 'bg-ink-700 text-ink-50' : 'bg-ink-900 text-ink-400 hover:bg-ink-800 hover:text-ink-200'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
              title="Schließen (Esc)"
              aria-label="Schließen"
            >
              <CloseIcon size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {error && <p className="text-xs text-red-400">⚠ {error}</p>}
          {!data && !error && <p className="text-xs text-ink-500">Lade…</p>}

          {data && (
            <>
              <ul className="rounded border border-accent bg-accent-soft">
                <PeerLine row={data.self} self />
              </ul>

              <Group
                title="Peer-Gruppe"
                hint="Finnhub — aus diesen Firmen stammen die Mediane im Peer-Vergleich der Analyse"
                empty={`Finnhub liefert für ${symbol} keine Peer-Gruppe — etwa bei europäischen Listings, die der Free-Tier nicht abdeckt.`}
              >
                {peers.map(line)}
              </Group>

              {data.industry && (
                <Group
                  title={`Gleiche Branche · ${data.industry}`}
                  hint="Yahoos Branchenzuordnung, aus der Liste und dem Referenz-Universum (S&P 500, DAX, EURO STOXX 50)"
                  empty="Sonst ist niemand aus dieser Branche gespeichert."
                >
                  {industryPeers.map(line)}
                </Group>
              )}
            </>
          )}
        </div>

        <footer className="shrink-0 border-t border-ink-800 px-4 py-2.5 text-xs leading-snug text-ink-500">
          Hinzufügen holt nur die Daten, ohne LLM-Aufruf. Die nächtliche Pipeline analysiert neue Aktien danach mit.
          Scores aus dem Universum rechnen nur mit Zahlen, ohne Text-Analyse.
        </footer>
      </div>
    </div>
  );
}

function Group({ title, hint, empty, children }: {
  title: string;
  hint: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-ink-300">{title}</h3>
      <p className="mb-2 mt-0.5 text-xs leading-snug text-ink-500">{hint}</p>
      {children.length === 0
        ? <p className="text-xs text-ink-500">{empty}</p>
        : <ul className="divide-y divide-ink-800 rounded border border-ink-800 bg-ink-950">{children}</ul>}
    </section>
  );
}

const STATUS_NOTE: Record<PeerRow['status'], string | null> = {
  list:      null,
  reference: 'Universum',
  unknown:   'noch nie geladen',
};

function PeerLine({ row, self = false, add, onAdd, onOpen }: {
  row: PeerRow;
  /** The stock the dialog was opened from — shown for comparison, with no action. */
  self?: boolean;
  add?: AddState;
  onAdd?: () => void;
  onOpen?: () => void;
}) {
  const name = row.companyName ?? row.symbol;
  const note = self ? 'diese Aktie' : STATUS_NOTE[row.status];
  const scoreTitle = row.score === null
    ? 'Noch nicht bewertet'
    : `${row.verdict ?? ''} ${deNumber(row.score, 1)}${row.status === 'reference' ? ' — nur aus den Zahlen' : ''}`.trim();

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <StockLogo
        domain={row.logoDomain}
        symbol={row.symbol}
        fallbackInitials={initialsFromName(name)}
        size={22}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink-100">{name}</div>
        <div className="truncate font-mono text-2xs text-ink-500">
          {row.symbol}{note ? ` · ${note}` : ''}
        </div>
      </div>
      <span className="hidden w-24 shrink-0 text-right font-mono text-xs text-ink-300 tabular sm:block">
        {row.marketCap === null ? '—' : fmtBig(row.marketCap, row.currency)}
      </span>
      <span
        className={`w-9 shrink-0 text-right font-mono text-sm font-semibold tabular ${scoreColor(row.score)}`}
        title={scoreTitle}
      >
        {row.score === null ? '—' : deNumber(row.score, 1)}
      </span>
      <div className="flex w-28 shrink-0 justify-end">
        {self ? null : row.status === 'list' ? (
          <button
            onClick={onOpen}
            className="rounded px-2 py-1 text-xs text-accent transition hover:bg-ink-800"
            title={`${name} öffnen`}
          >
            Öffnen →
          </button>
        ) : add?.busy ? (
          <span className="px-2 py-1 text-xs text-ink-400">Hole Daten…</span>
        ) : (
          <button
            onClick={onAdd}
            className={`rounded border px-2 py-1 text-xs font-medium transition ${
              add && !add.busy
                ? 'border-red-700 text-red-400 hover:bg-red-950'
                : 'border-ink-700 bg-ink-800 text-ink-200 hover:border-accent hover:text-ink-50'
            }`}
            title={add && !add.busy ? `Fehlgeschlagen: ${add.error} — nochmal versuchen` : 'Zur Liste hinzufügen — holt nur die Daten'}
          >
            {add && !add.busy ? '↻ Nochmal' : '+ Hinzufügen'}
          </button>
        )}
      </div>
    </li>
  );
}
