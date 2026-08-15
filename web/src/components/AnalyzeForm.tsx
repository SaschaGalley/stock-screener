import { useState, FormEvent } from 'react';
import { looksLikeSymbol } from '../../../src/symbols';

interface Props {
  /** Adds the stock and fetches its data — no LLM call. */
  onAdd: (input: string) => Promise<void>;
  /** True while an analysis is running elsewhere in the app. */
  analyzing: boolean;
}

/**
 * Add a stock to the list.
 *
 * Adding and analysing are deliberately separate: this fetches the data layer
 * only, which is fast and free, and leaves the LLM call to an explicit Run in
 * the settings sidebar. Typing a ticker to see what a company looks like should
 * not silently spend money.
 */
export default function AnalyzeForm({ onAdd, analyzing }: Props) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputType = looksLikeSymbol(input) ? 'symbol' : input.trim() ? 'query' : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(value);
      setInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t border-ink-800 bg-ink-900 px-4 py-3"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-ink-500">
        <span className="shrink-0">Aktie hinzufügen</span>
        <span className="truncate">
          {error
            ? <span className="text-red-400">{error}</span>
            : 'holt nur die Daten — Analyse startest du rechts'}
        </span>
      </div>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ticker oder Firmenname…"
            className="w-full rounded border border-ink-700 bg-ink-950 px-3 py-2 pr-16 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
            disabled={busy}
          />
          {inputType && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-400">
              {inputType}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={!input.trim() || busy || analyzing}
          title={analyzing ? 'Warte, bis die laufende Analyse fertig ist' : 'Ticker auflösen und Daten holen'}
          className="shrink-0 rounded bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-500 sm:px-4"
        >
          {busy ? 'Hole Daten…' : '+ Hinzufügen'}
        </button>
      </div>
    </form>
  );
}
