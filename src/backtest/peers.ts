/**
 * Peer medians for the backtest, from the cross-section itself.
 *
 * Finnhub's peer groups exist only for today. On a past day the peers are the
 * other index members of the same GICS sub-industry that day — or of the same
 * sector where the sub-industry has fewer than three — and the medians are
 * taken the way `data/finnhub.ts` takes them: priced multiples only when
 * positive, the same outlier bounds, no peer a fiftieth of the company's size.
 * A lender, as live, has its sub-industry or no group at all.
 */

import { borrowsToLend } from '../analysis/dcf.js';
import type { SectorMedians, StockFinancials } from '../types.js';

export interface PeerInput {
  symbol:      string;
  sector:      string;
  subIndustry: string;
  financials:  StockFinancials;
}

const MIN_GROUP = 3;
const MIN_PEER_SIZE = 0.02;

/** The live bounds (`data/finnhub.ts`): beyond these a figure is an accident, not a peer's multiple. */
const CAPS: Record<string, number> = {
  pe: 500, evToEbitda: 300, evToRevenue: 100, priceToFCF: 500, priceToSales: 100, pb: 100,
  operatingMargin: 1, netMargin: 1, roe: 5, roic: 5, revenueGrowthYoY: 2, beta: 5,
};
const POSITIVE = new Set(['pe', 'evToEbitda', 'evToRevenue', 'priceToFCF', 'priceToSales', 'pb', 'beta']);

function figures(f: StockFinancials): Record<string, number | null> {
  const ev = f.enterpriseValue;
  const div = (a: number | null | undefined, b: number | null | undefined) =>
    a != null && b != null && b !== 0 ? a / b : null;
  return {
    pe: f.peRatio,
    evToEbitda: div(ev, f.ebitda),
    evToRevenue: div(ev, f.revenue),
    priceToFCF: div(f.marketCap, f.freeCashFlow),
    priceToSales: div(f.marketCap, f.revenue),
    pb: div(f.price, f.bookValue),
    operatingMargin: f.operatingMargin,
    netMargin: f.netMargin,
    roe: f.roe,
    roic: f.roic,
    revenueGrowthYoY: f.revenueGrowthYoY,
    beta: f.beta,
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mediansOf(peers: PeerInput[]): SectorMedians {
  const buckets: Record<string, number[]> = Object.fromEntries(Object.keys(CAPS).map((k) => [k, []]));
  for (const p of peers) {
    for (const [k, raw] of Object.entries(figures(p.financials))) {
      if (raw === null || !Number.isFinite(raw)) continue;
      if (Math.abs(raw) > CAPS[k]) continue;
      if (POSITIVE.has(k) && raw <= 0) continue;
      buckets[k].push(raw);
    }
  }
  const ps = median(buckets.priceToSales);
  const growth = median(buckets.revenueGrowthYoY);
  return {
    pe: median(buckets.pe), evToEbitda: median(buckets.evToEbitda), evToRevenue: median(buckets.evToRevenue),
    priceToFCF: median(buckets.priceToFCF), priceToSales: ps,
    forwardPriceToSales: ps !== null && growth !== null && 1 + growth > 0 ? ps / (1 + growth) : null,
    runRatePriceToSales: null, pb: median(buckets.pb),
    operatingMargin: median(buckets.operatingMargin), netMargin: median(buckets.netMargin),
    roe: median(buckets.roe), roic: median(buckets.roic), revenueGrowthYoY: growth,
    beta: buckets.beta.length >= MIN_GROUP ? median(buckets.beta) : null,
    peerCount: peers.length, peers: peers.map((p) => p.symbol),
  };
}

/** Every company's peer medians on one day; null where it has no group. */
export function crossSectionPeers(all: PeerInput[]): Map<string, SectorMedians | null> {
  const bySub = new Map<string, PeerInput[]>();
  const bySector = new Map<string, PeerInput[]>();
  for (const x of all) {
    bySub.set(x.subIndustry, [...(bySub.get(x.subIndustry) ?? []), x]);
    bySector.set(x.sector, [...(bySector.get(x.sector) ?? []), x]);
  }
  const out = new Map<string, SectorMedians | null>();
  for (const x of all) {
    const size = x.financials.marketCap;
    const keep = (g: PeerInput[]) => g.filter((p) => p.symbol !== x.symbol && p.financials.marketCap >= size * MIN_PEER_SIZE);
    let group = keep(bySub.get(x.subIndustry) ?? []);
    if (group.length < MIN_GROUP && !borrowsToLend(x.financials)) group = keep(bySector.get(x.sector) ?? []);
    out.set(x.symbol, group.length >= MIN_GROUP ? mediansOf(group) : null);
  }
  return out;
}
