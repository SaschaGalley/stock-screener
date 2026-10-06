import { lazy, Suspense, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api';
import StockRail from './components/StockRail';
import StockTable from './components/StockTable';
import AnalyzeForm from './components/AnalyzeForm';
import AnalysisModal, { flagsLabel } from './components/AnalysisModal';
import PeersModal from './components/PeersModal';
import AnalysisView from './components/AnalysisView';
import { isStockTab, STOCK_TABS, type StockTab } from './components/StockTabs';
import { focusSearch, ShortcutsHelp, typing } from './components/Shortcuts';
import AppNav, { NavIcons, type NavKey } from './components/AppNav';
import AppBar from './components/AppBar';
import ProgressBanner from './components/ProgressBanner';
// The pages behind the gear, the chart icon and the pulse: loaded when opened,
// not with the list everyone opens first.
const AdminPage = lazy(() => import('./pages/AdminPage'));
const EvaluationPage = lazy(() => import('./pages/EvaluationPage'));
const FeedPage = lazy(() => import('./pages/FeedPage'));
const JournalPage = lazy(() => import('./pages/JournalPage'));
const DepotPage = lazy(() => import('./pages/DepotPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
import { applyListView, DEFAULT_LIST_VIEW, groupRows, type ListView } from './components/stockList';
import { EMPTY_ANCHOR, type ListScrollAnchor } from './components/useListScroll';
import type { Settings, OverviewRow, ProgressEvent, SearchChoice } from './types';
import { DEFAULT_MODEL_ID, resolveModelId } from '../../src/models';

const DEFAULT_SETTINGS: Settings = {
  model:    DEFAULT_MODEL_ID,
  searches: [],
  pplx:     null,
};

/**
 * Hash routing.
 *
 * `#/overview` is the list, `#/stock/AAPL` is the list with that stock open
 * beside it, `#/admin` is the administration, `#/evaluation` the score's
 * track record, `#/journal` my own notes and trades, `#/depot` the depot against the model, `#/review` my decisions looked back on. Bare `#AAPL` still resolves to a
 * stock: those links are in bookmarks and history, and honouring them costs one
 * branch. No hash is the list — the app's resting state is the whole list, not
 * an empty detail pane waiting to be told what to show.
 */
type ViewName = 'overview' | 'analysis' | 'admin' | 'evaluation' | 'feed' | 'journal' | 'depot' | 'review';

interface RouteState {
  view:   ViewName;
  symbol: string | null;
  /** The open stock's tab; null is its overview. */
  tab?:   StockTab | null;
}

function readRoute(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { view: 'overview', symbol: null };
  const [head, tail, sub] = raw.split('/');
  const key = head.toLowerCase();
  if (key === 'overview') return { view: 'overview', symbol: null };
  if (key === 'admin')    return { view: 'admin', symbol: null };
  if (key === 'evaluation') return { view: 'evaluation', symbol: null };
  if (key === 'feed')     return { view: 'feed', symbol: null };
  if (key === 'journal')  return { view: 'journal', symbol: null };
  if (key === 'depot')    return { view: 'depot', symbol: null };
  if (key === 'review')   return { view: 'review', symbol: null };
  if (key === 'stock') {
    const tab = sub?.toLowerCase();
    return { view: 'analysis', symbol: tail ? tail.toUpperCase() : null, tab: isStockTab(tab) && tab !== 'overview' ? tab : null };
  }
  return { view: 'analysis', symbol: raw.toUpperCase() };   // legacy `#AAPL`
}

function routeToHash(route: RouteState): string {
  if (route.view === 'admin')    return '#/admin';
  if (route.view === 'evaluation') return '#/evaluation';
  if (route.view === 'feed')     return '#/feed';
  if (route.view === 'journal')  return '#/journal';
  if (route.view === 'depot')    return '#/depot';
  if (route.view === 'review')   return '#/review';
  if (route.view === 'analysis' && route.symbol) return `#/stock/${route.symbol}${route.tab ? `/${route.tab}` : ''}`;
  return '#/overview';
}

function writeRoute(route: RouteState): void {
  const next = routeToHash(route);
  // Compare against the FULL current URL. The old guard compared `next` against
  // the very expression it was derived from in the clear case, so it could
  // never write — a deleted/deselected stock's hash was never removed and
  // reappeared on reload.
  const current = window.location.hash;
  if (next !== current) {
    window.history.replaceState(null, '', next);
  }
}

/**
 * Apply a state change as a view transition, where the browser has one.
 *
 * Folding the table into the rail swaps one element for another, so there is
 * nothing for CSS to animate between: without this the columns vanish between
 * two frames. `flushSync` is what makes the callback's DOM change land inside
 * the transition rather than after it. Browsers without the API — and anyone
 * who has asked for less motion — get the plain swap.
 */
function withViewTransition(apply: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (typeof doc.startViewTransition !== 'function' || reduced) {
    apply();
    return;
  }
  doc.startViewTransition(() => { flushSync(apply); });
}

/** No stages running — one array, so an idle stock's page sees the same prop each time. */
const NO_STAGES: string[] = [];

const RAIL_NARROW_KEY = 'stockcli:rail-narrow';

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
  // Where the list is scrolled. Shared by both densities so folding the columns
  // away leaves the stocks where they were on screen.
  const listScrollRef = useRef<ListScrollAnchor>(EMPTY_ANCHOR);
  const closeStreamRef = useRef<(() => void) | null>(null);
  // Monotonic id of the active analyze run. Switching symbols (or starting a
  // new run) bumps it; stale SSE callbacks check it and no-op so a finished
  // run can't navigate/clobber state after the user has moved on.
  const runIdRef = useRef(0);
  // Whether the user has manually edited settings for the current symbol — if
  // so, the cached-analysis auto-switch must not overwrite their choice.
  const userTouchedSettingsRef = useRef(false);
  // Below `lg` (1024px) the stock list slides in as a drawer; above it the
  // rail is always in the flex flow and this state is irrelevant.
  const [stocksDrawer, setStocksDrawer] = useState(false);
  /** Stored analyses and the settings for a new run, as a dialog over the page. */
  const [analysisOpen, setAnalysisOpen] = useState(false);
  /** Who else is in the business, and adding them — a dialog from the header. */
  const [peersOpen, setPeersOpen] = useState(false);
  /** The keys the app answers to, on `?`. */
  const [helpOpen, setHelpOpen] = useState(false);
  // The list beside an open stock, down to its tickers and scores: the page
  // gets the width, and the next stock is still a click away. A layout
  // preference, so it is remembered — unlike a fold inside the page.
  const [railNarrow, setRailNarrow] = useState(() => {
    try { return localStorage.getItem(RAIL_NARROW_KEY) === '1'; } catch { return false; }
  });
  const toggleRail = useCallback(() => setRailNarrow((n) => {
    try { localStorage.setItem(RAIL_NARROW_KEY, n ? '0' : '1'); } catch { /* not kept, then */ }
    return !n;
  }), []);
  /** Symbols the queue is working on, keyed by symbol → the stages in flight. */
  const [activity, setActivityState] = useState<Record<string, string[]>>({});
  /**
   * The queue as the poll found it — kept as the same object while it reads
   * the same. The poll runs every five seconds, and a fresh object each time
   * re-rendered the whole app with it: the open stock page and its charts,
   * 80 ms on the main thread every five seconds, a stutter in every scroll.
   */
  const setActivity = useCallback((next: Record<string, string[]>) => {
    setActivityState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  // Selecting a symbol always means "show it" — from the table too, where the
  // click collapses the columns into the rail and opens the analysis beside it.
  // Clearing one means the opposite: back to the list at full width.
  const setSelected = useCallback((s: string | null) => {
    setSelectedRaw(s);
    const next: RouteState = { view: s ? 'analysis' : 'overview', symbol: s };
    writeRoute(next);
    setRoute(next);
  }, []);

  const navigate = useCallback((view: ViewName) => {
    setRoute((prev) => {
      const next: RouteState = { view, symbol: prev.symbol, tab: view === 'analysis' ? prev.tab : null };
      writeRoute(next);
      return next;
    });
  }, []);

  /**
   * Switch the open stock's tab. Pushed rather than replaced: back goes to
   * the tab before, as it would between pages.
   */
  const openTab = useCallback((tab: StockTab) => {
    setRoute((prev) => {
      const next: RouteState = { ...prev, tab: tab === 'overview' ? null : tab };
      const hash = routeToHash(next);
      if (hash !== window.location.hash) window.history.pushState(null, '', hash);
      return next;
    });
  }, []);

  /** Close whatever is open and spread the list back out to full width. */
  // Closing is a deselect, not just a change of view. The row used to stay lit
  // in the table afterwards, which read as "still open"; and nothing needs the
  // selection to survive any more — the table finds its place again by the
  // stock that was at the top of the list (see useListScroll), not by it.
  const closeOverlay = useCallback(() => {
    withViewTransition(() => {
      setStocksDrawer(false);
      setSelected(null);
    });
  }, [setSelected]);

  const openAdmin = useCallback(() => {
    setStocksDrawer(false);
    navigate('admin');
  }, [navigate]);

  const openEvaluation = useCallback(() => {
    setStocksDrawer(false);
    navigate('evaluation');
  }, [navigate]);

  const openFeed = useCallback(() => {
    setStocksDrawer(false);
    navigate('feed');
  }, [navigate]);

  const openJournal = useCallback(() => {
    setStocksDrawer(false);
    navigate('journal');
  }, [navigate]);

  const openDepot = useCallback(() => {
    setStocksDrawer(false);
    navigate('depot');
  }, [navigate]);

  const openReview = useCallback(() => {
    setStocksDrawer(false);
    navigate('review');
  }, [navigate]);

  // React to back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const next = readRoute();
      setRoute(next);
      // Both ways, not only when a stock is named: a route without one must
      // also clear the selection, or back from a stock leaves it lit.
      setSelectedRaw(next.symbol);
    };
    window.addEventListener('hashchange', onHashChange);
    // A tab is pushed with `pushState`, and stepping back between two of them is a popstate.
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
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

  // Resolve the actual model id (e.g. 'claude' shortcut → 'claude-sonnet-5-5')
  // for cache lookups. Server resolves these on POST, but for the read-only
  // GET `/analyses-by-flags?model=...` we send the shortcut string verbatim and
  // it'll miss; better to use the resolved ID. For now rely on the server
  // doing exact-match — user sees "not cached" until the analysis runs once.
  const flagModel = resolveModelId(settings.model);
  const flagSearch = settings.searches.length === 0 ? 'none' : [...settings.searches].sort().join(',');
  // One object while the flags read the same, so the stock page is not rebuilt for nothing (`memo` on it).
  const flags = useMemo(() => ({ model: flagModel, search: flagSearch, pplx: settings.pplx }), [flagModel, flagSearch, settings.pplx]);

  const handleSelectSymbol = useCallback((s: string) => {
    // Clicking the stock that is already open closes it again. The row is what
    // opened the analysis, so it is also what puts it away — and in the table
    // nothing is open, so a click there always opens. Deliberately before the
    // run is abandoned: closing does not discard an analysis in flight, it
    // only stops looking at it.
    if (route.view === 'analysis' && selected === s) {
      closeOverlay();
      return;
    }
    // Abandon any in-flight analyze run: invalidate its callbacks and abort the
    // SSE so a late onResult can't yank the user back to the old symbol.
    runIdRef.current++;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    withViewTransition(() => {
      setLoading(false);
      setSelected(s);
      setProgress([]);
    });
  }, [route.view, selected, setSelected, closeOverlay]);

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

  // The stock page's handlers, the same functions from render to render: it is
  // memoised, and a fresh arrow each time would rebuild it with every state
  // change anywhere in the app.
  const onActivityChanged = useCallback(() => { void pollActivity(); }, [pollActivity]);
  const toggleStocks = useCallback(() => setStocksDrawer((v) => !v), []);
  const openAnalysisDialog = useCallback(() => setAnalysisOpen(true), []);
  const openPeers = useCallback(() => setPeersOpen(true), []);
  const startAnalyzeRef = useRef<(input: string, force?: boolean) => void>(() => {});
  const rerunSelected = useCallback(() => { if (selected) startAnalyzeRef.current(selected, true); }, [selected]);

  /**
   * Start an analyze run. `force` bypasses the LLM cache — used by the refresh
   * menu's „Alles" and by the dialog's run button when the combination is
   * already stored. A combination with nothing stored runs without it, since a
   * cache that cannot hit has nothing to bypass.
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
      onResult:   () => {
        if (!isCurrent()) return;
        // Refresh the list so the new score shows — and nothing else. This used
        // to select the resolved symbol, which reopened the analysis: close it
        // while a run is going, and the run's end pulled you back out of the
        // table. Every run starts from the stock already selected, so the
        // select was either a no-op or exactly that.
        void reloadRows();
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
    setStocksDrawer(false);
  }, [handleSelectSymbol]);

  /**
   * What is on screen. There are no tabs any more: the list is the app, and
   * whether a stock or the administration is open on top of it is a fact about
   * state rather than a place you navigate to. An `analysis` route with nothing
   * selected — a deleted symbol, a truncated link — falls back to the list
   * instead of a detail pane with nothing in it.
   */
  const isAdmin      = route.view === 'admin';
  const isEvaluation = route.view === 'evaluation';
  const isFeed       = route.view === 'feed';
  const isJournal    = route.view === 'journal';
  const isDepot      = route.view === 'depot';
  const isReview     = route.view === 'review';
  const isAnalysis   = route.view === 'analysis' && selected !== null;
  const isTable      = !isAdmin && !isEvaluation && !isFeed && !isJournal && !isDepot && !isReview && !isAnalysis;

  // Esc is the keyboard counterpart of the ✕ — for the analysis and the
  // administration alike. Skipped while a field has focus, where Esc means
  // "clear this input" and a search box already handles it natively.
  useEffect(() => {
    if (isTable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A dialog owns Esc while it is open, and closing it must not also
      // close the analysis underneath.
      if (analysisOpen || peersOpen || helpOpen) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      closeOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTable, closeOverlay, analysisOpen, peersOpen, helpOpen]);

  // The stocks in the order the list shows them — under their group
  // headings, without the groups folded shut — for `j` and `k`.
  const listOrder = useMemo(() => {
    const groups = groupRows(visibleRows, listView.group);
    return groups ? groups.filter((g) => !listView.collapsed.includes(g.key)).flatMap((g) => g.rows) : visibleRows;
  }, [visibleRows, listView.group, listView.collapsed]);

  // The rest of the keys (see `SHORTCUTS`). Never while typing, with a
  // modifier held, or under a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      if (analysisOpen || peersOpen || helpOpen) return;
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true); return; }
      if (e.key === '/' && (isTable || isAnalysis)) {
        if (focusSearch()) e.preventDefault();
        return;
      }
      if (!isAnalysis) return;
      if (e.key === 'j' || e.key === 'k') {
        if (listOrder.length === 0) return;
        const at = listOrder.findIndex((r) => r.symbol === selected);
        const next = at === -1 ? 0 : at + (e.key === 'j' ? 1 : -1);
        if (next < 0 || next >= listOrder.length) return;
        e.preventDefault();
        handleSelectSymbol(listOrder[next].symbol);
        return;
      }
      if (e.key === '[') { e.preventDefault(); toggleRail(); return; }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= STOCK_TABS.length) {
        e.preventDefault();
        openTab(STOCK_TABS[n - 1].key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTable, isAnalysis, analysisOpen, peersOpen, helpOpen, listOrder, selected, handleSelectSymbol, toggleRail, openTab]);

  // The left column's highlight: an open stock is still the list.
  const nav: NavKey | null = isTable || isAnalysis ? 'overview'
    : isAdmin ? 'admin' : isEvaluation ? 'evaluation' : isFeed ? 'feed'
    : isJournal ? 'journal' : isDepot ? 'depot' : isReview ? 'review' : null;
  const navTo = (k: NavKey) => {
    if (k === 'overview') { if (!isTable) closeOverlay(); return; }
    ({ admin: openAdmin, evaluation: openEvaluation, feed: openFeed, journal: openJournal, depot: openDepot, review: openReview })[k]();
  };

  startAnalyzeRef.current = startAnalyze;
  return (
    <div className="flex h-full bg-ink-950 text-ink-100">
    <AppNav active={nav} onNavigate={navTo} onHelp={() => setHelpOpen(true)} />
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Backdrop while the mobile drawer is open. Clicking it closes it. */}
      {stocksDrawer && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setStocksDrawer(false)}
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

      {/* The search and the filters, in the same place for the table and an open stock. */}
      {(isTable || isAnalysis) && (
        <AppBar
          view={listView}
          onViewChange={setListView}
          rows={visibleRows}
          total={rows.length}
          nav={nav}
          onNavigate={navTo}
          detail={isAnalysis}
        />
      )}
      {/* The other pages head themselves (see `Page`); below `lg`, where the
          left column is not shown, the way to the rest of the app is this row. */}
      {!isTable && !isAnalysis && (
        <div className="flex shrink-0 justify-end border-b border-ink-800 bg-ink-900 px-3 py-1.5 lg:hidden">
          <NavIcons active={nav} onNavigate={navTo} />
        </div>
      )}

      <Suspense fallback={<div className="flex-1 p-4 text-sm text-ink-500">Lade …</div>}>
        {isAdmin && <AdminPage />}
        {isEvaluation && <EvaluationPage />}
        {isFeed && <FeedPage onSelect={handleSelectSymbol} />}
        {isJournal && <JournalPage symbols={rows.map((r) => r.symbol)} />}
        {isDepot && <DepotPage />}
        {isReview && <ReviewPage />}
      </Suspense>

      {/* The list at full width. Cheap to rebuild, so it mounts and unmounts. */}
      {isTable && (
        <StockTable
          rows={visibleRows}
          total={rows.length}
          loading={rowsLoading}
          view={listView}
          onViewChange={setListView}
          onSelect={handleSelectSymbol}
          activity={activity}
          scrollAnchor={listScrollRef}
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
            ${stocksDrawer ? 'translate-x-0' : '-translate-x-full'}
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
            scrollAnchor={listScrollRef}
            visible={isAnalysis}
            narrow={railNarrow}
            onToggleNarrow={toggleRail}
            onDeleted={(s) => {
              if (selected === s) setSelected(null);
              void reloadRows();
            }}
          />
        </div>

        <main className="flex flex-1 flex-col overflow-hidden">
          <ProgressBanner events={progress} active={loading} />
          {selected && (
            <AnalysisView
              symbol={selected}
              fallbackName={selectedName}
              flags={flags}
              refreshKey={refreshTick}
              // `loading` only covers a run this page is streaming; the queue
              // knows about the ones it is not — after a reload, or in another
              // tab. Either is reason enough to call the buttons busy.
              analyzing={loading
                || (activity[selected] ?? []).some((s) => s === 'analyze' || s === 'symbol-pipeline')}
              activity={activity[selected] ?? NO_STAGES}
              onActivityChanged={onActivityChanged}
              onClose={closeOverlay}
              onToggleStocks={toggleStocks}
              onOpenAnalysis={openAnalysisDialog}
              onOpenPeers={openPeers}
              onRerun={rerunSelected}
              flagsLabel={flagsLabel(settings)}
              row={rows.find((r) => r.symbol === selected) ?? null}
              tab={route.tab ?? 'overview'}
              onTab={openTab}
            />
          )}
        </main>

      </div>

      {/* Which analysis is on show, and what to spend on another one. A
          dialog rather than a column: both are moments, not states. */}
      {analysisOpen && selected && (
        <AnalysisModal
          symbol={selected}
          settings={settings}
          onChange={handleSettingsChange}
          onRun={(force) => startAnalyze(selected, force)}
          loading={loading}
          onClose={() => setAnalysisOpen(false)}
        />
      )}

      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

      {/* Opening a peer switches the analysis to it; adding one only grows
          the list behind the dialog, so several can be added in a row. */}
      {peersOpen && selected && (
        <PeersModal
          symbol={selected}
          onClose={() => setPeersOpen(false)}
          onOpen={(s) => {
            setPeersOpen(false);
            handleSelectSymbol(s);
          }}
          onAdded={() => { void reloadRows(); }}
        />
      )}

      {/* One add field for the whole window, below whichever density is up —
          the table used to have no way to add a stock at all. */}
      {!isAdmin && !isEvaluation && !isJournal && !isDepot && !isReview && (
        <AnalyzeForm
          onAdd={addStock}
          analyzing={loading}
          hint={isAnalysis
            ? 'holt nur die Daten — Analyse startest du auf der Verdict-Karte'
            : 'holt nur die Daten — Analyse startest du nach dem Klick auf die Aktie'}
        />
      )}
    </div>
    </div>
  );
}
