/**
 * The stock page's topics, one tab each.
 *
 * The page was nineteen sections in a row — twelve thousand pixels, a
 * thousand numbers — and folding them did not help: a closed section said
 * nothing, so it was opened, and then it stayed open. The topics are tabs
 * now: one click to a topic, and everything in it shown. A stock always
 * opens on the overview; each tab has its own address
 * (`#/stock/AAPL/chart`), so the back button and a link work.
 */

export const STOCK_TABS = [
  { key: 'overview',  label: 'Überblick' },
  { key: 'chart',     label: 'Chart' },
  { key: 'valuation', label: 'Bewertung' },
  { key: 'business',  label: 'Geschäft & Zahlen' },
  { key: 'analysts',  label: 'Analysten & Eigentümer' },
  { key: 'history',   label: 'Verlauf & Research' },
  { key: 'journal',   label: 'Journal' },
] as const;

export type StockTab = (typeof STOCK_TABS)[number]['key'];

export const isStockTab = (v: unknown): v is StockTab =>
  typeof v === 'string' && STOCK_TABS.some((t) => t.key === v);

export default function StockTabs({ tab, onTab, counts = {} }: {
  tab: StockTab;
  onTab: (t: StockTab) => void;
  /** A number beside a tab's label — how many journal entries, say. */
  counts?: Partial<Record<StockTab, number>>;
}) {
  return (
    <nav
      aria-label="Themen"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink-700 bg-ink-900 px-3 sm:px-6"
    >
      {STOCK_TABS.map((t) => {
        const on = t.key === tab;
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onTab(t.key)}
            aria-current={on ? 'page' : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
              on ? 'border-accent font-semibold text-ink-50' : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            {t.label}
            {n !== undefined && n > 0 && <span className="ml-1.5 font-mono text-2xs text-ink-500">{n}</span>}
          </button>
        );
      })}
    </nav>
  );
}
