/**
 * The depot looked through its funds: what it holds once every fund is read
 * as the stocks and sectors it holds.
 *
 * A world fund is a third technology and holds the largest US companies at a
 * few per cent each, so a depot of funds and a few single stocks can hold one
 * company twice and a sector three times over without any line saying so.
 * Yahoo gives each fund's ten largest holdings with their share and the
 * sector split of its equity part; that is what is counted here. The ten
 * largest are usually a fifth to a third of a world fund, the rest is spread
 * thin, and the page says how much is known.
 *
 * Shares are of the whole depot throughout: a stock at 3 % direct and 0.9 %
 * through the funds is 3.9 % of the depot.
 *
 * Pure and dependency-free: the web app imports the types.
 */

/** A fund as Yahoo describes it. Shares are of the fund. */
export interface FundHoldings {
  symbol:   string;
  /** When it was fetched. */
  asOf:     string;
  holdings: { symbol: string | null; name: string; weight: number }[];
  /** Of the fund's equity part, in Yahoo's sector vocabulary; sums to about one. */
  sectors:  { sector: string; weight: number }[];
  /** The fund's parts by kind of asset, where Yahoo has them. */
  equity:   number | null;
  bonds:    number | null;
  cash:     number | null;
}

export interface LookThroughPosition {
  symbol:    string | null;
  name:      string;
  assetType: string;
  sector:    string | null;
  weight:    number | null;
}

export interface LookThrough {
  /** Every sector and other kind of asset, the largest first. */
  sectors: { sector: string; direct: number; viaFunds: number; total: number }[];
  /** The largest single companies, direct and through the funds. */
  stocks:  { symbol: string | null; name: string; direct: number; viaFunds: number; total: number; held: boolean }[];
  /** What the funds add to each stock held directly, by its ticker; only where they add something. */
  heldViaFunds: Record<string, number>;
  /** Share of the depot in funds, and the part of that whose ten largest holdings are known. */
  funds:   { weight: number; known: number };
  /** Funds held without a description from Yahoo. */
  unknown: string[];
}

/** Not a company sector: what a depot holds besides shares. */
export const OTHER = {
  bonds:   'Anleihen',
  cash:    'Kasse',
  crypto:  'Krypto',
  metal:   'Edelmetalle',
  unknown: 'Fonds ohne Angaben',
  none:    'ohne Sektor',
} as const;

const FUNDS = new Set(['etf', 'fund']);
const TOP_STOCKS = 12;

/**
 * A company's name without its legal form and share class, to match a fund's
 * "Alphabet Inc Class C" to the "Alphabet Inc." held directly.
 */
export function companyKey(name: string): string {
  return name.toLowerCase()
    .replace(/\b(class [a-z]|cl [a-z]|ordinary shares?|shares?|new|registered|reg|adr|ads|sponsored|common stock)\b/g, ' ')
    .replace(/\b(incorporated|inc|corporation|corp|company|co|plc|ag|se|sa|nv|n\.v|ab|asa|oyj|spa|holdings?|group|ltd|limited|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function lookThrough(positions: readonly LookThroughPosition[], funds: ReadonlyMap<string, FundHoldings>): LookThrough {
  const sectors = new Map<string, { direct: number; viaFunds: number }>();
  const addSector = (s: string, w: number, via: boolean) => {
    const x = sectors.get(s) ?? { direct: 0, viaFunds: 0 };
    if (via) x.viaFunds += w; else x.direct += w;
    sectors.set(s, x);
  };
  // Companies by symbol where both sides have one, else by name.
  const companies = new Map<string, { symbol: string | null; name: string; direct: number; viaFunds: number; held: boolean }>();
  const bySymbol = new Map<string, string>();
  const keyOf = (symbol: string | null, name: string) => {
    if (symbol && bySymbol.has(symbol)) return bySymbol.get(symbol)!;
    const k = companyKey(name) || symbol || name;
    if (symbol) bySymbol.set(symbol, k);
    return k;
  };

  let fundWeight = 0, known = 0;
  const unknown: string[] = [];
  for (const p of positions) {
    const w = p.weight ?? 0;
    if (w <= 0) continue;
    if (FUNDS.has(p.assetType)) {
      fundWeight += w;
      const f = p.symbol ? funds.get(p.symbol) : undefined;
      if (!f) { unknown.push(p.symbol ?? p.name); addSector(OTHER.unknown, w, true); continue; }
      known += w;
      const equity = f.equity ?? (f.sectors.length ? 1 - (f.bonds ?? 0) - (f.cash ?? 0) : 0);
      const sectorSum = f.sectors.reduce((s, x) => s + x.weight, 0);
      for (const s of f.sectors) addSector(s.sector, w * equity * (s.weight / (sectorSum || 1)), true);
      if (f.bonds) addSector(OTHER.bonds, w * f.bonds, true);
      if (f.cash) addSector(OTHER.cash, w * f.cash, true);
      const rest = 1 - (f.sectors.length ? equity : 0) - (f.bonds ?? 0) - (f.cash ?? 0);
      if (rest > 0.005) addSector(OTHER.unknown, w * rest, true);
      for (const h of f.holdings) {
        const k = keyOf(h.symbol, h.name);
        const c = companies.get(k) ?? { symbol: h.symbol, name: h.name, direct: 0, viaFunds: 0, held: false };
        c.viaFunds += w * h.weight;
        companies.set(k, c);
      }
      continue;
    }
    if (p.assetType === 'stock') {
      addSector(p.sector ?? OTHER.none, w, false);
      const k = keyOf(p.symbol, p.name);
      const c = companies.get(k) ?? { symbol: p.symbol, name: p.name, direct: 0, viaFunds: 0, held: true };
      // The direct holding names the company: its ticker and name are the depot's.
      Object.assign(c, { symbol: p.symbol ?? c.symbol, name: p.name, held: true });
      c.direct += w;
      companies.set(k, c);
      continue;
    }
    addSector(p.assetType === 'crypto' ? OTHER.crypto : /metal/.test(p.assetType) ? OTHER.metal
      : p.assetType === 'bond' ? OTHER.bonds : OTHER.none, w, false);
  }

  const heldViaFunds: Record<string, number> = {};
  for (const c of companies.values()) if (c.held && c.symbol && c.viaFunds > 0) heldViaFunds[c.symbol] = c.viaFunds;
  return {
    sectors: [...sectors].map(([sector, x]) => ({ sector, ...x, total: x.direct + x.viaFunds }))
      .sort((a, b) => b.total - a.total),
    heldViaFunds,
    stocks: [...companies.values()].map((c) => ({ ...c, total: c.direct + c.viaFunds }))
      .sort((a, b) => b.total - a.total).slice(0, TOP_STOCKS),
    funds: { weight: fundWeight, known },
    unknown,
  };
}
