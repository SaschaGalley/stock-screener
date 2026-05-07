import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import StockSidebar from './components/StockSidebar';
import AnalyzeForm from './components/AnalyzeForm';
import SettingsSidebar from './components/SettingsSidebar';
import AnalysisView from './components/AnalysisView';
import ProgressBanner from './components/ProgressBanner';
import type { Settings, StockSummary, ProgressEvent } from './types';

const DEFAULT_SETTINGS: Settings = {
  model:  'claude',
  search: 'none',
  pplx:   null,
};

export default function App() {
  const [stocks, setStocks] = useState<StockSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);

  const reloadStockList = useCallback(async () => {
    try {
      const r = await api.listStocks();
      setStocks(r.stocks);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { reloadStockList(); }, [reloadStockList]);

  // Cleanup any open SSE on unmount.
  useEffect(() => () => closeStreamRef.current?.(), []);

  const summary = selected ? stocks.find((s) => s.symbol === selected) : undefined;

  // Resolve the actual model id (e.g. 'claude' shortcut → 'claude-sonnet-4-6')
  // for cache lookups. Server resolves these on POST, but for the read-only
  // GET `/analyses-by-flags?model=...` we send the shortcut string verbatim and
  // it'll miss; better to use the resolved ID. For now rely on the server
  // doing exact-match — user sees "not cached" until the analysis runs once.
  const flags = {
    model:  resolveClientModel(settings.model),
    search: settings.search,
    pplx:   settings.pplx,
  };

  function startAnalyze(input: string) {
    setLoading(true);
    setError(null);
    setProgress([]);
    closeStreamRef.current?.();

    const close = api.analyzeStream(input, settings, {
      onProgress: (ev) => setProgress((prev) => [...prev, ev]),
      onResult:   ({ meta }) => {
        // Refresh stock list (in case new symbol) and select the resolved one.
        reloadStockList().then(() => setSelected(meta.symbol));
        setRefreshTick((t) => t + 1);
      },
      onError: (msg) => {
        setError(msg);
        setLoading(false);
      },
      onDone: () => {
        setLoading(false);
        setRefreshTick((t) => t + 1);
      },
    });
    closeStreamRef.current = close;
  }

  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      <div className="flex flex-1 overflow-hidden">
        <StockSidebar
          stocks={stocks}
          selectedSymbol={selected}
          onSelect={(s) => { setSelected(s); setProgress([]); }}
          onDeleted={(s) => {
            if (selected === s) setSelected(null);
            reloadStockList();
          }}
        />

        <main className="flex flex-1 flex-col overflow-hidden">
          {error && (
            <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">
              ⚠ {error}
              <button
                onClick={() => setError(null)}
                className="ml-2 text-red-400 hover:text-red-200"
              >×</button>
            </div>
          )}
          <ProgressBanner events={progress} active={loading} />
          {selected ? (
            <AnalysisView
              symbol={selected}
              summary={summary}
              flags={flags}
              refreshKey={refreshTick}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-ink-400">
              <div>
                <p className="mb-2 text-lg font-semibold text-ink-200">Pick a stock from the sidebar</p>
                <p className="text-sm">
                  or analyze a new one below — type a ticker (NVDA) or company name (Siemens Energy).
                </p>
              </div>
            </div>
          )}
          <AnalyzeForm
            settings={settings}
            loading={loading}
            onAnalyze={startAnalyze}
          />
        </main>

        <SettingsSidebar
          symbol={selected}
          settings={settings}
          onChange={setSettings}
          onLoad={() => selected && startAnalyze(selected)}
          onReload={() => selected && startAnalyze(selected)}
          loading={loading}
        />
      </div>
    </div>
  );
}

// Server resolves shortcuts like 'claude' → 'claude-sonnet-4-6' but the cache
// lookup needs the exact stored id. Mirror the server's known shortcuts here.
const SHORTCUTS: Record<string, string> = {
  claude: 'claude-sonnet-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
  opus:   'claude-opus-4-7',
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-1.5-pro',
};

function resolveClientModel(s: string): string {
  return SHORTCUTS[s.toLowerCase()] ?? s;
}
