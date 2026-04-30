import { NewsItem } from '../types.js';
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
