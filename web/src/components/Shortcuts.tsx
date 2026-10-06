import { useEffect } from 'react';
import { CloseIcon } from './icons';
import { STOCK_TABS } from './StockTabs';

/**
 * The keys the app answers to, in one list: the help dialog shows it, and
 * the hints elsewhere ("Suchen /") quote from it.
 *
 * Letters rather than the arrow keys for moving between stocks: ↑ and ↓
 * scroll the page, and a stock page is read by scrolling.
 */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['/'],       label: 'Suche' },
  { keys: ['j', 'k'],  label: 'Nächste / vorige Aktie der Liste' },
  { keys: ['1', '…', String(STOCK_TABS.length)], label: `Themen der Aktie: ${STOCK_TABS.map((t) => t.label).join(', ')}` },
  { keys: ['['],       label: 'Liste neben der Aktie schmal / breit' },
  { keys: ['Esc'],     label: 'Zurück zur Liste, Dialog schließen' },
  { keys: ['?'],       label: 'Diese Übersicht' },
];

/** True when a key press belongs to a field being typed in, not to the app. */
export function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

/** The search field on show — the bar's on a wide screen, the drawer's on a phone. */
export function focusSearch(): boolean {
  const field = [...document.querySelectorAll<HTMLInputElement>('input[data-stock-search]')]
    .find((el) => el.offsetParent !== null);
  if (!field) return false;
  field.focus();
  field.select();
  return true;
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] justify-center rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-100">
      {children}
    </kbd>
  );
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Tastenkürzel"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="text-[15px] font-semibold text-ink-50">Tastenkürzel</h2>
          <button
            onClick={onClose}
            className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
            aria-label="Schließen"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <dl className="space-y-2.5 p-4 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-baseline gap-3">
              <dt className="flex w-24 shrink-0 gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</dt>
              <dd className="text-ink-300">{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
