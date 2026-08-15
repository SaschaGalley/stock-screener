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
  DistillRefreshResponse,
  OverviewRow,
  HistoryPoint,
  AppConfig,
  ConfigResponse,
  SchedulerStatus,
} from './types';

const BASE = '/api';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; message?: string };
      // Keep the machine-readable code first — callers match on it — but carry
      // the human-readable detail along; some errors (e.g. an ambiguous entity
      // and its candidates) are only actionable with it.
      if (body.error) errorMsg = body.message ? `${body.error}: ${body.message}` : body.error;
      else if (body.message) errorMsg = body.message;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }
  return res.json() as Promise<T>;
}

export interface ModelInfo {
  /** The selectable registry from `src/models.ts`. */
  models: { id: string; label: string; provider: string }[];
  /** Model IDs found in the analysis cache — includes retired ones. */
  used:   { modelId: string; count: number }[];
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

  /** Force-refresh raw data (Yahoo + Finnhub + FRED + macro). No LLM call. */
  refreshData: (symbol: string) =>
    jsonFetch<{ ok: boolean; symbol: string }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/refresh-data`, {
      method: 'POST',
    }),

  /**
   * Trigger Distill's substance-based refresh: drains pending raw insights
   * for this ticker and either returns the still-current briefing or generates
   * a fresh one. Long-running on first-touch tickers (up to 5 minutes); the
   * server extends its own socket timeout, but the browser request still
   * needs a permissive AbortSignal.
   *
   * Errors:
   *   - 400 → DISTILL_API_KEY not configured on the server (informational)
   *   - 403 → key is read-only; UI should disable the affordance
   *   - 5xx → propagated as Error for the caller to surface
   */
  refreshDistill: (symbol: string) =>
    jsonFetch<DistillRefreshResponse>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/distill-refresh`,
      {
        method: 'POST',
        // No explicit AbortSignal — the browser default (no timeout for fetch)
        // is what we want here. Fetch only aborts via explicit signal.
      },
    ),

  deleteAnalysis: (symbol: string, hash: string) =>
    jsonFetch<{ ok: boolean; symbol: string; hash: string }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/analyses/${hash}`,
      { method: 'DELETE' },
    ),

  getStock: (symbol: string) =>
    jsonFetch<StockBundle>(`${BASE}/stocks/${encodeURIComponent(symbol)}`),

  /** Ranked overview rows — already sorted by verdict score on the server. */
  listOverview: () =>
    jsonFetch<{ rows: OverviewRow[] }>(`${BASE}/overview`),

  getHistory: (symbol: string) =>
    jsonFetch<{ symbol: string; points: HistoryPoint[] }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/history`,
    ),

  // ── Administration ────────────────────────────────────────────────────────

  getConfig: () =>
    jsonFetch<ConfigResponse>(`${BASE}/config`),

  /** Whole-object write; the server reinstalls the cron before answering. */
  saveConfig: (config: AppConfig) =>
    jsonFetch<{ ok: boolean; config: AppConfig; scheduler: SchedulerStatus }>(`${BASE}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),

  getJobs: () =>
    jsonFetch<SchedulerStatus>(`${BASE}/jobs`),

  /** Returns as soon as the run is claimed — poll getJobs() for progress. */
  runJob: (symbols?: string[]) =>
    jsonFetch<{ ok: boolean; started: boolean }>(`${BASE}/jobs/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(symbols?.length ? { symbols } : {}),
    }),

  stopJob: () =>
    jsonFetch<{ ok: boolean; stopping: boolean }>(`${BASE}/jobs/stop`, { method: 'POST' }),

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
   *
   * Pass `force: true` to bypass the LLM cache. Without this the server hits
   * the cached entry (since analyses are now hash-keyed without TTL) and
   * "Re-run" becomes a no-op.
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
    opts?: { force?: boolean },
  ): (() => void) => {
    const params = new URLSearchParams();
    params.set('input', input);
    params.set('model', settings.model);
    if (settings.pplx) params.set('pplx', settings.pplx);
    if (opts?.force) params.set('force', '1');
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
