import { useEffect, useState } from 'react';
import { api } from '../api';
import type { VerdictChangesResponse } from '../types';
import { recommendationColor, relativeTime } from '../format';

/** How far back the strip looks; older moves are history, not news. */
const WINDOW_DAYS = 7;
const MAX_SHOWN = 8;
const RELOAD_MS = 10 * 60_000;

type Change = VerdictChangesResponse['changes'][number];

/**
 * What moved since last week, above the list.
 *
 * Every band change on the watchlist is recorded when it happens; this strip
 * shows the recent ones so nobody has to compare two days of the table by
 * eye. A symbol that flipped back and forth shows both moves — the webhook
 * announces only the ones that held.
 */
export default function VerdictChanges({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [changes, setChanges] = useState<Change[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getVerdictChanges(40)
        .then((r) => { if (alive) setChanges(r.changes); })
        .catch(() => { /* a missing strip is not an error worth showing */ });
    };
    load();
    const t = window.setInterval(load, RELOAD_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const recent = changes.filter((c) => Date.parse(c.at) >= since).slice(0, MAX_SHOWN);
  if (recent.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 bg-ink-900/60 px-4 py-1.5 text-[11px]">
      <span className="text-ink-500">Urteilswechsel ({WINDOW_DAYS} Tage)</span>
      {recent.map((c) => (
        <button
          key={`${c.symbol}-${c.at}`}
          onClick={() => onSelect(c.symbol)}
          title={`${c.companyName ?? c.symbol}: ${c.from}${c.fromScore !== null ? ` (${c.fromScore.toFixed(1)})` : ''} → ${c.to}`
            + `${c.toScore !== null ? ` (${c.toScore.toFixed(1)})` : ''} · ${c.source === 'analysis' ? 'Analyse' : 'Datenaktualisierung'}`}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-ink-800"
        >
          <span className="font-mono text-ink-200">{c.symbol}</span>
          <span className={`rounded px-1 text-[10px] font-bold ${recommendationColor(c.from)}`}>{c.from}</span>
          <span className="text-ink-500">→</span>
          <span className={`rounded px-1 text-[10px] font-bold ${recommendationColor(c.to)}`}>{c.to}</span>
          <span className="text-ink-600">{relativeTime(c.at)}</span>
        </button>
      ))}
    </div>
  );
}
