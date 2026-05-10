import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import StockSidebar from './components/StockSidebar';
import AnalyzeForm from './components/AnalyzeForm';
import SettingsSidebar from './components/SettingsSidebar';
import AnalysisView from './components/AnalysisView';
import ProgressBanner from './components/ProgressBanner';
import type { Settings, StockSummary, ProgressEvent, SearchChoice } from './types';

const DEFAULT_SETTINGS: Settings = {
  model:    'claude',
  searches: [],
  pplx:     null,
};

// Hash-based routing: `#AAPL` → selected = 'AAPL'. Survives reload, supports
// browser back/forward, no server config needed (works in dev + prod).
function readSymbolFromHash(): string | null {
  const h = window.location.hash.replace(/^#\/?/, '').toUpperCase();
  return h || null;
}
function writeSymbolToHash(symbol: string | null): void {
  const next = symbol ? `#${symbol}` : window.location.pathname + window.location.search;
  if (next !== window.location.hash && next !== window.location.pathname + window.location.search) {
    window.history.replaceState(null, '', next);
  }
}

export default function App() {
  const [stocks, setStocks] = useState<StockSummary[]>([]);
  const [selected, setSelectedRaw] = useState<string | null>(() => readSymbolFromHash());
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);
  // Below `lg` (1024px) one of the two side panels can slide in as a drawer.
  // Above `lg` both panels are always visible in the flex flow and this state
  // is irrelevant.
  const [mobileMenu, setMobileMenu] = useState<'stocks' | 'settings' | null>(null);

  // Wrap setSelected to keep URL hash in sync
  const setSelected = useCallback((s: string | null) => {
    setSelectedRaw(s);
    writeSymbolToHash(s);
  }, []);

  // React to back/forward navigation
  useEffect(() => {
    const onHashChange = () => setSelectedRaw(readSymbolFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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
    search: settings.searches.length === 0 ? 'none' : [...settings.searches].sort().join(','),
    pplx:   settings.pplx,
  };

  const handleSelectSymbol = useCallback((s: string) => {
    setSelected(s);
    setProgress([]);
  }, [setSelected]);

  // Whenever the selected symbol changes (sidebar click, hash change, page
  // load with hash) auto-switch settings to the most recently cached analysis
  // so the AI Verdict has content to show. If nothing is cached, settings
  // stay as-is and the user sees "Not cached yet" with a Run button.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api.listAnalyses(selected)
      .then(({ analyses }) => {
        if (cancelled || analyses.length === 0) return;
        const newest = [...analyses].sort(
          (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
        )[0];
        setSettings({
          model:    newest.flags.model,
          searches: newest.flags.search === 'none'
            ? []
            : (newest.flags.search.split(',') as SearchChoice[]),
          pplx:     newest.flags.pplx,
        });
      })
      .catch(() => { /* keep current settings on error */ });
    return () => { cancelled = true; };
  }, [selected]);

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

  // Auto-close the stock drawer after picking a symbol on mobile.
  const handleSelectAndClose = useCallback((s: string) => {
    handleSelectSymbol(s);
    setMobileMenu(null);
  }, [handleSelectSymbol]);

  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      {/* Mobile-only top bar with sidebar toggles. Hidden on lg+ where both
          sidebars are always visible in the flex flow. */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-3 py-2 lg:hidden">
        <button
          onClick={() => setMobileMenu(mobileMenu === 'stocks' ? null : 'stocks')}
          className="rounded p-1.5 text-lg leading-none text-ink-200 hover:bg-ink-800"
          aria-label="Toggle stock list"
        >☰</button>
        <span className="truncate font-mono text-xs text-ink-300">
          {selected ?? 'pick a stock below'}
        </span>
        <button
          onClick={() => setMobileMenu(mobileMenu === 'settings' ? null : 'settings')}
          className="rounded p-1.5 text-base leading-none text-ink-200 hover:bg-ink-800"
          aria-label="Toggle settings"
        >⚙</button>
      </header>

      {/* Backdrop while a mobile drawer is open. Clicking it closes the drawer. */}
      {mobileMenu && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileMenu(null)}
          aria-hidden
        />
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Stock sidebar — slide-in drawer on mobile, regular column on lg+ */}
        <div
          className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out
            ${mobileMenu === 'stocks' ? 'translate-x-0' : '-translate-x-full'}
            lg:relative lg:inset-auto lg:translate-x-0 lg:transition-none`}
        >
          <StockSidebar
            stocks={stocks}
            selectedSymbol={selected}
            onSelect={handleSelectAndClose}
            onDeleted={(s) => {
              if (selected === s) setSelected(null);
              reloadStockList();
            }}
          />
        </div>

        <main className="flex flex-1 flex-col overflow-hidden">
          {error && (
            <div className="border-b border-red-700 bg-red-950 px-4 py-2 text-sm text-red-400">
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
              onRunAnalysis={() => startAnalyze(selected)}
              analyzing={loading}
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

        {/* Settings sidebar — slide-in drawer on mobile, regular column on lg+ */}
        <div
          className={`fixed inset-y-0 right-0 z-40 transition-transform duration-200 ease-out
            ${mobileMenu === 'settings' ? 'translate-x-0' : 'translate-x-full'}
            lg:relative lg:inset-auto lg:translate-x-0 lg:transition-none`}
        >
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
