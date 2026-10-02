/**
 * What the insiders did before a day, as signals a cross-section can rank.
 *
 * Purchases on the open market are the insider trades the literature finds
 * informative — Lakonishok and Lee (2001), Cohen, Malloy and Pomorski (2012):
 * an officer buying with their own money has one reason to, and selling has
 * many (diversification, taxes, a house, a plan filed months ahead). So the
 * signals lean on the buyers: how many different insiders bought, their
 * buying against their selling, and how much they bought for against the
 * company's size. Grants, exercises, gifts and tax withholding are not trades
 * on a view and are left out; derivative transactions too.
 *
 * Point in time by the filing, not the trade: a Form 4 is due two business
 * days after the trade, and until it is filed nobody outside knew.
 *
 * Measured as candidates in the backtest before anything in the score reads
 * them. Pure and dependency-free.
 */

export interface InsiderTrade {
  name:       string;
  filingDate: string;
  code:       string;
  change:     number;
  price:      number | null;
  derivative: boolean;
}

/** The window the signals read: half a year of filings, as the usual studies take. */
export const INSIDER_WINDOW_DAYS = 182;

export interface InsiderActivity {
  /** Different insiders with an open-market purchase in the window. */
  buyers:   number;
  /** Different insiders with an open-market sale. */
  sellers:  number;
  /** (buyers − sellers) / (buyers + sellers); null without either. */
  net:      number | null;
  /** What the purchases cost, in the trading currency. */
  buyValue: number;
}

/**
 * The signals the backtest measures, each read off one activity: the number
 * of buyers, buyers against sellers, and what the buying cost against the
 * company's size. Null where a reading has nothing to say.
 */
export const INSIDER_CANDIDATES: readonly {
  key: string; title: string; read: (a: InsiderActivity, marketCap: number) => number | null;
}[] = [
  { key: 'insider.buyers',    title: 'Insider: Käufer (6 M)',                    read: (a) => a.buyers },
  { key: 'insider.net',       title: 'Insider: Käufer gegen Verkäufer (6 M)',    read: (a) => a.net },
  { key: 'insider.buy-value', title: 'Insider: Kaufvolumen je Börsenwert (6 M)', read: (a, cap) => (cap > 0 ? a.buyValue / cap : null) },
];

const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The insiders' open-market trades filed in the window before `asOf`, the day itself excluded. */
export function insiderActivity(trades: readonly InsiderTrade[], asOf: string, days = INSIDER_WINDOW_DAYS): InsiderActivity {
  const from = shift(asOf, -days);
  const buyers = new Set<string>(), sellers = new Set<string>();
  let buyValue = 0;
  for (const t of trades) {
    if (t.derivative || t.filingDate >= asOf || t.filingDate < from) continue;
    if (t.code === 'P' && t.change > 0) {
      buyers.add(t.name);
      if (t.price !== null && t.price > 0) buyValue += t.change * t.price;
    } else if (t.code === 'S' && t.change < 0) {
      sellers.add(t.name);
    }
  }
  const n = buyers.size + sellers.size;
  return { buyers: buyers.size, sellers: sellers.size, net: n ? (buyers.size - sellers.size) / n : null, buyValue };
}
