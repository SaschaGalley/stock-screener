import { useState, type ReactNode } from 'react';

/**
 * The second layer of a tab: what most visits do not need, one click away
 * and named, so it is clear what is behind it.
 *
 * Deliberately not remembered. A fold that remembered being open was open
 * for good after the first look, and the page grew back; this one is closed
 * again the next time the stock is opened.
 */
export default function More({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded border border-dashed border-ink-700 px-3 py-1.5 text-left text-xs text-ink-400 transition hover:border-ink-600 hover:text-ink-200"
      >
        <span className={`inline-block w-2 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        {open ? `Weniger: ${label}` : `Mehr: ${label}`}
      </button>
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </div>
  );
}

/**
 * The first `n` rows of a long list, and the button that shows the rest —
 * a table of thirty firms or forty holders reads by its top, and the rest is
 * there when wanted. Not remembered either.
 */
export function useFirst<T>(rows: readonly T[], n: number, noun: string): [readonly T[], ReactNode] {
  const [all, setAll] = useState(false);
  if (rows.length <= n + 2) return [rows, null];
  const button = (
    <button onClick={() => setAll((a) => !a)} className="mt-1.5 text-xs text-ink-400 hover:text-ink-100">
      {all ? `Nur die ersten ${n}` : `Alle ${rows.length} ${noun} anzeigen`}
    </button>
  );
  return [all ? rows : rows.slice(0, n), button];
}
