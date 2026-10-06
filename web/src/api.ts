import type {
  AnalysisListEntry,
  CachedAnalysisEntry,
  AnalysisFlagsKey,
  AnalysisResult,
  AnalysisRunMeta,
  Settings,
  StockBundle,
  ProgressEvent,
  DistillRefreshResponse,
  PerplexityRefreshResponse,
  ResearchPromptResponse,
  ResearchPasteResponse,
  PplxChoice,
  OverviewRow,
  MetricCatalogEntry,
  MetricSeries,
  DocumentVersion,
  AppConfig,
  ConfigResponse,
  ConfigSaveResponse,
  AddStockResponse,
  PeersResponse,
  SchedulerStatus,
  ActivityEntry,
  EvaluationResponse,
  BacktestResponse,
  VerdictChangesResponse,
} from './types';
import type { HistoryMultiple, SectorMultiples, ValuationHistory } from '../../src/analysis/valuation-history';
import type { FairRatio } from '../../src/analysis/fair-ratio';
import type { Holders } from '../../src/analysis/holders';
import type { Timeline } from '../../src/analysis/timeline';
import type { ChartReadDoc, ChartResponse } from '../../src/analysis/chart';
import type { JournalEntry, JournalInput, JournalKind, OpenTrades } from '../../src/journal';
import type { EntryContext } from '../../src/analysis/entry-context';
import type { DepotResponse } from '../../src/analysis/depot';
import type { ReviewResponse } from '../../src/review-service';
import type { ManualResearchTool } from '../../src/models';
import type { ResearchKind, ResearchReport } from '../../src/research/kinds';
import type { BacktestOverview } from '../../src/backtest-service';
import type { CalibrationOverview } from '../../src/calibration-service';
import type { VerdictEvidence } from '../../src/backtest/result';
import type {
  CoverageView, Feed, IncomeFlows, TrackRecordView, VerdictRecordSummary, VerdictRecordView,
} from '../../src/stock-history-service';

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
  listModels: () =>
    jsonFetch<ModelInfo>(`${BASE}/models`),

  /**
   * What the queue is working on right now.
   *
   * Asked of the server rather than tracked in the browser, because the state
   * outlives the tab: the work runs in a worker, so a reload — or a second
   * window — should still see the refresh that is in flight. Local state can
   * only ever know about requests this page started.
   */
  activity: () =>
    jsonFetch<{ hatchet: boolean; busy: boolean; entries: ActivityEntry[] }>(`${BASE}/activity`),

  deleteStock: (symbol: string) =>
    jsonFetch<{ ok: boolean; symbol: string }>(`${BASE}/stocks/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
    }),

  /**
   * Add a stock: resolve ticker or company name, fetch the data layer, done.
   * No LLM call — analysing is a separate, explicit step.
   */
  addStock: (input: string) =>
    jsonFetch<AddStockResponse>(`${BASE}/stocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }),

  /**
   * The companies to compare a stock with: its Finnhub peer group and the rest
   * of its industry among the list and the reference universe. Read from the
   * database — no LLM call, and a Yahoo quote only for peers never stored.
   */
  getPeers: (symbol: string) =>
    jsonFetch<PeersResponse>(`${BASE}/stocks/${encodeURIComponent(symbol)}/peers`),

  // The archive, read back — see `src/stock-history-service.ts`.
  getAnalystRecord: (symbol: string) =>
    jsonFetch<{ symbol: string; data: TrackRecordView | null }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/analysts`),
  /** Each firm's newest grade and target from the last year — the consensus card, firm by firm. */
  getCoverage: (symbol: string) =>
    jsonFetch<{ symbol: string; data: CoverageView | null }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/coverage`),
  getVerdictRecord: (symbol: string) =>
    jsonFetch<{ symbol: string; data: VerdictRecordView | null }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/verdicts`),
  /** What happened across the watchlist over the last `days`. */
  getFeed: (days = 7) => jsonFetch<Feed>(`${BASE}/feed?days=${days}`),

  /** Every journal entry, newest first — or those naming `symbol`. */
  getJournal: (symbol?: string) =>
    jsonFetch<{ entries: JournalEntry[] }>(`${BASE}/journal${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
  addJournal: (entry: JournalInput) =>
    jsonFetch<JournalEntry>(`${BASE}/journal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
    }),
  /** Replaces the wording; the server keeps the one it replaces. */
  editJournal: (id: number, entry: JournalInput) =>
    jsonFetch<JournalEntry>(`${BASE}/journal/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
    }),
  deleteJournal: (id: number) =>
    jsonFetch<{ ok: true }>(`${BASE}/journal/${id}`, { method: 'DELETE' }),
  /** Purchases and sales from umsatz still waiting for a reason; `sync` asks umsatz first. */
  getOpenTrades: (symbol?: string, sync = false) =>
    jsonFetch<OpenTrades>(`${BASE}/trades/open?${new URLSearchParams({
      ...(symbol ? { symbol } : {}), ...(sync ? { sync: '1' } : {}),
    })}`),
  /** My purchases and sales against the S&P 500, with the patterns across them. */
  getReview: () => jsonFetch<ReviewResponse>(`${BASE}/review`),
  /** The depot weighed against the model; `sync` asks umsatz first. */
  getDepot: (sync = false) => jsonFetch<DepotResponse>(`${BASE}/depot${sync ? '?sync=1' : ''}`),
  /** Mark trades as needing no reason. */
  dismissTrades: (ids: number[]) =>
    jsonFetch<{ dismissed: number }>(`${BASE}/trades/dismiss`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
    }),
  /** The situation of the named stocks on `day` — run-up, volume, our verdict, a report due. */
  getEntryContext: (symbols: string[], day: string, kind: JournalKind) =>
    jsonFetch<{ contexts: EntryContext[] }>(
      `${BASE}/journal/context?symbols=${encodeURIComponent(symbols.join(','))}&day=${day}&kind=${kind}`,
    ),
  /** Every stored verdict as a call, against the index — cached on the server for hours. */
  getVerdictRecordSummary: () => jsonFetch<VerdictRecordSummary>(`${BASE}/verdict-record`),
  getTimeline: (symbol: string, days = 365) =>
    jsonFetch<{ symbol: string; data: Timeline }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/timeline?days=${days}`),
  getHolders: (symbol: string) =>
    jsonFetch<{ symbol: string; data: Holders | null }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/holders`),
  getIncomeFlow: (symbol: string) =>
    jsonFetch<{ symbol: string; data: IncomeFlows | null }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/income-flow`),

  /** Two years of daily bars, the levels and channels read from them, and the newest model reading. */
  getChart: (symbol: string) =>
    jsonFetch<ChartResponse>(`${BASE}/stocks/${encodeURIComponent(symbol)}/chart`),
  /** A model reads the chart — one call, up to a minute or two on a reasoning model. */
  runChartRead: (symbol: string, model: string) =>
    jsonFetch<ChartReadDoc>(`${BASE}/stocks/${encodeURIComponent(symbol)}/chart-read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    }),

  /** Five years rebuilt month by month — a few seconds the first time a stock is opened each day. */
  getValuationHistory: (symbol: string) =>
    jsonFetch<{
      symbol: string; history: ValuationHistory | null; sector: SectorMultiples | null;
      fair: Partial<Record<HistoryMultiple, FairRatio>>;
    }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/valuation-history`,
    ),

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

  /**
   * Ask Perplexity again, ignoring the cache window every analysis honours.
   * Billed — one call. Without a model the server uses sonar-pro.
   */
  refreshPerplexity: (symbol: string, model?: PplxChoice) =>
    jsonFetch<PerplexityRefreshResponse>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/perplexity-refresh`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(model ? { model } : {}),
      },
    ),

  /** The prompt for a kind of research, filled in, to run in a chat app's research mode. */
  getResearchPrompt: (kind: ResearchKind, symbols: string[], extra: { question?: string; decision?: string } = {}) =>
    jsonFetch<ResearchPromptResponse>(`${BASE}/research/prompt?${new URLSearchParams({
      kind, symbols: symbols.join(','),
      ...(extra.question ? { question: extra.question } : {}), ...(extra.decision ? { decision: extra.decision } : {}),
    })}`),
  /** Read a pasted answer; with `save`, keep it. */
  pasteResearch: (input: {
    kind: ResearchKind; symbols: string[]; question?: string; decision?: string;
    text: string; tool: ManualResearchTool; save: boolean;
  }) =>
    jsonFetch<ResearchPasteResponse>(`${BASE}/research/paste`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }),
  /** Research reports naming `symbol`, or all of them — every kind but the company brief. */
  getResearch: (symbol?: string) =>
    jsonFetch<{ reports: ResearchReport[] }>(`${BASE}/research${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
  deleteResearch: (id: number) =>
    jsonFetch<{ ok: true }>(`${BASE}/research/${id}`, { method: 'DELETE' }),

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

  // ── Recorded history ──────────────────────────────────────────────────────
  // The set of chartable numbers is a query parameter now, not a fixed shape:
  // `listMetrics` is the picker's data source and `getSeries` draws whatever
  // was picked.

  /** The stored backtest — cheap, it is computed by `pnpm run backtest` or the monthly run, not here. */
  getBacktest: () =>
    jsonFetch<BacktestResponse>(`${BASE}/backtest`),
  /** What each verdict did in the newest backtest — small, for the verdict wherever it is shown. */
  getVerdictEvidence: () => jsonFetch<VerdictEvidence | null>(`${BASE}/backtest/verdicts`),
  /** The run in progress, the monthly schedule and every run kept. */
  getBacktestOverview: () => jsonFetch<BacktestOverview>(`${BASE}/backtest/overview`),
  /** Start a run now; refused while one is going. */
  runBacktest: () => jsonFetch<{ started: boolean; reason: string | null }>(`${BASE}/backtest/run`, { method: 'POST' }),
  /** The newest calibration proposal and the run making one — `calibration-service.ts`. */
  getCalibration: () => jsonFetch<CalibrationOverview>(`${BASE}/calibration`),
  runCalibration: () => jsonFetch<{ started: boolean; reason: string | null }>(`${BASE}/calibration/run`, { method: 'POST' }),
  /** Where the proposed `calibration-table.ts` downloads from. */
  calibrationTableUrl: `${BASE}/calibration/table`,

  /** Rank IC of the stored scores against later returns. Slow when not cached server-side. */
  getEvaluation: (horizons: number[], fresh = false) =>
    jsonFetch<EvaluationResponse>(`${BASE}/evaluation?horizons=${horizons.join(',')}${fresh ? '&fresh=1' : ''}`),

  listMetrics: (domain?: string) =>
    jsonFetch<{ metrics: MetricCatalogEntry[] }>(
      `${BASE}/metrics${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`,
    ),

  getSeries: (symbol: string, keys: string[], range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams({ keys: keys.join(',') });
    if (range?.from) params.set('from', range.from);
    if (range?.to)   params.set('to', range.to);
    return jsonFetch<{ symbol: string; series: MetricSeries[] }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/series?${params}`,
    );
  },

  /** Version history of a text output — Distill, Perplexity, verdicts. */
  getDocuments: (symbol: string, kind: 'distill' | 'perplexity' | 'verdict' | 'search_trace', limit = 20) =>
    jsonFetch<{ symbol: string; kind: string; documents: DocumentVersion[] }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/documents/${kind}?limit=${limit}`,
    ),

  getFundamentals: (symbol: string, period: 'annual' | 'quarter' | 'estimate' = 'annual') =>
    jsonFetch<{ symbol: string; period: string; rows: { periodEnd: string; key: string; value: number; observedAt: string }[] }>(
      `${BASE}/stocks/${encodeURIComponent(symbol)}/fundamentals?period=${period}`,
    ),

  // ── Administration ────────────────────────────────────────────────────────

  getConfig: () =>
    jsonFetch<ConfigResponse>(`${BASE}/config`),

  /** The newest band changes on the watchlist, or of one stock. */
  getVerdictChanges: (limit = 30, symbol?: string) =>
    jsonFetch<VerdictChangesResponse>(
      `${BASE}/verdict-changes?limit=${limit}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`,
    ),

  /** One test message to the configured webhook. */
  testAlert: () =>
    jsonFetch<{ ok: boolean; error?: string }>(`${BASE}/alerts/test`, { method: 'POST' }),
  testDigest: () =>
    jsonFetch<{ ok: boolean; events: number; error?: string }>(`${BASE}/alerts/digest/test`, { method: 'POST' }),

  /** Whole-object write; the server reinstalls the cron before answering. */
  saveConfig: (config: AppConfig) =>
    jsonFetch<ConfigSaveResponse>(`${BASE}/config`, {
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
    jsonFetch<{ symbol: string; analyses: AnalysisListEntry[] }>(`${BASE}/stocks/${encodeURIComponent(symbol)}/analyses`),

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
