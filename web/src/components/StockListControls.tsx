import { SORTS, type ListView } from './stockList';

interface Props {
  view:     ListView;
  onChange: (next: ListView) => void;
  /**
   * `row` lays the three controls out side by side (the table's header bar);
   * `stack` puts the search on its own line above the other two (the rail,
   * where 320px leaves no room for three controls abreast).
   */
  layout:   'row' | 'stack';
  /** Placeholder for the search box — the two densities phrase it differently. */
  placeholder?: string;
}

/**
 * Search, sort and the watchlist filter.
 *
 * One component for both densities: the controls drive the same `ListView`, so
 * a filter typed in the rail is still applied when the table comes back, and a
 * sort chosen in the table is the order the rail shows. Having them defined
 * twice is how the two views would start disagreeing about what "sorted" means.
 */
export default function StockListControls({ view, onChange, layout, placeholder }: Props) {
  const search = (
    <input
      type="search"
      value={view.query}
      onChange={(e) => onChange({ ...view, query: e.target.value })}
      placeholder={placeholder ?? 'Filtern nach Symbol, Name, Sektor…'}
      className={`rounded border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none ${
        layout === 'stack' ? 'w-full' : 'w-56'
      }`}
    />
  );

  const watched = (
    <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
      <input
        type="checkbox"
        checked={view.onlyWatched}
        onChange={(e) => onChange({ ...view, onlyWatched: e.target.checked })}
        className="accent-[var(--color-accent)]"
      />
      nur Watchlist
    </label>
  );

  const sort = (
    <label className="flex min-w-0 shrink items-center gap-1.5 text-[11px] text-ink-400">
      <span className="shrink-0">Sortierung</span>
      <select
        value={view.sort}
        onChange={(e) => onChange({ ...view, sort: e.target.value as ListView['sort'] })}
        className="min-w-0 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[11px] text-ink-200 focus:border-accent focus:outline-none"
      >
        {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    </label>
  );

  if (layout === 'stack') {
    return (
      <div className="flex flex-col gap-2">
        {search}
        <div className="flex items-center justify-between gap-2">
          {sort}
          {watched}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {search}
      {watched}
      {sort}
    </div>
  );
}
