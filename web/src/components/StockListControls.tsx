import { SORTS, type ListView } from './stockList';

interface Props {
  view:     ListView;
  onChange: (next: ListView) => void;
  /**
   * `bar` is the table's header: search, watchlist filter and sort side by side.
   * `rail` is the narrow list beside an open analysis, and gets the search only
   * — the other two would cost two more rows of header, and the rail's job is
   * to show as many stocks as it can in the order the table was already put in.
   */
  layout:   'bar' | 'rail';
  /**
   * Rail only: how many stocks are showing, drawn inside the field. It rides
   * along in there so the rail's header is exactly one control tall — the same
   * as the table's — and the two lists therefore start at the same height on
   * screen. A second line here would offset every row by its own height on the
   * way in and out.
   */
  badge?:   string;
}

/**
 * Search, sort and the watchlist filter.
 *
 * One component for both densities: they drive the same `ListView`, so a filter
 * typed in the rail is still applied when the table comes back, and a sort
 * chosen in the table is the order the rail shows. Defining them twice is how
 * the two views would start disagreeing about what "sorted" means.
 */
export default function StockListControls({ view, onChange, layout, badge }: Props) {
  const search = (
    <input
      type="search"
      value={view.query}
      onChange={(e) => onChange({ ...view, query: e.target.value })}
      placeholder={layout === 'rail' ? 'Symbol, Name, Sektor…' : 'Filtern nach Symbol, Name, Sektor…'}
      className={`rounded border border-ink-700 bg-ink-950 py-1.5 pl-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none ${
        layout === 'rail' ? 'w-full pr-14' : 'w-56 pr-2.5'
      }`}
    />
  );

  if (layout === 'rail') {
    return (
      <div className="relative">
        {search}
        {badge && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink-600">
            {badge}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {search}
      <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
        <input
          type="checkbox"
          checked={view.onlyWatched}
          onChange={(e) => onChange({ ...view, onlyWatched: e.target.checked })}
          className="accent-[var(--color-accent)]"
        />
        nur Watchlist
      </label>
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
    </div>
  );
}
