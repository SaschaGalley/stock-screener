import { NewsItem, SectorMedians } from '../types.js';
import { logger } from '../utils/logger.js';

const BASE = 'https://finnhub.io/api/v1';

async function fetchFinnhub(path: string, apiKey: string): Promise<unknown> {
  const url = `${BASE}${path}&token=${apiKey}`;
  logger.debug(`Finnhub request: ${path.split('?')[0]}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  return res.json();
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

export interface FinnhubBasicMetrics {
  roic: number | null;
  epsGrowth3Y: number | null;
  dividendGrowthRate5Y: number | null;
}

export async function getBasicFinancials(symbol: string, apiKey: string): Promise<FinnhubBasicMetrics> {
  const empty: FinnhubBasicMetrics = { roic: null, epsGrowth3Y: null, dividendGrowthRate5Y: null };
  try {
    const path = `/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`;
    const data = await fetchFinnhub(path, apiKey) as { metric?: Record<string, unknown> };
    const m = data?.metric;
    if (!m) return empty;

    const pct = (v: unknown) => typeof v === 'number' && isFinite(v) ? v / 100 : null;

    return {
      roic:                pct(m['roicTTM']),
      epsGrowth3Y:         pct(m['epsGrowth3Y']),
      dividendGrowthRate5Y: pct(m['dividendGrowthRate5Y']),
    };
  } catch {
    logger.warn('Could not fetch Finnhub basic financials');
    return empty;
  }
}

export async function getSectorMedians(symbol: string, apiKey: string): Promise<SectorMedians | null> {
  try {
    // 1. Fetch peer tickers
    const peersRaw = await fetchFinnhub(
      `/stock/peers?symbol=${encodeURIComponent(symbol)}&grouping=industry`, apiKey,
    ) as string[];
    if (!Array.isArray(peersRaw) || peersRaw.length === 0) return null;

    // Exclude the stock itself, cap at 8 peers
    const peers = peersRaw.filter((p) => p !== symbol).slice(0, 8);

    // 2. Fetch metrics for all peers in parallel
    const metrics = await Promise.allSettled(
      peers.map((p) =>
        fetchFinnhub(`/stock/metric?symbol=${encodeURIComponent(p)}&metric=all`, apiKey) as Promise<{ metric?: Record<string, unknown> }>,
      ),
    );

    // 3. Collect valid values per metric
    const buckets: Record<string, number[]> = {
      pe: [], evToEbitda: [], evToRevenue: [], priceToFCF: [], pb: [],
      operatingMargin: [], netMargin: [], roe: [], roic: [], revenueGrowthYoY: [],
    };

    const caps: Record<string, number> = {
      pe: 500, evToEbitda: 300, evToRevenue: 100, priceToFCF: 500, pb: 100,
      operatingMargin: 1, netMargin: 1, roe: 5, roic: 5, revenueGrowthYoY: 2,
    };

    const fieldMap: Record<string, string> = {
      pe: 'peTTM', evToEbitda: 'evEbitdaTTM', evToRevenue: 'evRevenueTTM',
      priceToFCF: 'pfcfShareTTM', pb: 'pb',
      operatingMargin: 'operatingMarginTTM', netMargin: 'netProfitMarginTTM',
      roe: 'roeTTM', roic: 'roicTTM', revenueGrowthYoY: 'revenueGrowthTTMYoy',
    };

    // Margin/growth fields come as percentages from Finnhub — convert to decimals
    const pctFields = new Set(['operatingMargin', 'netMargin', 'roe', 'roic', 'revenueGrowthYoY']);

    metrics.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      const m = r.value?.metric;
      if (!m) return;
      for (const [key, field] of Object.entries(fieldMap)) {
        const raw = m[field];
        if (typeof raw !== 'number' || !isFinite(raw)) continue;
        const v = pctFields.has(key) ? raw / 100 : raw;
        if (v > caps[key] || v < -caps[key]) continue;
        buckets[key].push(v);
      }
    });

    const median = (arr: number[]): number | null => {
      if (arr.length === 0) return null;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };

    return {
      pe:               median(buckets.pe),
      evToEbitda:       median(buckets.evToEbitda),
      evToRevenue:      median(buckets.evToRevenue),
      priceToFCF:       median(buckets.priceToFCF),
      pb:               median(buckets.pb),
      operatingMargin:  median(buckets.operatingMargin),
      netMargin:        median(buckets.netMargin),
      roe:              median(buckets.roe),
      roic:             median(buckets.roic),
      revenueGrowthYoY: median(buckets.revenueGrowthYoY),
      peerCount:        peers.length,
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
