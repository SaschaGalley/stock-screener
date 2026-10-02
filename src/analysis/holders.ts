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

export function tradeKind(description: string | null): InsiderTrade['kind'] {
  const d = (description ?? '').toLowerCase();
  if (d.startsWith('sale')) return 'sale';
  if (d.startsWith('purchase') || d.startsWith('buy')) return 'purchase';
  return 'other';
}
