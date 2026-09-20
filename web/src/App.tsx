import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from './api';
import StockRail from './components/StockRail';
import StockTable from './components/StockTable';
import AnalyzeForm from './components/AnalyzeForm';
import SettingsSidebar from './components/SettingsSidebar';
import AnalysisView from './components/AnalysisView';
import ProgressBanner from './components/ProgressBanner';
import Toolbar, { type ViewName } from './components/Toolbar';
import AdminPage from './pages/AdminPage';
import { applyListView, DEFAULT_LIST_VIEW, type ListView } from './components/stockList';
import type { Settings, OverviewRow, ProgressEvent, SearchChoice } from './types';
import { DEFAULT_MODEL_ID, resolveModelId } from '../../src/models';

const DEFAULT_SETTINGS: Settings = {
  model:    DEFAULT_MODEL_ID,
  searches: [],
  pplx:     null,
};

/**
 * Hash routing. The tabs made the hash carry two things — which view, and which
 * symbol the analysis view is on — so it is now `#/overview`, `#/admin` or
 * `#/stock/AAPL`. Bare `#AAPL` still resolves to the analysis view: those links
 * are in people's bookmarks and history, and honouring them costs one branch.
 */
interface RouteState {
  view:   ViewName;
  symbol: string | null;
}

function readRoute(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { view: 'analysis', symbol: null };
  const [head, tail] = raw.split('/');
  const key = head.toLowerCase();
  if (key === 'overview') return { view: 'overview', symbol: null };
  if (key === 'admin')    return { view: 'admin', symbol: null };
  if (key === 'stock')    return { view: 'analysis', symbol: tail ? tail.toUpperCase() : null };
  return { view: 'analysis', symbol: raw.toUpperCase() };   // legacy `#AAPL`
}

function routeToHash(route: RouteState): string {
  if (route.view === 'overview') return '#/overview';
  if (route.view === 'admin')    return '#/admin';
  return route.symbol ? `#/stock/${route.symbol}` : '';
}

function writeRoute(route: RouteState): void {
  const hash = routeToHash(route);
  const next = hash || window.location.pathname + window.location.search;
  // Compare against the FULL current URL. The old guard compared `next` against
  // the very expression it was derived from in the clear case, so it could
  // never write — a deleted/deselected stock's hash was never removed and
  // reappeared on reload.
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) {
    window.history.replaceState(null, '', next);
  }
}

export default function App() {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [route, setRoute] = useState<RouteState>(() => readRoute());
  const [selected, setSelectedRaw] = useState<string | null>(() => readRoute().symbol);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  // How the list is filtered and ordered. Owned here, not by either density,
  // so collapsing the table into the rail — or opening it back up — keeps the
  // list you had built.
  const [listView, setListView] = useState<ListView>(DEFAULT_LIST_VIEW);
  const closeStreamRef = useRef<(() => void) | null>(null);
  // Monotonic id of the active analyze run. Switching symbols (or starting a
  // new run) bumps it; stale SSE callbacks check it and no-op so a finished
  // run can't navigate/clobber state after the user has moved on.
  const runIdRef = useRef(0);
  // Whether the user has manually edited settings for the current symbol — if
  // so, the cached-analysis auto-switch must not overwrite their choice.
  const userTouchedSettingsRef = useRef(false);
  // Below `lg` (1024px) one of the two side panels can slide in as a drawer.
  // Above `lg` both panels are always visible in the flex flow and this state
  // is irrelevant.
  const [mobileMenu, setMobileMenu] = useState<'stocks' | 'settings' | null>(null);
  /** Symbols the queue is working on, keyed by symbol → the stages in flight. */
  const [activity, setActivity] = useState<Record<string, string[]>>({});

  // Selecting a symbol always means "show it" — from the table too, where the
  // click collapses the columns into the rail and opens the analysis beside it.
  const setSelected = useCallback((s: string | null) => {
    setSelectedRaw(s);
    setRoute((prev) => {
      const next: RouteState = { view: s ? 'analysis' : prev.view, symbol: s };
      writeRoute(next);
      return next;
    });
  }, []);

  const navigate = useCallback((view: ViewName) => {
    setRoute((prev) => {
      const next: RouteState = { view, symbol: prev.symbol };
      writeRoute(next);
      return next;
    });
  }, []);

  // React to back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const next = readRoute();
      setRoute(next);
      if (next.symbol) setSelectedRaw(next.symbol);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /**
   * The stock list — one request for both densities.
   *
   * `/api/overview` carries everything either of them renders, so the rail and
   * the table are two renderings of one payload rather than two lists fetched
   * from two endpoints that could disagree about what is stored.
   */
  const reloadRows = useCallback(async () => {
    try {
      const r = await api.listOverview();
      setRows(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRowsLoading(false);
    }
  }, []);

  useEffect(() => { void reloadRows(); }, [reloadRows, refreshTick]);

  // Cleanup any open SSE on unmount.
  useEffect(() => () => closeStreamRef.current?.(), []);

  const visibleRows = useMemo(() => applyListView(rows, listView), [rows, listView]);
  const selectedName = selected
    ? rows.find((r) => r.symbol === selected)?.companyName
    : undefined;

  // Resolve the actual model id (e.g. 'claude' shortcut → 'claude-sonnet-5')
  // for cache lookups. Server resolves these on POST, but for the read-only
  // GET `/analyses-by-flags?model=...` we send the shortcut string verbatim and
  // it'll miss; better to use the resolved ID. For now rely on the server
  // doing exact-match — user sees "not cached" until the analysis runs once.
  const flags = {
    model:  resolveModelId(settings.model),
    search: settings.searches.length === 0 ? 'none' : [...settings.searches].sort().join(','),
    pplx:   settings.pplx,
  };

  const handleSelectSymbol = useCallback((s: string) => {
    // Abandon any in-flight analyze run: invalidate its callbacks and abort the
    // SSE so a late onResult can't yank the user back to the old symbol.
    runIdRef.current++;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    setLoading(false);
    setSelected(s);
    setProgress([]);
  }, [setSelected]);

  // User-initiated settings change — flag it so the auto-switch effect yields.
  const handleSettingsChange = useCallback((s: Settings) => {
    userTouchedSettingsRef.current = true;
    setSettings(s);
  }, []);

  // Whenever the selected symbol changes (rail click, hash change, page load
  // with hash) auto-switch settings to the most recently cached analysis so the
  // AI Verdict has content to show. If nothing is cached, settings stay as-is
  // and the user sees "Not cached yet" with a Run button.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    // Fresh symbol → user hasn't touched settings for it yet.
    userTouchedSettingsRef.current = false;
    api.listAnalyses(selected)
      .then(({ analyses }) => {
        // Bail if the symbol changed OR the user has since edited settings
        // (don't clobber their in-progress choice with the cached default).
        if (cancelled || userTouchedSettingsRef.current || analyses.length === 0) return;
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

  /**
   * Ask the server what the queue is doing.
   *
   * A `useCallback` rather than a closure inside the effect, because the
   * interval is the fallback and not the mechanism: the moments that actually
   * change this are known — a run finishing, a refresh returning — and waiting
   * up to five seconds to notice something we were told about is the kind of
   * lag that makes an interface feel broken.
   */
  const pollActivity = useCallback(async () => {
    try {
      const { entries } = await api.activity();
      const bySymbol: Record<string, string[]> = {};
      for (const e of entries) {
        if (!e.symbol) continue;
        // The namespace prefix is an environment detail, not something to put
        // in front of a user.
        const stage = e.workflow.replace(/^[a-z0-9]+_/, '');
        (bySymbol[e.symbol] ??= []).push(stage);
      }
      setActivity(bySymbol);
    } catch {
      // A failed poll is not worth an error banner; the next one may work.
      setActivity({});
    }
  }, []);

  /**
   * The fallback loop: work this page never started, or that outlived it.
   * Immediate on mount, so a reload shows the true state at once rather than
   * five seconds later.
   */
  useEffect(() => {
    void pollActivity();
    const timer = setInterval(() => { void pollActivity(); }, 5_000);
    return () => clearInterval(timer);
  }, [pollActivity]);

  /**
   * Start an analyze run. `force` bypasses the LLM cache — used by the
   * sidebar's "Re-run (without cache)" and the StaleBanner's re-run action.
   * The plain Run button leaves it false so a cached entry serves instantly.
   */
  function startAnalyze(input: string, force = false) {
    const myRun = ++runIdRef.current;       // claim this run; supersedes any prior
    const isCurrent = () => runIdRef.current === myRun;
    setLoading(true);
    setError(null);
    setProgress([]);
    closeStreamRef.current?.();

    const close = api.analyzeStream(input, settings, {
      onProgress: (ev) => { if (isCurrent()) setProgress((prev) => [...prev, ev]); },
      onResult:   ({ meta }) => {
        if (!isCurrent()) return;
        // Refresh the list (in case new symbol) and select the resolved one —
        // but only if the user hasn't moved on to another symbol meanwhile.
        reloadRows().then(() => { if (isCurrent()) setSelected(meta.symbol); });
        setRefreshTick((t) => t + 1);
      },
      onError: (msg) => {
        if (!isCurrent()) return;
        setError(msg);
        setLoading(false);
        void pollActivity();
      },
      onDone: () => {
        if (!isCurrent()) return;
        setLoading(false);
        setRefreshTick((t) => t + 1);
        // The run just ended; say so now rather than on the next tick.
        void pollActivity();
      },
    }, { force });
    closeStreamRef.current = close;
  }

  /**
   * Add a stock: data only. The user lands on it with the numbers filled in and
   * no verdict, and starts the LLM run themselves from the settings sidebar —
   * so "let me look at this ticker" never turns into an unasked-for API bill.
   */
  const addStock = useCallback(async (input: string) => {
    setError(null);
    const { symbol } = await api.addStock(input);
    await reloadRows();
    setSelected(symbol);
    setRefreshTick((t) => t + 1);
  }, [reloadRows, setSelected]);

  // Auto-close the stock drawer after picking a symbol on mobile.
  const handleSelectAndClose = useCallback((s: string) => {
    handleSelectSymbol(s);
    setMobileMenu(null);
  }, [handleSelectSymbol]);

  const isAnalysis = route.view === 'analysis';
  const isOverview = route.view === 'overview';

  /** Collapse the analysis and spread the list back out to full width. */
  const showTable = useCallback(() => {
    setMobileMenu(null);
    navigate('overview');
  }, [navigate]);

  // Esc backs out of the analysis to the table — the keyboard counterpart of
  // the rail's „← Übersicht". Skipped while a field has focus, where Esc means
  // "clear this input" and a search box already handles it natively.
  useEffect(() => {
    if (!isAnalysis) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      showTable();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAnalysis, showTable]);

  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      {/* Tabs, plus the mobile sidebar toggles that used to be their own bar.
          The drawer buttons only exist below lg and only for the analysis
          density — the table has no side panels to open. */}
      <Toolbar
        view={route.view}
        onNavigate={navigate}
        left={isAnalysis ? (
          <button
            onClick={() => setMobileMenu(mobileMenu === 'stocks' ? null : 'stocks')}
            className="rounded p-1.5 text-lg leading-none text-ink-200 hover:bg-ink-800 lg:hidden"
            aria-label="Aktienliste ein-/ausblenden"
          >☰</button>
        ) : null}
        right={isAnalysis ? (
          <button
            onClick={() => setMobileMenu(mobileMenu === 'settings' ? null : 'settings')}
            className="rounded p-1.5 text-base leading-none text-ink-200 hover:bg-ink-800 lg:hidden"
            aria-label="Einstellungen ein-/ausblenden"
          >⚙</button>
        ) : null}
        status={selected && isAnalysis ? (
          <span className="hidden truncate font-mono text-xs text-ink-500 sm:inline">{selected}</span>
        ) : null}
      />

      {/* Backdrop while a mobile drawer is open. Clicking it closes the drawer. */}
      {mobileMenu && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setMobileMenu(null)}
          aria-hidden
        />
      )}

      {/* Errors belong to the window, not to one density: an add or a list
          reload can fail while the table is what's on screen. */}
      {error && (
        <div className="shrink-0 border-b border-red-700 bg-red-950 px-4 py-2 text-sm text-red-400">
          ⚠ {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-red-400 hover:text-red-200"
          >×</button>
        </div>
      )}

      {route.view === 'admin' && <AdminPage />}

      {/* The list at full width. Cheap to rebuild, so it mounts and unmounts. */}
      {isOverview && (
        <StockTable
          rows={visibleRows}
          total={rows.length}
          loading={rowsLoading}
          view={listView}
          onViewChange={setListView}
          selectedSymbol={selected}
          onSelect={handleSelectSymbol}
        />
      )}

      {/* The same list at rail width, with the analysis beside it. Hidden
          rather than unmounted: an analysis run can take minutes, and going
          back to the table mid-run must not tear down its SSE stream and lose
          the progress. */}
      <div className={`flex flex-1 overflow-hidden ${isAnalysis ? '' : 'hidden'}`}>
        {/* Slide-in drawer on mobile, regular column on lg+ */}
        <div
          className={`fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out
            ${mobileMenu === 'stocks' ? 'translate-x-0' : '-translate-x-full'}
            lg:relative lg:inset-auto lg:translate-x-0 lg:transition-none`}
        >
          <StockRail
            rows={visibleRows}
            total={rows.length}
            activity={activity}
            view={listView}
            onViewChange={setListView}
            selectedSymbol={selected}
            onSelect={handleSelectAndClose}
            onShowAll={showTable}
            onDeleted={(s) => {
              if (selected === s) setSelected(null);
              void reloadRows();
            }}
          />
        </div>

        <main className="flex flex-1 flex-col overflow-hidden">
          <ProgressBanner events={progress} active={loading} />
          {selected ? (
            <AnalysisView
              symbol={selected}
              fallbackName={selectedName}
              flags={flags}
              refreshKey={refreshTick}
              // StaleBanner's Re-run = force fresh LLM call (cache is stale by data).
              onRunAnalysis={() => startAnalyze(selected, true)}
              // `loading` only covers a run this page is streaming; the queue
              // knows about the ones it is not — after a reload, or in another
              // tab. Either is reason enough to call the buttons busy.
              analyzing={loading
                || (activity[selected] ?? []).some((s) => s === 'analyze' || s === 'symbol-pipeline')}
              activity={activity[selected] ?? []}
              onActivityChanged={() => { void pollActivity(); }}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-ink-400">
              <div>
                <p className="mb-2 text-lg font-semibold text-ink-200">Aktie aus der Liste wählen</p>
                <p className="text-sm">
                  oder unten eine neue hinzufügen — Ticker (NVDA) oder Firmenname (Siemens Energy).
                  Das holt zunächst nur die Daten; die Analyse startest du danach rechts.
                </p>
              </div>
            </div>
          )}
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
            onChange={handleSettingsChange}
            // First-time Run: cache hit serves instantly, miss runs the LLM.
            onLoad={() => selected && startAnalyze(selected, false)}
            // "Re-run (without cache)": force a fresh LLM call, overwriting cache.
            onReload={() => selected && startAnalyze(selected, true)}
            loading={loading}
          />
        </div>
      </div>

      {/* One add field for the whole window, below whichever density is up —
          the table used to have no way to add a stock at all. */}
      {route.view !== 'admin' && (
        <AnalyzeForm
          onAdd={addStock}
          analyzing={loading}
          hint={isAnalysis
            ? 'holt nur die Daten — Analyse startest du rechts'
            : 'holt nur die Daten — Analyse startest du nach dem Klick auf die Aktie'}
        />
      )}
    </div>
  );
}
