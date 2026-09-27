import { NewsItem, SectorMedians } from '../types.js';
import { runRateToTrailing } from '../analysis/run-rate.js';
import { logger } from '../utils/logger.js';
import { toFiniteNumber } from '../utils/num.js';
import { RateWindow } from '../utils/rate-window.js';

const BASE = 'https://finnhub.io/api/v1';

/**
 * The free tier's 60 requests a minute, a little under so our window and
 * Finnhub's need not agree to the second. One peer reading is up to nineteen
 * requests, and a burst of them used to be answered with 429s and stored as
 * nothing. Per process: a Hatchet worker and the server each keep their own,
 * and the queue's rate limits pace the two together.
 */
const finnhubWindow = new RateWindow(55, 60_000);

async function fetchFinnhub(path: string, apiKey: string): Promise<unknown> {
  await finnhubWindow.take();
  const url = `${BASE}${path}&token=${apiKey}`;
  logger.debug(`Finnhub request: ${path.split('?')[0]}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  return res.json();
}

/**
 * How long one company's `/stock/metric` answer is reused. The same company is
 * asked for as a stock, then as a peer of its neighbours — in a night of
 * reference refreshes, most S&P 500 members are someone's peer — and its
 * multiples do not move within the hour in any way a median would notice.
 */
const METRIC_TTL_MS = 60 * 60_000;
const metricMemo = new Map<string, { at: number; value: Promise<FinnhubMetricResponse> }>();

/**
 * Forget the shared `/stock/metric` answers and the requests counted against
 * the minute — for tests, which stub `fetch` per case and would otherwise wait
 * out a minute that no real API is counting.
 */
export function resetFinnhubClient(): void {
  metricMemo.clear();
  finnhubWindow.reset();
}

/** `/stock/metric` for one symbol, trimmed to what is read and shared for an hour. */
function stockMetric(symbol: string, apiKey: string): Promise<FinnhubMetricResponse> {
  const now = Date.now();
  const hit = metricMemo.get(symbol);
  if (hit && now - hit.at < METRIC_TTL_MS) return hit.value;
  for (const [k, v] of metricMemo) if (now - v.at >= METRIC_TTL_MS) metricMemo.delete(k);

  const value = (fetchFinnhub(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`, apiKey) as
    Promise<FinnhubMetricResponse>)
    // The full answer carries a decade of series; one of them is read.
    .then((d) => ({ metric: d?.metric, series: { annual: { roic: d?.series?.annual?.roic ?? [] } } }));
  const entry = { at: now, value };
  // A failure is not an answer: the next caller asks again.
  value.catch(() => { if (metricMemo.get(symbol) === entry) metricMemo.delete(symbol); });
  metricMemo.set(symbol, entry);
  return value;
}

function sentimentFromScore(score: number): NewsItem['sentiment'] {
  if (score > 0.1) return 'positive';
  if (score < -0.1) return 'negative';
  return 'neutral';
}

export async function getNews(symbol: string, apiKey: string, days = 7): Promise<NewsItem[]> {
  logger.step(`Fetching news for ${symbol}...`);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().substring(0, 10);

  const path = `/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}`;

  const raw = await fetchFinnhub(path, apiKey) as Array<{
    headline?: string;
    source?: string;
    url?: string;
    datetime?: number;
    summary?: string;
  }>;

  if (!Array.isArray(raw)) return [];

  return raw.slice(0, 10).map((item) => ({
    headline: item.headline ?? '',
    source: item.source ?? '',
    url: item.url ?? '',
    datetime: item.datetime ?? 0,
    summary: item.summary ?? '',
    sentiment: 'neutral' as const,
  }));
}

interface FinnhubMetricResponse {
  metric?: Record<string, unknown>;
  series?: { annual?: Record<string, Array<{ period?: string; v?: unknown }>> };
}

/**
 * Latest annual ROIC, as a decimal. Finnhub has no `roicTTM` in `metric` — the
 * key this module read for years never existed, so ROIC was null for every
 * stock and every peer group. The figure lives in `series.annual.roic`, already
 * a decimal; the newest period is picked rather than trusting the order.
 */
function latestAnnualRoic(data: FinnhubMetricResponse | undefined): number | null {
  const points = data?.series?.annual?.roic ?? [];
  let newest: { period: string; v: number } | null = null;
  for (const p of points) {
    const v = toFiniteNumber(p.v);
    if (v === null || typeof p.period !== 'string') continue;
    if (!newest || p.period > newest.period) newest = { period: p.period, v };
  }
  return newest?.v ?? null;
}

export interface FinnhubBasicMetrics {
  roic: number | null;
  epsGrowth3Y: number | null;
  dividendGrowthRate5Y: number | null;
}

export async function getBasicFinancials(symbol: string, apiKey: string): Promise<FinnhubBasicMetrics> {
  const empty: FinnhubBasicMetrics = { roic: null, epsGrowth3Y: null, dividendGrowthRate5Y: null };
  try {
    const data = await stockMetric(symbol, apiKey);
    const m = data?.metric;
    if (!m) return empty;

    const pct = (v: unknown) => typeof v === 'number' && isFinite(v) ? v / 100 : null;

    return {
      roic:                latestAnnualRoic(data),
      epsGrowth3Y:         pct(m['epsGrowth3Y']),
      dividendGrowthRate5Y: pct(m['dividendGrowthRate5Y']),
    };
  } catch {
    logger.warn('Could not fetch Finnhub basic financials');
    return empty;
  }
}

/** The ticker a share class trades under, without its class: `BRK.A` and `BRK-B` are both `BRK`. */
function issuerRoot(ticker: string): string {
  return ticker.toUpperCase().replace(/[.\-][A-Z]$/, '');
}

/**
 * Whether a peer Finnhub lists is the company itself under another share class.
 * Berkshire's B shares were benchmarked against its A shares — the same firm at
 * the same multiple, counted as an independent opinion. The ticker catches the
 * suffix classes; classes with tickers of their own (`GOOG`/`GOOGL`,
 * `FOX`/`FOXA`) are caught by the market cap, identical for every class of one
 * company, once the metrics are in.
 */
function sameIssuer(symbol: string, peer: string): boolean {
  return issuerRoot(symbol) === issuerRoot(peer);
}

/** Market caps this close are one company quoted twice, not two companies. */
const SAME_ISSUER_MARKET_CAP = 0.01;

/**
 * Multiples that are prices of something: a negative one is not a cheap
 * valuation but a loss, and a median over [−40, −15, −8, 12, 18, 22, 25, 30]
 * came out at 15 where the profitable peers traded at 22.
 */
const PRICED_MULTIPLES = new Set(['pe', 'evToEbitda', 'evToRevenue', 'priceToFCF', 'priceToSales', 'pb']);

/**
 * …and a beta at or below zero is a listing that does not trade with the index
 * it was measured against, not a business that hedges the market.
 */
const MUST_BE_POSITIVE = new Set([...PRICED_MULTIPLES, 'beta']);

/** A peer this small against the company prices something else — a shell, not a comparable. */
const MIN_PEER_SIZE = 0.02;

/** Fewer usable peers than this and a grouping is not a peer group. */
const MIN_GROUP = 3;

type MetricResult = PromiseSettledResult<FinnhubMetricResponse>;

/**
 * One grouping's peers and their metrics, without the company itself under
 * another share class and without firms a fiftieth of its size.
 */
async function peerGroup(
  symbol: string, apiKey: string, grouping: 'subIndustry' | 'industry', ownCap: number | null,
  metricFor: (p: string) => Promise<FinnhubMetricResponse>,
): Promise<{ peers: string[]; metrics: MetricResult[] }> {
  const raw = await fetchFinnhub(
    `/stock/peers?symbol=${encodeURIComponent(symbol)}&grouping=${grouping}`, apiKey,
  ) as string[];
  if (!Array.isArray(raw)) return { peers: [], metrics: [] };
  const candidates = raw.filter((p) => p !== symbol && !sameIssuer(symbol, p)).slice(0, 8);
  const fetched = await Promise.allSettled(candidates.map(metricFor));
  const keep = candidates.map((p, i) => {
    const r = fetched[i];
    if (ownCap === null || ownCap <= 0 || r.status !== 'fulfilled') return true;
    const cap = toFiniteNumber(r.value?.metric?.marketCapitalization);
    if (cap === null) return true;
    if (Math.abs(cap - ownCap) / ownCap < SAME_ISSUER_MARKET_CAP) {
      logger.debug(`Sector medians: ${p} is ${symbol} under another share class — dropped`);
      return false;
    }
    return cap >= ownCap * MIN_PEER_SIZE;
  });
  return {
    peers: candidates.filter((_, i) => keep[i]),
    metrics: fetched.filter((_, i) => keep[i]),
  };
}

/** A peer reading that found no peers to read. */
function emptyPeerGroup(): SectorMedians {
  return {
    pe: null, evToEbitda: null, evToRevenue: null, priceToFCF: null, priceToSales: null,
    forwardPriceToSales: null, runRatePriceToSales: null, pb: null,
    operatingMargin: null, netMargin: null, roe: null, roic: null, revenueGrowthYoY: null,
    beta: null, peerCount: 0, peers: [], emptyGroup: true,
  };
}

export interface SectorMedianOptions {
  /**
   * Whether a thin sub-industry may fall back to Finnhub's industry grouping.
   * Finnhub files Berkshire and Mastercard in one "industry" with PayPal and a
   * mortgage lender, and the sub-industry sorts that out for the payment
   * networks — but for Berkshire it holds only shell companies a fraction of a
   * percent of its size. For an insurer or a bank no peer group is the honest
   * answer then, not the payment networks.
   */
  industryFallback?: boolean;
}

export async function getSectorMedians(
  symbol: string, apiKey: string, opts: SectorMedianOptions = {},
): Promise<SectorMedians | null> {
  try {
    // 1. Our own metrics, for the market cap the peers are measured against
    const metricFor = (p: string) => stockMetric(p, apiKey);
    const own = await metricFor(symbol).catch(() => null);
    const ownCap = toFiniteNumber(own?.metric?.marketCapitalization);

    // 2. The finest grouping that is a group: sub-industry, else industry
    let { peers, metrics } = await peerGroup(symbol, apiKey, 'subIndustry', ownCap, metricFor);
    const usable = (ms: MetricResult[]) => ms.filter((r) => r.status === 'fulfilled' && r.value?.metric).length;
    if (usable(metrics) < MIN_GROUP && opts.industryFallback !== false) {
      const wider = await peerGroup(symbol, apiKey, 'industry', ownCap, metricFor);
      if (usable(wider.metrics) > usable(metrics)) ({ peers, metrics } = wider);
    }
    // Finnhub answered and nothing survived: no peer group, which is a reading —
    // unlike a failed fetch, it must not be papered over with an older group.
    if (peers.length === 0) return emptyPeerGroup();

    // 3. Collect valid values per metric
    const buckets: Record<string, number[]> = {
      pe: [], evToEbitda: [], evToRevenue: [], priceToFCF: [], priceToSales: [], pb: [],
      operatingMargin: [], netMargin: [], roe: [], roic: [], revenueGrowthYoY: [],
      runRatePriceToSales: [], beta: [],
    };

    const caps: Record<string, number> = {
      pe: 500, evToEbitda: 300, evToRevenue: 100, priceToFCF: 500, priceToSales: 100, pb: 100,
      operatingMargin: 1, netMargin: 1, roe: 5, roic: 5, revenueGrowthYoY: 2, beta: 5,
    };

    const fieldMap: Record<string, string> = {
      pe: 'peTTM', evToEbitda: 'evEbitdaTTM', evToRevenue: 'evRevenueTTM',
      priceToFCF: 'pfcfShareTTM', priceToSales: 'psTTM', pb: 'pb',
      operatingMargin: 'operatingMarginTTM', netMargin: 'netProfitMarginTTM',
      roe: 'roeTTM', revenueGrowthYoY: 'revenueGrowthTTMYoy', beta: 'beta',
    };

    // Margin/growth fields come as percentages from Finnhub — convert to decimals
    const pctFields = new Set(['operatingMargin', 'netMargin', 'roe', 'revenueGrowthYoY']);

    let contributingPeers = 0;
    metrics.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const m = r.value?.metric;
      if (!m) return;
      contributingPeers++;
      for (const [key, field] of Object.entries(fieldMap)) {
        const raw = m[field];
        if (typeof raw !== 'number' || !isFinite(raw)) continue;
        const v = pctFields.has(key) ? raw / 100 : raw;
        if (v > caps[key] || v < -caps[key]) continue;
        if (MUST_BE_POSITIVE.has(key) && v <= 0) continue;
        buckets[key].push(v);
      }
      const roic = latestAnnualRoic(r.value);
      if (roic !== null && Math.abs(roic) <= caps.roic) buckets.roic.push(roic);

      // Run-rate P/S per peer, before the median: we never fetch a peer's
      // quarters, but its P/S TTM and latest-quarter growth pin the figure down.
      // Growth beyond the cap is clamped, not dropped — a peer that sits in the
      // P/S TTM median but not in this one makes the two compare different
      // firms, and on eight peers one missing name moves the median a lot.
      const ps = toFiniteNumber(m.psTTM);
      const yoyPct = toFiniteNumber(m.revenueGrowthQuarterlyYoy) ?? toFiniteNumber(m.revenueGrowthTTMYoy);
      if (ps === null || ps <= 0 || ps > caps.priceToSales || yoyPct === null) return;
      const factor = runRateToTrailing(Math.min(yoyPct / 100, caps.revenueGrowthYoY));
      if (factor !== null) buckets.runRatePriceToSales.push(ps / factor);
    });

    const median = (arr: number[]): number | null => {
      if (arr.length === 0) return null;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };

    const psMedian   = median(buckets.priceToSales);
    // Every peer request failing — a rate limit, an outage — is a failed fetch,
    // not an empty industry. Returned as a result it was cached as one, and a
    // burst of requests on 22 September replaced Mastercard's eight-peer
    // medians with a group of none.
    if (contributingPeers === 0) return null;

    const revGrMedian = median(buckets.revenueGrowthYoY);
    // Approximation: peer median forward P/S ≈ peer median P/S TTM / (1 + peer median revenue growth).
    // Exact would require fetching each peer's forward revenue (one extra API call per peer).
    const forwardPSMedian = psMedian !== null && revGrMedian !== null && (1 + revGrMedian) > 0
      ? psMedian / (1 + revGrMedian)
      : null;

    return {
      pe:                  median(buckets.pe),
      evToEbitda:          median(buckets.evToEbitda),
      evToRevenue:         median(buckets.evToRevenue),
      priceToFCF:          median(buckets.priceToFCF),
      priceToSales:        psMedian,
      forwardPriceToSales: forwardPSMedian,
      runRatePriceToSales: median(buckets.runRatePriceToSales),
      pb:                 median(buckets.pb),
      operatingMargin:     median(buckets.operatingMargin),
      netMargin:           median(buckets.netMargin),
      roe:                 median(buckets.roe),
      roic:                median(buckets.roic),
      revenueGrowthYoY:    revGrMedian,
      // A median of one or two betas is a peer's beta, not the industry's.
      beta:                buckets.beta.length >= MIN_GROUP ? median(buckets.beta) : null,
      peerCount:           contributingPeers,
      peers,
    };
  } catch (e) {
    logger.warn(`Sector medians: ${(e as Error).message}`);
    return null;
  }
}

export async function getSentiment(
  symbol: string,
  apiKey: string,
): Promise<{ bullishPercent: number; bearishPercent: number } | null> {
  try {
    const path = `/news-sentiment?symbol=${encodeURIComponent(symbol)}`;
    const data = await fetchFinnhub(path, apiKey) as {
      sentiment?: { bullishPercent?: number; bearishPercent?: number };
    };
    const s = data?.sentiment;
    if (!s) return null;
    return {
      bullishPercent: s.bullishPercent ?? 0,
      bearishPercent: s.bearishPercent ?? 0,
    };
  } catch {
    logger.warn('Could not fetch sentiment data');
    return null;
  }
}
