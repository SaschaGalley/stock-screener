import { useState, FormEvent } from 'react';
import type { Settings } from '../types';

interface Props {
  settings: Settings;
  loading: boolean;
  onAnalyze: (input: string) => void;
}

function looksLikeSymbol(input: string): boolean {
  const t = input.trim();
  if (!t || t.includes(' ')) return false;
  return /^[A-Za-z][A-Za-z0-9.\-/:]{0,9}$/.test(t);
}

export default function AnalyzeForm({ settings, loading, onAnalyze }: Props) {
  const [input, setInput] = useState('');
  const inputType = looksLikeSymbol(input) ? 'symbol' : input.trim() ? 'query' : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    onAnalyze(input.trim());
  }

  const searchLabel = settings.searches.length === 0
    ? 'none'
    : [...settings.searches].sort().join('+');
  const flagsLabel = [
    `model=${settings.model}`,
    `search=${searchLabel}`,
    settings.pplx ? `pplx=${settings.pplx}` : 'pplx=none',
  ].join(' · ');

  return (
    <form
      onSubmit={submit}
      className="border-t border-ink-800 bg-ink-900 px-4 py-3"
    >
      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-500">
        <span>Analyze stock</span>
        <span className="font-mono">{flagsLabel}</span>
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ticker (AAPL, NVDA, FACC) or company name (Siemens Energy)…"
            className="w-full rounded border border-ink-700 bg-ink-950 px-3 py-2 pr-20 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
            disabled={loading}
          />
          {inputType && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-400">
              {inputType}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={!input.trim() || loading}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-500"
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
    </form>
  );
}
