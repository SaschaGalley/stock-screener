import type { ReactNode } from 'react';

/**
 * Top-level navigation. Tabs on the left in reading order (the analysis view
 * the app has always opened on stays first), utilities on the right — the cog
 * sits at the far edge because administration is a destination you visit
 * rarely, not a peer of the working views.
 */
export type Route =
  | { view: 'analysis'; symbol: string | null }
  | { view: 'overview' }
  | { view: 'admin' };

export type ViewName = Route['view'];

interface Props {
  view: ViewName;
  onNavigate: (view: ViewName) => void;
  /** Rendered between the tabs and the cog — currently the mobile drawer toggles. */
  left?:  ReactNode;
  right?: ReactNode;
  /** Small live badge (e.g. "Job läuft") shown next to the cog. */
  status?: ReactNode;
}

/**
 * Gear as an SVG rather than the „⚙" glyph: the glyph renders at the font's
 * own idea of size (and differently per platform), which left it noticeably
 * smaller than the tab labels next to it. An icon scales to exactly what we ask
 * for and inherits the button's colour.
 */
function GearIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15.6 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const TABS: { view: ViewName; label: string; title: string }[] = [
  { view: 'analysis', label: 'Analyse',  title: 'Detailanalyse einer Aktie' },
  { view: 'overview', label: 'Übersicht', title: 'Alle Aktien nach Score sortiert' },
];

export default function Toolbar({ view, onNavigate, left, right, status }: Props) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
      {left}

      {/* Underline, not a filled pill: the tab strip sits directly on the
          toolbar's bottom border, so an accent rule under the active label
          marks it without adding a second coloured surface to the chrome. */}
      <nav className="flex items-center gap-1" role="tablist">
        {TABS.map((tab) => {
          const active = view === tab.view;
          return (
            <button
              key={tab.view}
              role="tab"
              aria-selected={active}
              title={tab.title}
              onClick={() => onNavigate(tab.view)}
              className={`border-b-2 px-3 pb-1.5 pt-1 text-sm transition ${
                active
                  ? 'border-accent font-semibold text-ink-50'
                  : 'border-transparent font-medium text-ink-400 hover:border-ink-600 hover:text-ink-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {status}
        {right}
        <button
          role="tab"
          aria-selected={view === 'admin'}
          onClick={() => onNavigate('admin')}
          title="Administration — Cronjobs, Watchlist, Modelle"
          className={`rounded p-1 transition ${
            view === 'admin' ? 'text-accent' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
          }`}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
