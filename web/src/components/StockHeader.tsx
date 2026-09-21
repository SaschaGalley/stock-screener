import { useEffect, useRef, useState } from "react";
import type { StockSummary } from "../types";
import { fmt, relativeTime } from "../format";
import { useMoney } from "../currency";
import { api } from "../api"; // refresh endpoint (PDF/MD endpoints unused since report generation is skipped)
import StockLogo, { initialsFromName } from "./StockLogo";
import { CloseIcon, GearIcon } from "./icons";

interface Props {
  summary: StockSummary;
  financials: any;
  onRefreshed?: () => void;
  /** Stages the queue has in flight for this symbol, from GET /api/activity. */
  activity?: string[];
  /** Re-read the queue now, rather than waiting for the next poll. */
  onActivityChanged?: () => void;
  /** Close the analysis and spread the list back out to the full table. */
  onClose: () => void;
  onOpenAdmin: () => void;
  /** Below `lg` the stock list is a drawer; this opens it. */
  onToggleStocks: () => void;
  /**
   * What is out of date, in a sentence, or null when nothing is. It used to be
   * a banner across the page with its own buttons; now it is a mark on the one
   * button that fixes it, and this is what that mark's tooltip says.
   */
  staleNote: string | null;
  /** Which menu entry clears `staleNote` — marked in the menu, so it is found. */
  staleFix: 'data' | 'everything' | null;
  /** Re-run the analysis with the combination on show, bypassing the cache. */
  onRerun: () => void;
  /** Open the dialog: a different model, search or Perplexity, or a stored one. */
  onOpenAnalysis: () => void;
  /** The combination on show, so "everything" says what it will spend. */
  flagsLabel: string;
  /** An analysis this page is streaming, or one the queue knows about. */
  analyzing: boolean;
}

export default function StockHeader({
  summary,
  financials: f,
  onRefreshed,
  activity = [],
  onActivityChanged,
  onClose,
  onOpenAdmin,
  onToggleStocks,
  staleNote,
  staleFix,
  onRerun,
  onOpenAnalysis,
  flagsLabel,
  analyzing,
}: Props) {
  const { fmtPrice, fmtBig } = useMoney();
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Busy according to the server as well as to this component.
   *
   * The local flag only knows about a refresh this page started, and it dies
   * with the page. The work does not: it runs in a worker, so after a reload —
   * or in a second tab — the button would otherwise look ready while the
   * refresh it triggered is still going, and clicking again would queue a
   * second one.
   */
  // Any stage counts, not just the two this button starts. An analysis reads
  // the data a refresh would replace underneath it, the nightly pipeline
  // refreshes the same symbol as its first step, and the "Refresh data" button
  // in the stale banner already greys out for a running analysis — one rule
  // for the symbol is easier to trust than two that disagree on the same page.
  const busy = refreshing || activity.length > 0;

  async function refreshData(): Promise<boolean> {
    if (busy) return false;
    setRefreshing(true);
    // Shortly after, not now: the task does not exist until the request reaches
    // the server, so asking in the same tick reliably finds nothing. Half a
    // second later it is queued, and every other view learns the symbol is busy
    // without waiting for the next poll.
    const announce = setTimeout(() => onActivityChanged?.(), 500);
    try {
      // Fire both refreshes in parallel — data refresh is cheap (~seconds),
      // Distill can be slow (up to 5 min on first-touch tickers) but the user
      // explicitly asked to avoid scrolling down to the dedicated button.
      // allSettled so a Distill outage / config issue doesn't mask the
      // successful data refresh.
      const [dataR, distillR] = await Promise.allSettled([
        api.refreshData(summary.symbol),
        api.refreshDistill(summary.symbol),
      ]);
      if (dataR.status === 'rejected') throw dataR.reason;
      if (distillR.status === 'rejected') {
        // Persistent Distill config errors (read-only / unauthorized /
        // ambiguous-type / not configured) are surfaced by the dedicated
        // Distill section's own UI — no point alerting twice. Log for
        // diagnosis only.
        // eslint-disable-next-line no-console
        console.warn('Distill refresh skipped:', (distillR.reason as Error)?.message);
      }
      onRefreshed?.();
      return true;
    } catch (e) {
      alert(`Refresh failed: ${(e as Error).message}`);
      return false;
    } finally {
      clearTimeout(announce);
      setRefreshing(false);
      onActivityChanged?.();
    }
  }

  /**
   * Data first, then the analysis — the order the nightly pipeline runs in.
   *
   * Not just the analysis on its own: a run reads the stored financials and
   * only fetches new ones when they have expired, so "re-run" alone can score
   * a company on numbers that are hours old. Awaiting the refresh is what makes
   * "everything" mean everything.
   */
  async function refreshEverything() {
    if (await refreshData()) onRerun();
  }
  return (
    <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-4 py-3 sm:px-6 sm:py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            onClick={onToggleStocks}
            className="-ml-1 shrink-0 rounded p-1.5 text-lg leading-none text-ink-300 hover:bg-ink-800 lg:hidden"
            aria-label="Aktienliste ein-/ausblenden"
          >☰</button>
          <StockLogo
            domain={summary.logoDomain}
            symbol={summary.symbol}
            fallbackInitials={initialsFromName(summary.companyName)}
            size={40}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="truncate text-lg font-bold text-ink-50 sm:text-xl">
                {summary.companyName}
              </h1>
              <span className="shrink-0 rounded bg-ink-800 px-2 py-0.5 font-mono text-xs text-ink-300">
                {summary.symbol}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-400">
              {summary.sector && <span className="truncate">{summary.sector}</span>}
              {summary.industry && summary.industry !== summary.sector && (
                <span className="hidden truncate sm:inline">· {summary.industry}</span>
              )}
              {f.headquarters && <span className="hidden truncate md:inline">· {f.headquarters}</span>}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <RefreshMenu
            busy={busy}
            analyzing={analyzing}
            staleNote={staleNote}
            staleFix={staleFix}
            flagsLabel={flagsLabel}
            onData={() => { void refreshData(); }}
            onEverything={() => { void refreshEverything(); }}
            onOther={onOpenAnalysis}
          />

          {/* Hidden on a phone, where four controls squeeze the company name
              down to a stub. Administration is a rare destination and the
              table's own header still has it. */}
          <button
            onClick={onOpenAdmin}
            className="hidden rounded p-1.5 text-ink-400 transition hover:bg-ink-800 hover:text-ink-200 sm:block"
            title="Administration — Cronjobs, Watchlist, Modelle"
          >
            <GearIcon />
          </button>

          {/* The way back to the table. Bordered and a heavier stroke than the
              icons beside it: leaving is the one action on this header someone
              needs to find without looking for it. */}
          <button
            onClick={onClose}
            className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
            title="Zurück zur Übersicht (Esc)"
            aria-label="Analyse schließen"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KV label="Price" value={fmtPrice(f.price)} bigValue />
        <KV label="Market Cap" value={fmtBig(f.marketCap)} />
        <KV label="Enterprise Value" value={fmtBig(f.enterpriseValue)} />
        <KV
          label="52W Range"
          value={`${fmtPrice(f.fiftyTwoWeekLow)} – ${fmtPrice(f.fiftyTwoWeekHigh)}`}
        />
        <KV
          label="Beta"
          value={fmt(f.beta)}
          subtle={
            summary.cachedAt ? `cached ${relativeTime(summary.cachedAt)}` : ""
          }
        />
      </div>
    </header>
  );
}

function KV({
  label,
  value,
  bigValue,
  subtle,
}: {
  label: string;
  value: string;
  bigValue?: boolean;
  subtle?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-500">
        {label}
      </div>
      <div
        className={`font-mono tabular ${bigValue ? "text-lg font-bold text-ink-50" : "text-sm text-ink-100"}`}
      >
        {value}
      </div>
      {subtle && <div className="text-[10px] text-ink-600">{subtle}</div>}
    </div>
  );
}

/**
 * Refresh, as a choice rather than one fixed action.
 *
 * There are three different things someone pressing „Refresh" can mean, and
 * they cost different amounts: new numbers (free), new numbers and a new
 * verdict on them (one LLM call), or a verdict from a different model. They
 * used to be spread over this button, a yellow banner that appeared only after
 * the first refresh, and a sidebar — so a full run took three places and the
 * right order. Now it is one menu, and what is out of date is a mark on it.
 */
function RefreshMenu({
  busy, analyzing, staleNote, staleFix, flagsLabel, onData, onEverything, onOther,
}: {
  busy: boolean;
  analyzing: boolean;
  staleNote: string | null;
  staleFix: 'data' | 'everything' | null;
  flagsLabel: string;
  onData: () => void;
  onEverything: () => void;
  onOther: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside click and Esc close the menu. Esc listens in the capture phase and
  // marks the event handled, so the app's own Esc — which closes the whole
  // analysis — sees it as taken and stands down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={staleNote ?? 'Daten und Analyse aktualisieren'}
        className="relative flex items-center gap-1 rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? '⟳' : '↻'}
        <span className="hidden sm:inline">{busy ? 'Aktualisiere…' : 'Refresh'}</span>
        <span aria-hidden className="text-[10px] text-ink-500">▾</span>
        {staleNote && !busy && (
          <span
            aria-label="veraltet"
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold leading-none text-ink-950"
          >
            !
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
        >
          {staleNote && (
            <p className="border-b border-ink-800 bg-amber-950 px-3 py-2 text-[11px] leading-snug text-amber-300">
              {staleNote}
            </p>
          )}
          <MenuItem
            title="Nur Daten"
            detail="Kurse, Fundamentaldaten, Technicals, Distill — kein LLM-Aufruf"
            flagged={staleFix === 'data'}
            onClick={pick(onData)}
          />
          <MenuItem
            title="Alles"
            detail={<>Daten, danach die Analyse neu mit <span className="font-mono text-ink-300">{flagsLabel}</span></>}
            flagged={staleFix === 'everything'}
            disabled={analyzing}
            onClick={pick(onEverything)}
          />
          <MenuItem
            title="Andere Einstellungen…"
            detail="Modell, Websuche oder Perplexity wählen — oder eine gespeicherte Fassung"
            disabled={analyzing}
            onClick={pick(onOther)}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ title, detail, flagged = false, disabled = false, onClick }: {
  title: string;
  detail: React.ReactNode;
  /** The entry that clears what the `!` is about. */
  flagged?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="block w-full border-b border-ink-800 px-3 py-2 text-left transition last:border-b-0 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-100">
        {title}
        {flagged && (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-ink-950">!</span>
        )}
      </span>
      <span className="mt-0.5 block text-[10px] leading-snug text-ink-500">{detail}</span>
    </button>
  );
}
