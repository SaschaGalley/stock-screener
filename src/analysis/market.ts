/**
 * The market today, for the discover page: Yahoo's lists of the day's movers
 * and its predefined screens, and the day's moves across our own universe.
 *
 * Yahoo has the lists for the United States only; the universe's quotes cover
 * the European indices as well. Each row says whether the stock is on the
 * list, scored in the universe, or new to the app.
 *
 * Pure and dependency-free so the web app can import the types and the lists.
 */

export type MarketListKey =
  | 'day_gainers' | 'day_losers' | 'most_actives' | 'trending'
  | 'most_shorted_stocks' | 'undervalued_large_caps' | 'undervalued_growth_stocks' | 'growth_technology_stocks';

/** What a row's reason line leads with. */
export type MarketReason = 'move' | 'volume' | 'valuation';

export interface MarketListDef {
  key:    MarketListKey;
  /** The question the list answers. */
  title:  string;
  /** What Yahoo's list is, and anything this app does to it. */
  hint:   string;
  reason: MarketReason;
  /** Rows below this market cap are left out — the screen is full of shells otherwise. */
  minCap?: number;
}

/** The lists, in the order the page shows them. The first three are the day's; the rest change slowly. */
export const MARKET_LISTS: readonly MarketListDef[] = [
  { key: 'day_gainers',  title: 'Wer steigt heute am stärksten?', reason: 'move',
    hint: 'Yahoos Tagesgewinner unter den US-Aktien.' },
  { key: 'day_losers',   title: 'Wer fällt heute am stärksten?', reason: 'move',
    hint: 'Yahoos Tagesverlierer unter den US-Aktien.' },
  { key: 'most_actives', title: 'Was wird heute am meisten gehandelt?', reason: 'volume',
    hint: 'Yahoos meistgehandelte US-Aktien des Tages, nach Stückzahl. Wer kauft und wer verkauft, verrät die Liste nicht.' },
  { key: 'trending',     title: 'Worauf schauen gerade alle?', reason: 'move',
    hint: 'Was auf Yahoo in den USA gerade am meisten aufgerufen wird.' },
  { key: 'most_shorted_stocks', title: 'Wo wetten die meisten auf fallende Kurse?', reason: 'move', minCap: 2e9,
    hint: 'Yahoos Liste der US-Aktien mit den größten Leerverkaufspositionen nach den Meldungen von Nasdaq und NYSE, alle zwei Wochen. Hier nur ab 2 Mrd. $ Börsenwert.' },
  { key: 'undervalued_large_caps', title: 'Welche großen Firmen sind günstig bewertet?', reason: 'valuation',
    hint: 'Yahoos Filter für günstig bewertete große US-Firmen, nach Handelsvolumen geordnet — ein Filter auf Kennzahlen, kein Urteil.' },
  { key: 'undervalued_growth_stocks', title: 'Wo gibt es Wachstum zum kleinen Preis?', reason: 'valuation',
    hint: 'Yahoos Filter für US-Aktien mit starkem Gewinnwachstum und niedrigem Kurs-Gewinn-Verhältnis.' },
  { key: 'growth_technology_stocks', title: 'Welche Tech-Firmen wachsen am schnellsten?', reason: 'valuation',
    hint: 'Yahoos Filter für US-Technologiewerte mit hohem Umsatz- und Gewinnwachstum.' },
];

/** How many rows a list is fetched with. */
export const MARKET_LIST_SIZE = 25;
/** How many gainers and losers of the universe the page shows. */
export const MOVERS_SHOWN = 6;

/** One stock as a quote describes it, with what the app knows about it. */
export interface MarketRow {
  symbol:     string;
  name:       string | null;
  exchange:   string | null;
  currency:   string | null;
  price:      number | null;
  /** The day's change, as a fraction. */
  change:     number | null;
  /** The change over 52 weeks, as a fraction. */
  year:       number | null;
  volume:     number | null;
  /** The usual daily volume, over three months. */
  avgVolume:  number | null;
  marketCap:  number | null;
  pe:         number | null;
  /** When the quote's price was set. */
  time:       string | null;
  /** On the watchlist, scored in the universe, or neither. */
  status:     'list' | 'reference' | 'unknown';
  score:      number | null;
  verdict:    string | null;
  logoDomain: string | null;
  sector:     string | null;
  industry:   string | null;
}

export interface MarketList {
  key:   MarketListKey;
  rows:  MarketRow[];
  /** Why the list could not be fetched; the others stand. */
  error: string | null;
}

export interface MarketToday {
  /** When the lists were fetched. */
  at:       string;
  lists:    MarketList[];
  /** Every stock of the universe off the list, with its day's move. */
  universe: MarketRow[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const pct = (v: unknown): number | null => { const n = num(v); return n === null ? null : n / 100; };

/** A Yahoo quote's fields, as a row the app has not yet looked up. Null for a quote without a ticker. */
export function quoteRow(q: Record<string, unknown>): Omit<MarketRow, 'status' | 'score' | 'verdict' | 'logoDomain' | 'sector' | 'industry'> | null {
  const symbol = str(q.symbol);
  if (!symbol) return null;
  const t = q.regularMarketTime;
  const time = t instanceof Date ? t.toISOString()
    : typeof t === 'number' ? new Date(t * 1000).toISOString()
    : typeof t === 'string' ? t : null;
  return {
    symbol:    symbol.toUpperCase(),
    name:      str(q.longName) ?? str(q.shortName) ?? str(q.displayName),
    exchange:  str(q.fullExchangeName) ?? str(q.exchange),
    currency:  str(q.currency),
    price:     num(q.regularMarketPrice),
    change:    pct(q.regularMarketChangePercent),
    year:      pct(q.fiftyTwoWeekChangePercent),
    volume:    num(q.regularMarketVolume),
    avgVolume: num(q.averageDailyVolume3Month),
    marketCap: num(q.marketCap),
    pe:        num(q.trailingPE),
    time,
  };
}

/** The day's biggest gainers and losers among `rows`, `n` each; a row without a change is in neither. */
export function movers(rows: readonly MarketRow[], n = MOVERS_SHOWN): { up: MarketRow[]; down: MarketRow[] } {
  const moved = rows.filter((r) => r.change !== null);
  const up = moved.filter((r) => r.change! > 0).sort((a, b) => b.change! - a.change!).slice(0, n);
  const down = moved.filter((r) => r.change! < 0).sort((a, b) => a.change! - b.change!).slice(0, n);
  return { up, down };
}

/** How many times the usual volume traded today; null without both. */
export function volumeRatio(r: Pick<MarketRow, 'volume' | 'avgVolume'>): number | null {
  return r.volume !== null && r.avgVolume !== null && r.avgVolume > 0 ? r.volume / r.avgVolume : null;
}
