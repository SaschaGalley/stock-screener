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
}

export default function AnalysisView({
  symbol,
  summary,
  flags,
  refreshKey,
}: Props) {
  const [bundle, setBundle] = useState<StockBundle | null>(null);
  const [analysis, setAnalysis] = useState<CachedAnalysisEntry | null>(null);
  // bundleLoading only flips on symbol change; flag-toggling never triggers a full reload.
  const [bundleLoading, setBundleLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  // Stock bundle (financials, market signals, computed metrics, news) depends
  // only on the symbol — not on which LLM flags are selected.
  useEffect(() => {
    setBundleLoading(true);
    setError(null);
    api
      .getStock(symbol)
      .then(setBundle)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBundleLoading(false));
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <StockHeader
        summary={bundle.summary ?? summary!}
        financials={f}
        onRefreshed={() => setLocalRefresh((x) => x + 1)}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-4 px-6 py-5">
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

          {/* TIER 11: PERPLEXITY + NEWS */}
          {(bundle.perplexity || bundle.news.length > 0) && (
            <Section title="Research & News" defaultOpen={false}>
              <NewsAndResearch
                news={bundle.news}
                perplexity={bundle.perplexity}
              />
            </Section>
          )}

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
