import { useState } from "react";
import type { StockSummary } from "../types";
import { fmtBig, fmtPrice, fmt, relativeTime } from "../format";
import { api } from "../api"; // refresh endpoint (PDF/MD endpoints unused since report generation is skipped)
import StockLogo, { initialsFromName } from "./StockLogo";

interface Props {
  summary: StockSummary;
  financials: any;
  onRefreshed?: () => void;
}

export default function StockHeader({
  summary,
  financials: f,
  onRefreshed,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await api.refreshData(summary.symbol);
      onRefreshed?.();
    } catch (e) {
      alert(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
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
            disabled={refreshing}
            className="rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
            title="Refresh raw data (Yahoo, Finnhub, FRED, technicals) — does not call LLM or Perplexity"
          >
            {refreshing ? "⟳" : "↻"}<span className="ml-1 hidden sm:inline">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
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
