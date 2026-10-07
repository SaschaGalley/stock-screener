import type { ComponentType } from 'react';
import { ChartIcon, CompassIcon, DepotIcon, GearIcon, JournalIcon, ListIcon, PulseIcon, ReviewIcon } from './icons';
import Tip from './Tip';
import { Kbd } from './Shortcuts';

/**
 * Where the app can take you, in one place.
 *
 * The destinations used to be five small icons at the right end of the
 * table's header, explained by native tooltips a second late, and gone as
 * soon as a stock was open; the review was only a link on the depot page. On
 * a wide screen they are a column at the left edge now, each with its name
 * under it, the same on every page. On a narrow one the column would cost a
 * fifth of the width, so the same entries sit as icons in the top bar.
 */

export type NavKey = 'overview' | 'discover' | 'depot' | 'journal' | 'review' | 'feed' | 'evaluation' | 'admin';

interface Entry {
  key:   NavKey;
  label: string;
  hint:  string;
  Icon:  ComponentType<{ size?: number }>;
}

export const NAV: readonly Entry[] = [
  { key: 'overview',   label: 'Liste',      Icon: ListIcon,    hint: 'Alle Aktien der Watchlist, nach Score geordnet' },
  { key: 'discover',   label: 'Entdecken',  Icon: CompassIcon, hint: 'Aktien außerhalb der Watchlist, die einen Blick wert sind' },
  { key: 'depot',      label: 'Depot',      Icon: DepotIcon,   hint: 'Die Positionen aus umsatz gegen das Modell: Gewichte, Urteile, Begründungen' },
  { key: 'journal',    label: 'Journal',    Icon: JournalIcon, hint: 'Was ich gelesen, gedacht, gekauft und verkauft habe, und warum' },
  { key: 'review',     label: 'Rückblick',  Icon: ReviewIcon,  hint: 'Meine Käufe und Verkäufe im Nachhinein gemessen' },
  { key: 'feed',       label: 'Ereignisse', Icon: PulseIcon,   hint: 'Herabstufungen, Insider, Kurssprünge und Quartalszahlen der Watchlist' },
  { key: 'evaluation', label: 'Auswertung', Icon: ChartIcon,   hint: 'Sagt der Score die spätere Rendite voraus?' },
];
const ADMIN: Entry = { key: 'admin', label: 'Admin', Icon: GearIcon, hint: 'Cronjobs, Watchlist, Modelle' };

function Item({ e, active, onNavigate }: { e: Entry; active: boolean; onNavigate: (k: NavKey) => void }) {
  return (
    <Tip focusable={false} content={<><div className="font-semibold text-ink-100">{e.label}</div><div className="text-ink-400">{e.hint}</div></>}>
      <button
        onClick={() => onNavigate(e.key)}
        aria-current={active ? 'page' : undefined}
        className={`relative flex w-16 flex-col items-center gap-1 rounded-md py-2 text-2xs transition ${
          active ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-800/60 hover:text-ink-100'
        }`}
      >
        {active && <span className="absolute -left-1 top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <e.Icon size={20} />
        <span className="leading-none">{e.label}</span>
      </button>
    </Tip>
  );
}

/** The column at the left edge, from `lg` up. */
export default function AppNav({ active, onNavigate, onHelp }: {
  active: NavKey | null; onNavigate: (k: NavKey) => void; onHelp: () => void;
}) {
  return (
    <nav aria-label="Bereiche" className="hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-ink-700 bg-ink-900 py-2 lg:flex">
      {NAV.map((e) => <Item key={e.key} e={e} active={active === e.key} onNavigate={onNavigate} />)}
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tip focusable={false} content={<span className="flex items-center gap-2">Tastenkürzel <Kbd>?</Kbd></span>}>
          <button
            onClick={onHelp}
            aria-label="Tastenkürzel"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-ink-700 font-mono text-xs text-ink-400 transition hover:border-ink-500 hover:text-ink-100"
          >
            ?
          </button>
        </Tip>
        <Item e={ADMIN} active={active === 'admin'} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

/** The same entries as icons, for the top bar below `lg`. */
export function NavIcons({ active, onNavigate }: { active: NavKey | null; onNavigate: (k: NavKey) => void }) {
  return (
    <div className="flex items-center gap-0.5 lg:hidden">
      {[...NAV, ADMIN].map((e) => (
        <Tip key={e.key} focusable={false} content={<><div className="font-semibold text-ink-100">{e.label}</div><div className="text-ink-400">{e.hint}</div></>}>
          <button
            onClick={() => onNavigate(e.key)}
            aria-label={e.label}
            aria-current={active === e.key ? 'page' : undefined}
            className={`rounded p-1.5 transition ${active === e.key ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'}`}
          >
            <e.Icon size={18} />
          </button>
        </Tip>
      ))}
    </div>
  );
}
