import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  StockBundle,
  StockSummary,
  AnalysisFlagsKey,
  CachedAnalysisEntry,
} from "../types";
import VerdictHero from "./VerdictHero";
import BullBearRisks from "./BullBearRisks";
import StockHeader from "./StockHeader";
import Section from "./Section";
import CompositeChart from "./charts/CompositeChart";
import ValuationDetail from "./sections/ValuationDetail";
import QualityScores from "./sections/QualityScores";
import FundamentalsGrid from "./sections/FundamentalsGrid";
import PeerCompare from "./sections/PeerCompare";
import TechnicalSignalsPanel from "./sections/TechnicalSignalsPanel";
import PriceAction from "./sections/PriceAction";
import MarketContext from "./sections/MarketContext";
import OwnershipFlow from "./sections/OwnershipFlow";
import EarningsBlock from "./sections/EarningsBlock";
import NewsAndResearch from "./sections/NewsAndResearch";
import CompanyInfo from "./sections/CompanyInfo";
import FundamentalsHistoryChart from "./charts/FundamentalsHistoryChart";

interface Props {
  symbol: string;
  summary: StockSummary | undefined;
  flags: AnalysisFlagsKey;
  refreshKey: number;
  /** Trigger the analyze flow for the current symbol & flag combo. */
  onRunAnalysis: () => void;
  /** True while an analyze run is in flight (parent owns the SSE stream). */
  analyzing: boolean;
}

export default function AnalysisView({
  symbol,
  summary,
  flags,
  refreshKey,
  onRunAnalysis,
  analyzing,
}: Props) {
  const [bundle, setBundle] = useState<StockBundle | null>(null);
  const [analysis, setAnalysis] = useState<CachedAnalysisEntry | null>(null);
  // bundleLoading only flips on symbol change; flag-toggling never triggers a full reload.
  const [bundleLoading, setBundleLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  // Clear stale cross-ticker state immediately when the symbol changes so we
  // don't flash the previous ticker's header/verdict while the new bundle
  // loads. Refresh-triggered reloads (refreshKey/localRefresh) keep the
  // current bundle visible until the new one arrives — smoother UX for the
  // same-ticker case.
  useEffect(() => {
    setBundle(null);
    setAnalysis(null);
  }, [symbol]);

  // Stock bundle (financials, market signals, computed metrics, news) depends
  // only on the symbol — not on which LLM flags are selected. Cancellation
  // flag prevents a stale response from clobbering a newer symbol's state
  // when the user rapid-fires across the sidebar.
  useEffect(() => {
    let cancelled = false;
    setBundleLoading(true);
    setError(null);
    api
      .getStock(symbol)
      .then((b) => { if (!cancelled) setBundle(b); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setBundleLoading(false); });
    return () => { cancelled = true; };
  }, [symbol, refreshKey, localRefresh]);

  // Cached LLM analysis depends on the flag combination. Cheap cache lookup —
  // no loading state, just swap the result silently when the user toggles flags.
  useEffect(() => {
    let cancelled = false;
    api
      .getAnalysisByFlags(symbol, flags)
      .then((a) => {
        if (!cancelled) setAnalysis(a);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, flags.model, flags.search, flags.pplx, refreshKey]);

  if (bundleLoading && !bundle) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-500">
        Loading {symbol}…
      </div>
    );
  }

  // Error state — render a minimal header with a Refresh button so the user
  // can recover (e.g., after a cache schema bump invalidated the data).
  if (error || !bundle) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-ink-700 bg-ink-900 px-6 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink-50">
              {summary?.companyName ?? symbol}
            </h1>
            <span className="font-mono text-xs text-ink-400">{symbol}</span>
          </div>
          <RefreshOnlyButton
            symbol={symbol}
            onRefreshed={() => setLocalRefresh((x) => x + 1)}
          />
        </header>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <p className="mb-2 text-sm text-amber-400">{error || "No data"}</p>
            <p className="text-xs text-ink-500">
              Click <span className="font-mono">↻ Refresh</span> above to
              re-fetch from Yahoo &amp; Finnhub.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const f = bundle.financials;
  const m = bundle.metrics;
  const llm = analysis?.llmAnalysis ?? null;
  const cs  = bundle.cacheStatus;
  const dataStale = cs && (cs.financials === 'stale' || cs.marketSignals === 'stale');

  // Per-selected-combo staleness — analyses don't have a clock-based TTL, only
  // a hash-based identity. The single staleness signal is "older than data":
  // the cached LLM call ran against an earlier financials snapshot.
  const analysisGenAt = analysis?.generatedAt ? new Date(analysis.generatedAt).getTime() : null;
  const dataCachedAt  = bundle.summary?.cachedAt ? new Date(bundle.summary.cachedAt).getTime() : null;
  const analysisOlderThanData = analysisGenAt !== null && dataCachedAt !== null
    && analysisGenAt < dataCachedAt - 60_000;
  const analysisStale = analysisOlderThanData;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <StockHeader
        summary={bundle.summary ?? summary!}
        financials={f}
        onRefreshed={() => setLocalRefresh((x) => x + 1)}
      />

      {(dataStale || analysisStale) && (
        <StaleBanner
          symbol={symbol}
          dataStale={!!dataStale}
          analysisOlderThanData={!!analysisOlderThanData}
          onRefreshed={() => setLocalRefresh((x) => x + 1)}
          onRunAnalysis={onRunAnalysis}
          analyzing={analyzing}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-6 sm:py-5">
          {/* TIER 0: Company info — restored after refactor */}
          {(f.description ||
            f.employees ||
            f.website ||
            f.isin ||
            f.industry) && (
            <Section title="About the Company" defaultOpen={false}>
              <CompanyInfo financials={f} />
            </Section>
          )}

          {/* TIER 1: AT-A-GLANCE VERDICT */}
          <VerdictHero
            price={f.price}
            composite={m.composite}
            llm={llm}
            analyst={{
              targetMeanPrice: f.targetMeanPrice,
              analystTargetLow: f.analystTargetLow,
              analystTargetHigh: f.analystTargetHigh,
              analystTargetMedian: f.analystTargetMedian,
              analystCount: f.analystCount,
              analystStrongBuy: f.analystStrongBuy,
              analystBuy: f.analystBuy,
              analystHold: f.analystHold,
              analystSell: f.analystSell,
              analystStrongSell: f.analystStrongSell,
            }}
          />

          {/* TIER 2: BULL/BEAR/RISKS */}
          {llm && <BullBearRisks llm={llm} />}

          {/* TIER 3: COMPOSITE BAR CHART (Primary + Conservative tiers) */}
          {(m.composite.primary.models.length > 0 ||
            m.composite.conservative.models.length > 0) && (
            <Section
              title="Fair Value Distribution"
              subtitle={`Primary $${m.composite.primary.median?.toFixed(0) ?? "—"} · Conservative $${m.composite.conservative.median?.toFixed(0) ?? "—"}`}
            >
              <div className="mb-2 text-[11px] text-ink-500">
                <span className="mr-3">
                  <span className="inline-block h-2 w-3 rounded-sm bg-emerald-500 align-middle"></span>{" "}
                  Primary (filled) · market-aligned
                </span>
                <span>
                  <span className="inline-block h-2 w-3 rounded-sm border border-emerald-500 align-middle"></span>{" "}
                  Conservative (outlined) · value lens
                </span>
              </div>
              <div
                style={{
                  height: Math.max(
                    180,
                    (m.composite.primary.models.length +
                      m.composite.conservative.models.length) *
                      28 +
                      80,
                  ),
                }}
              >
                <CompositeChart composite={m.composite} price={f.price} />
              </div>
            </Section>
          )}

          {/* TIER 4: VALUATION DETAILS */}
          <Section
            title="Valuation Models"
            subtitle="DCF, peer multiples, reverse DCF"
          >
            <ValuationDetail metrics={m} price={f.price} />
          </Section>

          {/* TIER 5: QUALITY & RISK */}
          <Section title="Quality & Risk Scores">
            <QualityScores metrics={m} />
          </Section>

          {/* TIER 6: EARNINGS (history + forward) */}
          {(f.earningsSurprises?.length > 0 ||
            f.earningsEstimates?.length > 0) && (
            <Section title="Earnings">
              <EarningsBlock financials={f} />
            </Section>
          )}

          {/* TIER 8: FUNDAMENTALS */}
          <Section title="Fundamentals" defaultOpen={false}>
            <FundamentalsGrid
              financials={f}
              ratios={m.ratios}
              evMultiples={m.evMultiples}
            />
          </Section>

          {/* TIER 6b: 5y Fundamentals History (overlay charts) */}
          {f.fundamentalsHistory &&
            (f.fundamentalsHistory.revenue?.length > 0 ||
              f.fundamentalsHistory.netIncome?.length > 0 ||
              f.fundamentalsHistory.eps?.length > 0) && (
              <Section
                title="Fundamentals History"
                subtitle="last ~5 fiscal years"
              >
                <FundamentalsHistoryChart history={f.fundamentalsHistory} />
              </Section>
            )}

          {/* TIER 7: PEER COMPARISON */}
          {bundle.sectorMedians && (
            <Section title="Peer Group Comparison">
              <PeerCompare
                ratios={m.ratios}
                evMultiples={m.evMultiples}
                financials={f}
                sectorMedians={bundle.sectorMedians}
              />
            </Section>
          )}

          {/* TIER 8b: TECHNICAL SIGNALS GAUGE (TradingView-style) */}
          {bundle.technicalSignals && (
            <Section
              title="Technical Signals"
              subtitle={`Overall: ${bundle.technicalSignals.overall.verdict.toLowerCase()}`}
            >
              <TechnicalSignalsPanel signals={bundle.technicalSignals} />
            </Section>
          )}

          {/* TIER 9a: PRICE ACTION — what HAS the stock done (returns, vol, RS) */}
          {bundle.marketSignals && (
            <Section
              title="Price Action"
              subtitle="returns, volatility, position, relative strength"
              defaultOpen={false}
            >
              <PriceAction marketSignals={bundle.marketSignals} />
            </Section>
          )}

          {/* TIER 9b: MARKET CONTEXT — what's around the stock (options, revisions, macro) */}
          {bundle.marketSignals && (
            <Section
              title="Market Context"
              subtitle="options, analyst revisions, macro"
              defaultOpen={false}
            >
              <MarketContext marketSignals={bundle.marketSignals} />
            </Section>
          )}

          {/* TIER 10: OWNERSHIP & FLOW */}
          <Section title="Ownership & Insider Activity" defaultOpen={false}>
            <OwnershipFlow financials={f} />
          </Section>

          {/* TIER 11: DISTILL + PERPLEXITY + NEWS + SEARCH TRACES */}
          <Section title="Research & News" defaultOpen={false}>
            <NewsAndResearch
              symbol={symbol}
              news={bundle.news}
              perplexity={bundle.perplexity}
              distill={bundle.distill}
              searches={analysis?.searches ?? null}
              onDistillRefreshed={() => setLocalRefresh((x) => x + 1)}
            />
          </Section>

          {!llm && (
            <div className="rounded-lg border border-amber-700 bg-amber-950 p-4 text-center text-sm text-amber-200">
              No LLM analysis cached for the current settings. Open the right
              sidebar and click <strong>Run Analysis</strong> to generate one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Standalone Refresh button used in the error fallback header. */
function RefreshOnlyButton({
  symbol,
  onRefreshed,
}: {
  symbol: string;
  onRefreshed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function handle() {
    if (busy) return;
    setBusy(true);
    try {
      await api.refreshData(symbol);
      onRefreshed();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={handle}
      disabled={busy}
      className="rounded border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-200 transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? "⟳ Refreshing…" : "↻ Refresh"}
    </button>
  );
}

/**
 * Top-of-view warning banner shown when cached data is from an older schema
 * or when the most recent LLM analysis predates the latest data refresh.
 * Stays out of the way of the main content but keeps a refresh action handy.
 */
function StaleBanner({
  symbol,
  dataStale,
  analysisOlderThanData,
  onRefreshed,
  onRunAnalysis,
  analyzing,
}: {
  symbol: string;
  dataStale: boolean;
  analysisOlderThanData: boolean;
  onRefreshed: () => void;
  onRunAnalysis: () => void;
  analyzing: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const analysisStale = analysisOlderThanData;
  async function handleRefreshData() {
    if (busy) return;
    setBusy(true);
    try {
      await api.refreshData(symbol);
      onRefreshed();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Pick the most informative single-sentence message.
  let message = '';
  if (dataStale && analysisStale) {
    message = 'Cached data and the LLM analysis are outdated.';
  } else if (dataStale) {
    message = 'Cached financials/market data are from an older schema.';
  } else if (analysisOlderThanData) {
    message = 'This cached AI analysis was generated before the latest data refresh.';
  }
  // Action explanation — Refresh data alone CAN'T clear an analysisStale state
  // (refreshing data only bumps financials.mtime forward, making the stale
  // analysis even more clearly older-than-data). To actually clear the warning
  // the LLM analysis itself must be re-run.
  const action = analysisStale
    ? 'Re-run the analysis to update the LLM verdict and clear this warning.'
    : 'Refresh to re-fetch from Yahoo & Finnhub.';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-700 bg-amber-950 px-4 py-2 text-xs text-amber-300">
      <div className="min-w-0">
        <span className="mr-1">⚠</span>
        {message}
        <span className="ml-1 text-amber-400/80">{action}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Data-only refresh button. Always available so the user can pull
            fresh financials without spending an LLM call. */}
        <button
          onClick={handleRefreshData}
          disabled={busy || analyzing}
          className="rounded border border-amber-700 bg-amber-900 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
          title="Re-fetch financials/market data from Yahoo & Finnhub. Does not call the LLM."
        >
          {busy ? "⟳ Refreshing…" : "↻ Refresh data"}
        </button>
        {/* Re-run the analysis. This is the action that ACTUALLY clears an
            analysisStale state — refreshing data alone can't. Highlighted as
            the primary recovery path. */}
        {analysisStale && (
          <button
            onClick={onRunAnalysis}
            disabled={busy || analyzing}
            className="rounded border border-amber-500 bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            title="Re-run the LLM analysis with the current settings. Uses fresh data if you just clicked Refresh."
          >
            {analyzing ? "⟳ Re-running…" : "↻ Re-run analysis"}
          </button>
        )}
      </div>
    </div>
  );
}
