import { SearchResult } from '../types.js';

export abstract class SearchProvider {
  abstract readonly name: string;
  abstract search(query: string): Promise<SearchResult[]>;

  async searchMultiple(queries: string[]): Promise<SearchResult[]> {
    const results = await Promise.allSettled(queries.map((q) => this.search(q)));
    return results
      .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }
}
