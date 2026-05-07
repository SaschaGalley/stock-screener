import { useState, useEffect, ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  rightHeader?: ReactNode;
  /** Stable key used to persist open state in localStorage. Defaults to title. */
  storageKey?: string;
}

const STORAGE_PREFIX = 'stockcli:section:';

function readStoredOpen(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === '0') return false;
    if (raw === '1') return true;
    return fallback;
  } catch { return fallback; }
}

function writeStoredOpen(key: string, open: boolean): void {
  try { localStorage.setItem(STORAGE_PREFIX + key, open ? '1' : '0'); } catch { /* ignore */ }
}

export default function Section({ title, subtitle, defaultOpen = true, children, rightHeader, storageKey }: Props) {
  const key = storageKey ?? title;
  const [open, setOpen] = useState(() => readStoredOpen(key, defaultOpen));

  useEffect(() => { writeStoredOpen(key, open); }, [key, open]);

  return (
    <section className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
      <button
        onClick={() => setOpen((x) => !x)}
        className="flex w-full items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2.5 text-left transition hover:bg-ink-800"
        aria-expanded={open}
      >
        <div className="flex items-baseline gap-3">
          <span className={`text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {subtitle && <span className="text-[11px] text-ink-500">{subtitle}</span>}
        </div>
        {rightHeader && <div className="flex items-center gap-2">{rightHeader}</div>}
      </button>
      {open && <div className="p-4">{children}</div>}
    </section>
  );
}
