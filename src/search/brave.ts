import { SearchResult } from '../types.js';
import { SearchProvider } from './base.js';
import { logger } from '../utils/logger.js';

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export class BraveSearch extends SearchProvider {
  readonly name = 'brave';

  constructor(private readonly apiKey: string) {
    super();
  }

  async search(query: string): Promise<SearchResult[]> {
    logger.debug(`Brave search: "${query}"`);

    const params = new URLSearchParams({
      q: query,
      count: '5',
      freshness: 'pm',
      extra_snippets: 'true',
    });

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as BraveResponse;

    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' '),
    }));
  }
}
