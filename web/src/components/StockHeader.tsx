import { useState } from "react";
import type { StockSummary } from "../types";
import { fmt, relativeTime } from "../format";
import { useMoney } from "../currency";
import { api } from "../api"; // refresh endpoint (PDF/MD endpoints unused since report generation is skipped)
import StockLogo, { initialsFromName } from "./StockLogo";

interface Props {
  summary: StockSummary;
  financials: any;
  onRefreshed?: () => void;
  /** Stages the queue has in flight for this symbol, from GET /api/activity. */
  activity?: string[];
  /** Re-read the queue now, rather than waiting for the next poll. */
  onActivityChanged?: () => void;
}

export default function StockHeader({
  summary,
  financials: f,
  onRefreshed,
  activity = [],
  onActivityChanged,
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

  async function handleRefresh() {
    if (busy) return;
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
    } catch (e) {
      alert(`Refresh failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(announce);
      setRefreshing(false);
      onActivityChanged?.();
    }
  }
  return (
    <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-4 py-3 sm:px-6 sm:py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
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
          <button
            onClick={handleRefresh}
            disabled={busy}
            className="rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Refresh raw data (Yahoo, Finnhub, FRED, technicals) AND Distill briefing — does not call LLM or Perplexity. Distill drain can take up to ~5 min on first-touch tickers."
          >
            {busy ? '⟳' : '↻'}
            <span className="ml-1 hidden sm:inline">{busy ? 'Refreshing…' : 'Refresh'}</span>
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
