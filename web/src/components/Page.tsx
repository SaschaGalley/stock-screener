import type { ReactNode } from 'react';

/**
 * A page of the app other than the list: its header, then its content.
 *
 * Every page used to head itself — a small title, a grey line, a ✕ in the
 * corner, each a little different, scrolling away with the content. With
 * the column of destinations at the left there is nothing to close: a page
 * is left by going somewhere else, and Esc still leads back to the list. The
 * header stays put, the same height and type on every page, with the page's
 * own controls at its right end.
 */
export default function Page({ title, subtitle, actions, width = 'max-w-5xl', children }: {
  title:     string;
  /** What the page shows, or what it found — one line. */
  subtitle?: ReactNode;
  /** The page's own controls: a range, a refresh, a save. */
  actions?:  ReactNode;
  /** How wide the content runs; the header always spans the page. */
  width?:    string;
  children:  ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-700 bg-ink-900 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight text-ink-50">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-ink-400">{subtitle}</div>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto space-y-4 p-4 sm:p-6 ${width}`}>{children}</div>
      </div>
    </div>
  );
}

/** A quiet button for a page header's right end. */
export function HeaderButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
