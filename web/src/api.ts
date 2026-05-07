import type {
  StockSummary,
  AnalysisManifestEntry,
  CachedAnalysisEntry,
  AnalysisFlagsKey,
  AnalysisResult,
  AnalysisRunMeta,
  Settings,
  StockBundle,
  ProgressEvent,
} from './types';

const BASE = '/api';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) errorMsg = body.error;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }
  return res.json() as Promise<T>;
}

export interface ModelInfo {
  shortcuts: { id: string; resolved: string; label: string }[];
  used:      { modelId: string; count: number }[];
}

export const api = {
  listStocks: () =>
    jsonFetch<{ stocks: StockSummary[] }>(`${BASE}/stocks`),

  listModels: () =>
    jsonFetch<ModelInfo>(`${BASE}/models`),

  deleteStock: (symbol: string) =>
    jsonFetch<{ ok: boolean; symbol: string }>(`${BASE}/stocks/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
    }),

  deleteAnalysis: (symbol: string, hash: string) =>
    jsonFetch<{ ok: boolean; symbol: string; hash: string }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/analyses/${hash}`,
      { method: 'DELETE' },
    ),

  getStock: (symbol: string) =>
    jsonFetch<StockBundle>(`${BASE}/stocks/${encodeURIComponent(symbol)}`),

  listAnalyses: (symbol: string) =>
    jsonFetch<{ symbol: string; analyses: AnalysisManifestEntry[] }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/analyses`),

  getAnalysisByHash: (symbol: string, hash: string) =>
    jsonFetch<CachedAnalysisEntry>(`${BASE}/stocks/${encodeURIComponent(symbol)}/analyses/${hash}`),

  getAnalysisByFlags: async (symbol: string, flags: AnalysisFlagsKey): Promise<CachedAnalysisEntry | null> => {
    const params = new URLSearchParams({
      model: flags.model,
      search: flags.search,
      ...(flags.pplx ? { pplx: flags.pplx } : {}),
    });
    try {
      return await jsonFetch<CachedAnalysisEntry>(
        `${BASE}/stocks/${encodeURIComponent(symbol)}/analyses-by-flags?${params}`,
      );
    } catch (e) {
      // 404 is the expected "not cached" path
      if ((e as Error).message?.includes('Not cached')) return null;
      throw e;
    }
  },

  analyze: (input: string, settings: Settings) =>
    jsonFetch<{ result: AnalysisResult; meta: AnalysisRunMeta }>(`${BASE}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input,
        model: settings.model,
        search: settings.searches,         // array goes through as-is
        pplx: settings.pplx,
      }),
    }),

  /**
   * Streaming analyze: opens a Server-Sent Events connection and forwards
   * progress events. Returns a cleanup function to close the connection early.
   */
  analyzeStream: (
    input: string,
    settings: Settings,
    handlers: {
      onProgress?: (ev: ProgressEvent) => void;
      onResult?:   (data: { result: AnalysisResult; meta: AnalysisRunMeta }) => void;
      onError?:    (msg: string) => void;
      onDone?:     () => void;
    },
  ): (() => void) => {
    const params = new URLSearchParams();
    params.set('input', input);
    params.set('model', settings.model);
    if (settings.pplx) params.set('pplx', settings.pplx);
    // Multi-search: append one ?search=… per provider; backend collects them.
    for (const s of settings.searches) params.append('search', s);
    const url = `${BASE}/analyze/stream?${params}`;
    const es  = new EventSource(url);

    es.addEventListener('progress', (e) => {
      try { handlers.onProgress?.(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
    });
    es.addEventListener('result', (e) => {
      try { handlers.onResult?.(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      if (data) {
        try { handlers.onError?.(JSON.parse(data).message ?? 'stream error'); } catch { handlers.onError?.('stream error'); }
      } else {
        // EventSource native error (network / connection)
        handlers.onError?.('Connection lost');
      }
      es.close();
    });
    es.addEventListener('done', () => {
      handlers.onDone?.();
      es.close();
    });

    return () => es.close();
  },

  reportPdfUrl: (symbol: string) =>
    `${BASE}/stocks/${encodeURIComponent(symbol)}/report.pdf`,

  reportMarkdownUrl: (symbol: string) =>
    `${BASE}/stocks/${encodeURIComponent(symbol)}/report.md`,

  fetchReportMarkdown: async (symbol: string): Promise<string | null> => {
    const res = await fetch(`${BASE}/stocks/${encodeURIComponent(symbol)}/report.md`);
    if (!res.ok) return null;
    return res.text();
  },
};
