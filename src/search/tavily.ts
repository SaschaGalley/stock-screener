import { SearchResult } from '../types.js';
import { SearchProvider } from './base.js';
import { logger } from '../utils/logger.js';

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
}

export class TavilySearch extends SearchProvider {
  readonly name = 'tavily';

  constructor(private readonly apiKey: string) {
    super();
  }

  async search(query: string): Promise<SearchResult[]> {
    logger.debug(`Tavily search: "${query}"`);

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as TavilyResponse;

    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: r.score,
    }));
  }
}
