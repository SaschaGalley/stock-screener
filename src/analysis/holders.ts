/**
 * Who holds a stock, and who changed their position — the shapes the page
 * reads from the archived Yahoo holder modules and the insider-trade table.
 *
 * Dependency-free so the web app can import the types.
 */

export interface Holder {
  organization: string;
  /** Share of the outstanding stock, 0–1. */
  pctHeld:      number | null;
  position:     number | null;
  value:        number | null;
  /** Change in the position since the filer's previous report, 0.1 = +10 %. */
  pctChange:    number | null;
  reportDate:   string | null;
}

export interface InsiderHolder {
  name:             string;
  relation:         string | null;
  lastTransaction:  string | null;
  lastTransactionOn: string | null;
  sharesDirect:     number | null;
}

export interface InsiderTrade {
  tradedOn:    string | null;
  filer:       string | null;
  relation:    string | null;
  description: string | null;
  shares:      number | null;
  value:       number | null;
  /** Read from Yahoo's text: a sale, a purchase, or anything else (grants, gifts, exercises). */
  kind:        'sale' | 'purchase' | 'other';
}

export interface Holders {
  /** When the holder modules were last archived. */
  asOf:          string | null;
  breakdown: {
    insiders:          number | null;
    institutions:      number | null;
    institutionsFloat: number | null;
    institutionsCount: number | null;
  };
  institutions:  Holder[];
  funds:         Holder[];
  insiders:      InsiderHolder[];
  /** Six months of insider buying and selling as Yahoo summarises it. */
  netActivity: {
    buys: number | null; sells: number | null; netShares: number | null;
    netPercentInsiderShares: number | null; netInstitutionalBuyingPercent: number | null;
  } | null;
  trades:        InsiderTrade[];
  /** Each top institution's stake across the archived reports — grows a point per quarter. */
  history:       { organization: string; points: { day: string; pctHeld: number }[] }[];
}

/**
 * How Yahoo words an insider buying on the open market with their own money:
 * "Purchase at price 41.20 per share." Awards ("Stock Award(Grant) at price
 * 0.00"), option exercises ("Conversion of Exercise of derivative security")
 * and gifts are acquisitions too, but nobody paid the market for them. The
 * discover page's query filters the archive on the same prefix.
 */
export const OPEN_MARKET_PURCHASE = 'purchase at price';

export const isOpenMarketPurchase = (description: string | null): boolean =>
  (description ?? '').trim().toLowerCase().startsWith(OPEN_MARKET_PURCHASE);

export function tradeKind(description: string | null): InsiderTrade['kind'] {
  const d = (description ?? '').toLowerCase();
  if (d.startsWith('sale')) return 'sale';
  if (isOpenMarketPurchase(description)) return 'purchase';
  return 'other';
}

/** The insider totals the financials payload carries; null where there was nothing to count. */
export interface InsiderTotals {
  insiderBuyShares:  number | null;
  insiderSellShares: number | null;
  insiderBuyValue:   number | null;
  insiderSellValue:  number | null;
  insiderBuyCount:   number | null;
  insiderSellCount:  number | null;
}

/**
 * The insiders' buying and selling on or after `since`. Buys are purchases on
 * the open market only; sales are whatever Yahoo words as a sale. Grants,
 * exercises, gifts and rows without text count as neither.
 */
export function insiderTotals(
  trades: readonly Pick<InsiderTrade, 'tradedOn' | 'description' | 'shares' | 'value'>[],
  since: string,
): InsiderTotals {
  let buyShares = 0, buyValue = 0, buys = 0;
  let sellShares = 0, sellValue = 0, sells = 0;
  for (const t of trades) {
    if (!t.tradedOn || t.tradedOn < since) continue;
    const text = (t.description ?? '').toLowerCase();
    const shares = Math.abs(t.shares ?? 0);
    const value  = Math.abs(t.value  ?? 0);
    if (text.includes('sale') || text.includes('sold')) {
      sellShares += shares; sellValue += value; sells++;
    } else if (isOpenMarketPurchase(t.description)) {
      buyShares += shares; buyValue += value; buys++;
    }
  }
  return {
    insiderBuyShares:  buys  > 0 ? buyShares  : null,
    insiderSellShares: sells > 0 ? sellShares : null,
    insiderBuyValue:   buys  > 0 ? buyValue   : null,
    insiderSellValue:  sells > 0 ? sellValue  : null,
    insiderBuyCount:   buys  > 0 ? buys       : null,
    insiderSellCount:  sells > 0 ? sells      : null,
  };
}
