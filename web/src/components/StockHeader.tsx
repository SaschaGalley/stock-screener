import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ComputedMetrics, StockSummary } from "../types";
import { deNumber, fmtPct, relativeTime } from "../format";
import { useMoney } from "../currency";
import { api } from "../api"; // refresh endpoint (PDF/MD endpoints unused since report generation is skipped)
import StockLogo, { initialsFromName } from "./StockLogo";
import { CloseIcon, PeersIcon } from "./icons";
import Term from "./Term";
import Tip from "./Tip";
import type { GlossaryKey } from "../glossary";

interface Props {
  summary: StockSummary;
  financials: any;
  /** For the P/E and the government yield the dividend is read against. */
  metrics: ComputedMetrics;
  /** The peers' median P/E, beside the stock's own on hover. */
  peerPe?: number | null;
  onRefreshed?: () => void;
  /** Stages the queue has in flight for this symbol, from GET /api/activity. */
  activity?: string[];
  /** Re-read the queue now, rather than waiting for the next poll. */
  onActivityChanged?: () => void;
  /** Close the analysis and spread the list back out to the full table. */
  onClose: () => void;
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
  /** Open the peer dialog: who else is in this business, and adding them to the list. */
  onOpenPeers: () => void;
  /** The combination on show, so "everything" says what it will spend. */
  flagsLabel: string;
  /** An analysis this page is streaming, or one the queue knows about. */
  analyzing: boolean;
  /** The last session's move, from the stored technicals; null when there are none. */
  dayChange?: number | null;
}

export default function StockHeader({
  summary,
  financials: f,
  metrics: m,
  peerPe = null,
  onRefreshed,
  activity = [],
  onActivityChanged,
  onClose,
  onToggleStocks,
  staleNote,
  staleFix,
  onRerun,
  onOpenAnalysis,
  onOpenPeers,
  flagsLabel,
  analyzing,
  dayChange = null,
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
      alert(`Aktualisieren fehlgeschlagen: ${(e as Error).message}`);
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
              {/* The size of the company, said once in passing: it places the
                  firm, but it is not a figure anybody weighs a purchase on. */}
              {typeof f.marketCap === 'number' && f.marketCap > 0 && (
                <span className="whitespace-nowrap">· <Term k="financials.marketCap">Börsenwert</Term> {fmtBig(f.marketCap)}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Tip focusable={false} content="Peers und Konkurrenten — vergleichen und zur Liste hinzufügen">
            <button
              onClick={onOpenPeers}
              className="flex items-center gap-1 rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700"
              aria-label="Peers und Konkurrenten"
            >
              <PeersIcon size={14} />
              <span className="hidden sm:inline">Peers</span>
            </button>
          </Tip>

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

          {/* The way back to the table. Bordered and a heavier stroke than the
              icons beside it: leaving is the one action on this header someone
              needs to find without looking for it. */}
          <Tip focusable={false} content="Zurück zur Übersicht (Esc)">
            <button
              onClick={onClose}
              className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
              aria-label="Analyse schließen"
            >
              <CloseIcon />
            </button>
          </Tip>
        </div>
      </div>

      {/* One row that swipes on a phone — the figures took three rows there,
          and a third of the screen before the page began. Wider, they wrap as
          they fit: a grid of five fixed columns ran the figures into each
          other beside the open stock list, where the pane is narrower than
          the window says. */}
      <div className="mt-3 flex gap-x-6 overflow-x-auto [scrollbar-width:none] sm:mt-4 sm:flex-wrap sm:gap-x-8 sm:gap-y-3 sm:overflow-visible">
        <KV
          label="Kurs" term="financials.price" value={fmtPrice(f.price)} bigValue
          subtle={summary.cachedAt ? `Daten ${relativeTime(summary.cachedAt)}` : ''}
          extra={typeof dayChange === 'number' && Number.isFinite(dayChange) && (
            <Tip focusable={false} content="Veränderung zum vorigen Schlusskurs">
              <span className={`ml-2 text-xs font-semibold ${dayChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {dayChange >= 0 ? '+' : '−'}{Math.abs(dayChange * 100).toFixed(1).replace('.', ',')} %
              </span>
            </Tip>
          )}
        />
        {/* Before the range, which is the widest: on a phone what is left of
            the first screen after the price goes to the two figures a
            purchase is weighed on. */}
        <KV label="KGV" term="metrics.ratios.pe" {...peFigure(f, m, peerPe)} />
        <KV label="Dividende" term="metrics.ratios.dividendYield" {...dividendFigure(f, m, fmtPrice)} />
        <KV
          label="52 Wochen"
          term="concept.range52w"
          value={`${fmtPrice(f.fiftyTwoWeekLow)} – ${fmtPrice(f.fiftyTwoWeekHigh)}`}
          below={<RangePosition low={f.fiftyTwoWeekLow} high={f.fiftyTwoWeekHigh} price={f.price} />}
        />
      </div>
    </header>
  );
}

interface Figure {
  value: string;
  /** Under the value, in small type: what it is read against. */
  subtle?: string;
  /** The small line is a warning, not context. */
  warn?: boolean;
  /** On hover over the value: this stock's details behind the figure. */
  hint?: ReactNode;
}

function KV({
  label,
  term,
  value,
  bigValue,
  subtle,
  warn,
  hint,
  extra,
  below,
}: Figure & {
  label: string;
  term?: GlossaryKey;
  bigValue?: boolean;
  /** Beside the value, on its line — the day's move beside the price. */
  extra?: ReactNode;
  /** Under the value — the price's place in its 52-week range. */
  below?: ReactNode;
}) {
  const shown = hint ? <Tip focusable={false} content={hint}>{value}</Tip> : value;
  return (
    <div className="shrink-0">
      <div className="whitespace-nowrap text-2xs uppercase tracking-wider text-ink-500">
        <Term k={term}>{label}</Term>
      </div>
      <div
        className={`flex items-baseline whitespace-nowrap font-mono tabular ${bigValue ? "text-lg font-bold text-ink-50" : "text-sm text-ink-100"}`}
      >
        {shown}{extra}
      </div>
      {below}
      {subtle && <div className={`whitespace-nowrap text-2xs ${warn ? 'text-amber-400' : 'text-ink-500'}`}>{subtle}</div>}
    </div>
  );
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The P/E on the trailing year, the forward one under it, and on hover what
 * makes either readable: the stock's own recent average and its peers'.
 */
function peFigure(f: any, m: ComputedMetrics, peerPe: number | null): Figure {
  const pe = finite(m.ratios.pe);
  const forward = finite(m.ratios.forwardPE);
  const avg = finite(f.avgPE5Y);
  const peer = finite(peerPe);
  const loss = (finite(f.netIncome) ?? 0) < 0;
  const hint = [
    avg !== null && avg > 0 ? `Ø der letzten Geschäftsjahre ${deNumber(avg, 1)}` : null,
    peer !== null && peer > 0 ? `Median der Peers ${deNumber(peer, 1)}` : null,
  ].filter(Boolean).join(' · ');
  return {
    value: pe !== null && pe > 0 ? deNumber(pe, 1) : loss ? 'Verlust' : '—',
    subtle: forward !== null && forward > 0 ? `erwartet ${deNumber(forward, 1)}` : undefined,
    hint: hint || undefined,
  };
}

/**
 * The trailing yield, read against what the same money earns without risk:
 * the ten-year government bond of the currency the stock trades in. Unless the
 * dividend is paid out of more than the year earned — then that is what the
 * small line says, because it is the first thing to know about such a yield.
 */
function dividendFigure(f: any, m: ComputedMetrics, fmtPrice: (n: number | null | undefined) => string): Figure {
  const dy = finite(f.dividendYield);
  if (dy === null || dy <= 0) return { value: 'keine', hint: 'Keine Dividende in den letzten zwölf Monaten.' };
  const rf = finite(m.dcf.riskFreeRate);
  const payout = finite(f.payoutRatio);
  const growth = finite(f.dividendGrowthRate5Y);
  const price = finite(f.price);
  const exDay = typeof f.exDividendDate === 'string' && f.exDividendDate >= new Date().toISOString().slice(0, 10)
    ? f.exDividendDate : null;
  const uncovered = payout !== null && payout > 1;
  const hint = (
    <span className="block space-y-0.5">
      {price !== null && <span className="block">{fmtPrice(dy * price)} je Aktie im Jahr</span>}
      {payout !== null && <span className="block">Ausgeschüttet: {fmtPct(payout, 0)} des Gewinns</span>}
      {growth !== null && <span className="block">In fünf Jahren um {fmtPct(growth)} im Jahr gewachsen</span>}
      {exDay && <span className="block">Nächster Ex-Tag {new Date(`${exDay}T12:00:00Z`).toLocaleDateString('de-DE')}</span>}
      {rf !== null && (
        <span className="block text-ink-400">
          Zehnjährige Staatsanleihe in {f.tradingCurrency ?? 'der Handelswährung'}: {fmtPct(rf)}, sicher bis zur Fälligkeit.
          Die Dividende kann gekürzt werden, und der Kurs schwankt.
        </span>
      )}
    </span>
  );
  return {
    value: fmtPct(dy),
    subtle: uncovered ? `${fmtPct(payout, 0)} vom Gewinn` : rf !== null ? `Anleihe ${fmtPct(rf)}` : undefined,
    warn: uncovered,
    hint,
  };
}

/** Where the price stands between the year's low and high, as a tick on a line. */
function RangePosition({ low, high, price }: { low: number | null; high: number | null; price: number | null }) {
  if (low == null || high == null || price == null || !(high > low)) return null;
  const at = Math.min(1, Math.max(0, (price - low) / (high - low)));
  return (
    <Tip focusable={false} className="block w-28" content={`${Math.round(at * 100)} % der Spanne`}>
      <span className="relative mt-1 block h-1.5 w-28 rounded-full bg-ink-800">
        <span className="absolute -top-0.5 h-2.5 w-0.5 rounded bg-ink-100" style={{ left: `calc(${at * 100}% - 1px)` }} />
      </span>
    </Tip>
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
      <Tip focusable={false} content={staleNote ?? 'Daten und Analyse aktualisieren'}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex items-center gap-1 rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? '⟳' : '↻'}
        <span className="hidden sm:inline">{busy ? 'Aktualisiere…' : 'Aktualisieren'}</span>
        <span aria-hidden className="text-2xs text-ink-500">▾</span>
        {staleNote && !busy && (
          <span
            aria-label="veraltet"
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-2xs font-bold leading-none text-ink-950"
          >
            !
          </span>
        )}
      </button>
      </Tip>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl"
        >
          {staleNote && (
            <p className="border-b border-ink-800 bg-amber-950 px-3 py-2 text-xs leading-snug text-amber-300">
              {staleNote}
            </p>
          )}
          <MenuItem
            title="Nur Daten"
            detail="Kurse, Fundamentaldaten, Charttechnik, Distill — kein LLM-Aufruf"
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
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-3xs font-bold text-ink-950">!</span>
        )}
      </span>
      <span className="mt-0.5 block text-2xs leading-snug text-ink-500">{detail}</span>
    </button>
  );
}
