import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  StockBundle,
  AnalysisFlagsKey,
  CachedAnalysisEntry,
} from "../types";
import VerdictHero from "./VerdictHero";
import BullBearRisks from "./BullBearRisks";
import StockHeader from "./StockHeader";
import { verdictForScore } from "../format";
import Section from "./Section";
import ScoreBreakdown from "./sections/ScoreBreakdown";
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
import { CloseIcon } from "./icons";
import { CurrencyProvider } from "../currency";
import { currencyPrefix } from "../format";

interface Props {
  symbol: string;
  /** Company name from the list, to head the view while the bundle loads. */
  fallbackName?: string;
  flags: AnalysisFlagsKey;
  refreshKey: number;
  /** True while an analyze run is in flight (parent owns the SSE stream). */
  analyzing: boolean;
  /** Stages the queue has in flight for this symbol, from GET /api/activity. */
  activity?: string[];
  /** Re-read the queue now, rather than waiting for the next poll. */
  onActivityChanged?: () => void;
  /** Chrome this pane owns now that there is no toolbar above it. */
  onClose: () => void;
  onOpenAdmin: () => void;
  onToggleStocks: () => void;
  /** Open the picker: stored analyses, and the settings for a new run. */
  onOpenAnalysis: () => void;
  /** Re-run with the combination on show, bypassing the cache. */
  onRerun: () => void;
  /** The flag combination on show, for the verdict card to wear. */
  flagsLabel: string;
}

export default function AnalysisView({
  symbol,
  fallbackName,
  flags,
  refreshKey,
  analyzing,
  activity = [],
  onActivityChanged,
  onClose,
  onOpenAdmin,
  onToggleStocks,
  onOpenAnalysis,
  onRerun,
  flagsLabel,
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
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 justify-end border-b border-ink-800 bg-ink-900 px-4 py-3 sm:px-6">
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          Loading {symbol}…
        </div>
      </div>
    );
  }

  // Error state — render a minimal header with a Refresh button so the user
  // can recover (e.g., after a cache schema bump invalidated the data).
  const summary = bundle?.summary ?? null;
  if (error || !bundle || !summary) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-ink-700 bg-ink-900 px-6 py-4">
          <div>
            <h1 className="text-xl font-bold text-ink-50">
              {fallbackName ?? symbol}
            </h1>
            <span className="font-mono text-xs text-ink-400">{symbol}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RefreshOnlyButton
              symbol={symbol}
              onRefreshed={() => setLocalRefresh((x) => x + 1)}
            />
            <CloseButton onClose={onClose} />
          </div>
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
  // Every figure below is denominated in the stock's trading currency (the data
  // layer FX-converts the statements into it), so one provider covers the view.
  const cur = f.tradingCurrency ?? null;
  const sym = currencyPrefix(cur);
  const llm = analysis?.llmAnalysis ?? null;
  const cs  = bundle.cacheStatus;
  const dataStale = cs && (cs.financials === 'stale' || cs.marketSignals === 'stale');

  // Per-selected-combo staleness — analyses don't have a clock-based TTL, only
  // a hash-based identity. The single staleness signal is "older than data":
  // the cached LLM call ran against an earlier financials snapshot.
  const analysisGenAt = analysis?.generatedAt ? new Date(analysis.generatedAt).getTime() : null;
  const dataCachedAt  = summary.cachedAt ? new Date(summary.cachedAt).getTime() : null;
  const analysisOlderThanData = analysisGenAt !== null && dataCachedAt !== null
    && analysisGenAt < dataCachedAt - 60_000;

  // One sentence and the menu entry that clears it. A data refresh alone
  // cannot clear an old analysis — it moves the data forward and leaves the
  // verdict further behind — so anything involving the analysis points at
  // „Alles", and only a pure data problem at „Nur Daten".
  const staleNote =
    dataStale && analysisOlderThanData
      ? 'Daten und Analyse sind veraltet. „Alles" frischt beides auf.'
      : dataStale
        ? 'Die gespeicherten Daten stammen aus einem älteren Format. „Nur Daten" holt sie neu.'
        : analysisOlderThanData
          ? 'Die Analyse ist älter als die Daten, die jetzt vorliegen. „Alles" rechnet sie mit ihnen neu.'
          : null;
  const staleFix: 'data' | 'everything' | null =
    analysisOlderThanData ? 'everything' : dataStale ? 'data' : null;

  return (
    <CurrencyProvider code={cur}>
      <div className="flex h-full flex-col overflow-hidden">
        <StockHeader
          summary={summary}
          financials={f}
          onRefreshed={() => setLocalRefresh((x) => x + 1)}
          activity={activity}
          onActivityChanged={onActivityChanged}
          onClose={onClose}
          onOpenAdmin={onOpenAdmin}
          onToggleStocks={onToggleStocks}
          staleNote={staleNote}
          staleFix={staleFix}
          onRerun={onRerun}
          onOpenAnalysis={onOpenAnalysis}
          flagsLabel={flagsLabel}
          analyzing={analyzing}
        />

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
              llm={llm && {
                ...llm,
                factorScore:    analysis?.scoreCard?.factor.score ?? null,
                narrativeScore: analysis?.scoreCard?.narrative?.score ?? null,
                capReasons:     analysis?.scoreCard
                  && verdictForScore(analysis.scoreCard.final.score) !== analysis.scoreCard.final.verdict
                  ? analysis.scoreCard.factor.caps.map((c) => c.reason)
                  : [],
              }}
              llmGeneratedAt={analysis?.generatedAt ?? null}
              llmModel={analysis?.flags.model ?? null}
              flagsLabel={flagsLabel}
              onOpenAnalysis={onOpenAnalysis}
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

            {/* How that verdict was arrived at — the calculation, not a retelling. */}
            {analysis?.scoreCard && (
              <Section
                title="Wie der Score entsteht"
                subtitle="Sechs berechnete Säulen, eine Prosa-Lesart, und das Mischungsverhältnis dazwischen"
                storageKey="score-breakdown"
              >
                <ScoreBreakdown card={analysis.scoreCard} />
              </Section>
            )}

            {/* TIER 2: BULL/BEAR/RISKS */}
            {llm && <BullBearRisks llm={llm} />}

            {/* TIER 3: COMPOSITE BAR CHART (Primary + Conservative tiers) */}
            {(m.composite.primary.models.length > 0 ||
              m.composite.conservative.models.length > 0) && (
              <Section
                title="Fair Value Distribution"
                subtitle={`Primary ${sym}${m.composite.primary.median?.toFixed(0) ?? "—"} · Conservative ${sym}${m.composite.conservative.median?.toFixed(0) ?? "—"}`}
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
                pplx={flags.pplx}
                distill={bundle.distill}
                searches={analysis?.searches ?? null}
                onRefreshed={() => setLocalRefresh((x) => x + 1)}
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
    </CurrencyProvider>
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
 * The way back to the list, for the states that have no `StockHeader` to carry
 * it — a bundle still loading, or one that failed to load at all. Same mark and
 * same corner either way, so it is never somewhere new to look for.
 */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="rounded border border-ink-700 bg-ink-800 p-1.5 text-ink-200 transition hover:border-ink-600 hover:bg-ink-700 hover:text-ink-50"
      title="Zurück zur Übersicht (Esc)"
      aria-label="Analyse schließen"
    >
      <CloseIcon />
    </button>
  );
}
