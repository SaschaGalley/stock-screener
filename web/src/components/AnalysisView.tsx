import { lazy, memo, Suspense } from 'react';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type {
  StockBundle,
  AnalysisFlagsKey,
  CachedAnalysisEntry,
  OverviewRow,
} from "../types";
import VerdictHero from "./VerdictHero";
import VerdictChanges from "./VerdictChanges";
import { useArchive } from "./useArchive";
import BullBearRisks from "./BullBearRisks";
import StockHeader from "./StockHeader";
import { verdictForScore } from "../format";
import Section from "./Section";
import ScoreBreakdown from "./sections/ScoreBreakdown";
import MarginTrends from "./sections/MarginTrends";
import BalanceChecks from "./sections/BalanceChecks";
import AnalystTrackRecord from "./sections/AnalystTrackRecord";
import VerdictTrackRecord from "./sections/VerdictTrackRecord";
import HoldersPanel from "./sections/HoldersPanel";
import StockTimeline from "./sections/StockTimeline";
import IncomeFlowChart from "./charts/IncomeFlowChart";
import ValuationHistory from "./sections/ValuationHistory";
import CompositeChart from "./charts/CompositeChart";
import ValuationDetail from "./sections/ValuationDetail";
import QualityScores from "./sections/QualityScores";
import FundamentalsGrid from "./sections/FundamentalsGrid";
import PeerCompare from "./sections/PeerCompare";
import ChartTechnicals from "./sections/ChartTechnicals";
import PriceAction from "./sections/PriceAction";
import MarketContext from "./sections/MarketContext";
import OwnershipFlow from "./sections/OwnershipFlow";
import EarningsBlock from "./sections/EarningsBlock";
import NewsAndResearch from "./sections/NewsAndResearch";
import CompanyInfo from "./sections/CompanyInfo";
import FundamentalsHistoryChart from "./charts/FundamentalsHistoryChart";
import { CloseIcon } from "./icons";
import StockTabs, { type StockTab } from "./StockTabs";
import OverviewCards from "./OverviewCards";
import More from "./More";
import {
  companyFinding, earningsFinding, fairValueFinding, fundamentalsFinding, marketContextFinding, modelsFinding,
  ownershipFinding, peersFinding, priceActionFinding, qualityFinding, researchFinding,
} from "./sectionFindings";
// Markdown and the editor are only wanted once the section is opened.
const Journal = lazy(() => import("./Journal"));
import { CurrencyProvider } from "../currency";
import { currencyPrefix, fmtBig, fmtPrice } from "../format";

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
  /** Open the peer dialog. */
  onOpenPeers: () => void;
  /** Re-run with the combination on show, bypassing the cache. */
  onRerun: () => void;
  /** The flag combination on show, for the verdict card to wear. */
  flagsLabel: string;
  /** The stock's row in the list: its timing readings and setups, for the chart section. */
  row?: OverviewRow | null;
  /** The topic on show; the page always opens on the overview. */
  tab: StockTab;
  onTab: (tab: StockTab) => void;
}

/**
 * One tab's content. Built the first time the tab is opened and kept while
 * the stock is, so going back to a tab finds its charts as they were and
 * fetches nothing twice.
 */
function TabPane({ on, seen, children }: { on: boolean; seen: boolean; children: ReactNode }) {
  if (!seen) return null;
  return <div className={on ? 'space-y-4' : 'hidden'}>{children}</div>;
}

function AnalysisView({
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
  onOpenPeers,
  onRerun,
  flagsLabel,
  row,
  tab,
  onTab,
}: Props) {
  const [bundle, setBundle] = useState<StockBundle | null>(null);
  const [analysis, setAnalysis] = useState<CachedAnalysisEntry | null>(null);
  // bundleLoading only flips on symbol change; flag-toggling never triggers a full reload.
  const [bundleLoading, setBundleLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  // The tabs opened for this stock; a new stock starts with the one on show.
  const [seen, setSeen] = useState<{ symbol: string; tabs: Set<StockTab> }>(() => ({ symbol, tabs: new Set([tab]) }));
  useEffect(() => {
    setSeen((prev) => (prev.symbol !== symbol
      ? { symbol, tabs: new Set([tab]) }
      : prev.tabs.has(tab) ? prev : { symbol, tabs: new Set(prev.tabs).add(tab) }));
  }, [symbol, tab]);
  const shown = new Set<StockTab>(seen.symbol === symbol ? [...seen.tabs, tab] : [tab]);
  // A new tab starts at its top.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [symbol, tab]);
  // How many entries the journal holds, beside its tab — read again on leaving it, after an entry was added.
  const journalCount = useArchive(
    () => api.getJournal(symbol).then((r) => ({ data: r.entries.length })),
    [symbol, tab === 'journal'],
  ).data ?? null;
  // Firm by firm, behind the consensus card — before the early returns, as hooks must be.
  const coverage = useArchive(() => api.getCoverage(symbol), [symbol, refreshKey, localRefresh]).data ?? null;

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
          Lade {symbol} …
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
            <p className="mb-2 text-sm text-amber-400">{error || "Keine Daten"}</p>
            <p className="text-xs text-ink-500">
              <span className="font-mono">↻ Daten holen</span> oben lädt sie neu von
              Yahoo und Finnhub.
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
  // For the section headers' findings, which are built outside the currency provider below.
  const money = (n: number | null | undefined) => fmtPrice(n, cur);
  const big = (n: number | null | undefined) => fmtBig(n, cur);
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
          onOpenPeers={onOpenPeers}
          flagsLabel={flagsLabel}
          analyzing={analyzing}
        />

        <StockTabs tab={tab} onTab={onTab} counts={{ journal: journalCount ?? undefined }} />

        <div ref={scroller} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-5">
            <TabPane on={tab === 'overview'} seen={shown.has('overview')}>
              {/* TIER 1: AT-A-GLANCE VERDICT */}
              <VerdictHero
                price={f.price}
                composite={m.composite}
                llm={llm && {
                  ...llm,
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
                // How the verdict was arrived at — the calculation, not a retelling.
                verdictChanges={<VerdictChanges symbol={symbol} refreshKey={refreshKey} />}
                coverage={coverage}
              />
              {/* ONE CARD PER TOPIC — what each tab says, and a click to it */}
              <OverviewCards
                symbol={symbol}
                f={f}
                m={m}
                sector={bundle.sectorMedians ?? null}
                card={analysis?.scoreCard ?? null}
                onTab={onTab}
              />

              {/* TIER 2: THE CASE FOR AND AGAINST — what a reader wants right after the verdict. */}
              {llm && (
                <BullBearRisks
                  llm={llm}
                  scenarios={{
                    price: f.price,
                    bull: [
                      { label: 'DCF p90', value: m.dcf.fairValueBull, hint: 'Der Wert, den 90 % der DCF-Szenarien nicht erreichen — das optimistische Ende der Simulation' },
                      { label: 'Kursziel hoch', value: f.analystTargetHigh, hint: 'Das höchste Kursziel der Analysten' },
                    ],
                    bear: [
                      { label: 'DCF p10', value: m.dcf.fairValueBear, hint: 'Der Wert, den 90 % der DCF-Szenarien übertreffen — das pessimistische Ende der Simulation' },
                      { label: 'Kursziel tief', value: f.analystTargetLow, hint: 'Das niedrigste Kursziel der Analysten' },
                    ],
                  }}
                />
              )}
              {/* How the score came about — the calculation behind the verdict, after the case for and against */}
              {analysis?.scoreCard && <ScoreBreakdown card={analysis.scoreCard} />}
            </TabPane>

            <TabPane on={tab === 'chart'} seen={shown.has('chart')}>
              {/* THE CHART — levels, channels, lines, a model's reading; as large as the screen allows */}
              <Section fixed
                title="Chart & Technik"
                info="section.technicals"
                subtitle="Trend, Unterstützungen, Widerstände, Kanäle, Timing und KI-Chartlesung"
                storageKey="technicals"
              >
                <ChartTechnicals
                  symbol={symbol}
                  row={row ?? null}
                  timing={bundle.marketSignals?.technicals?.timing ?? null}
                  signals={bundle.technicalSignals}
                  model={flags.model}
                  chartHeight="clamp(420px, 62vh, 760px)"
                />
              </Section>
              {/* What the stock has done and what surrounds it — returns, volatility, options, revisions, macro */}
              {bundle.marketSignals && (
                <More label="Renditen, Volatilität, relative Stärke, Optionen, Revisionen und Makro">
                  <Section fixed
                    title="Kursentwicklung"
                    finding={priceActionFinding(bundle.marketSignals)}
                    info="section.priceAction"
                    subtitle="Renditen, Volatilität, Position, relative Stärke"
                  >
                    <PriceAction marketSignals={bundle.marketSignals} />
                  </Section>
                  <Section fixed
                    title="Marktumfeld"
                    finding={marketContextFinding(bundle.marketSignals)}
                    info="section.marketContext"
                    subtitle="Optionen, Analystenrevisionen, Makro"
                  >
                    <MarketContext marketSignals={bundle.marketSignals} />
                  </Section>
                </More>
              )}
            </TabPane>

            <TabPane on={tab === 'valuation'} seen={shown.has('valuation')}>
              {/* TIER 3: COMPOSITE BAR CHART (Primary + Conservative tiers) */}
              {(m.composite.primary.models.length > 0 ||
                m.composite.conservative.models.length > 0) && (
                <Section fixed
                  title="Fairer Wert nach Modellen"
                  info="section.fairValue"
                  finding={fairValueFinding(m, f.price, money)}
                >
                  <div className="mb-2 text-xs text-ink-500">
                    <span className="mr-3">
                      <span className="inline-block h-2 w-3 rounded-sm bg-emerald-500 align-middle"></span>{" "}
                      Primär (gefüllt) · marktnah
                    </span>
                    <span>
                      <span className="inline-block h-2 w-3 rounded-sm border border-emerald-500 align-middle"></span>{" "}
                      Konservativ (umrandet) · Substanzblick
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
              {/* TIER 3b: THE SAME QUESTION OVER FIVE YEARS — is today unusual for this stock? */}
              <Section fixed
                title="Bewertung im Zeitverlauf"
                info="section.valuationHistory"
                subtitle="Fair Value, Gewinn und Multiples der letzten fünf Jahre"
                storageKey="valuation-history"
              >
                <ValuationHistory symbol={symbol} liveFairValue={m.composite.primary.median} />
              </Section>
              {/* TIER 4: VALUATION DETAILS */}
              <Section fixed
                title="Bewertungsmodelle"
                finding={modelsFinding(m, f.price, money)}
                info="section.valuationModels"
                subtitle="DCF, Peer-Multiples, Reverse-DCF"
              >
                <ValuationDetail metrics={m} price={f.price} />
              </Section>
              {/* TIER 7: PEER COMPARISON */}
              {bundle.sectorMedians && (
                <Section fixed title="Vergleich mit Peers" finding={peersFinding(m, bundle.sectorMedians ?? null)} info="section.peers">
                  <PeerCompare
                    ratios={m.ratios}
                    evMultiples={m.evMultiples}
                    financials={f}
                    sectorMedians={bundle.sectorMedians}
                  />
                </Section>
              )}
            </TabPane>

            <TabPane on={tab === 'business'} seen={shown.has('business')}>
              {/* TIER 0: Company info — restored after refactor */}
              {(f.description ||
                f.employees ||
                f.website ||
                f.isin ||
                f.industry) && (
                <Section fixed title="Über das Unternehmen" finding={companyFinding(f)}>
                  <CompanyInfo financials={f} />
                </Section>
              )}
              {/* TIER 8: FUNDAMENTALS — the last ~5 fiscal years, then today's figures */}
              <Section fixed title="Geschäftszahlen" finding={fundamentalsFinding(f, m)} info="section.fundamentals" subtitle="Verlauf der letzten Geschäftsjahre und aktuelle Kennzahlen" storageKey="fundamentals-combined">
                <div className="space-y-5">
                  {f.fundamentalsHistory &&
                    (f.fundamentalsHistory.revenue?.length > 0 ||
                      f.fundamentalsHistory.netIncome?.length > 0 ||
                      f.fundamentalsHistory.eps?.length > 0) && (
                      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
                        <FundamentalsHistoryChart history={f.fundamentalsHistory} />
                        <MarginTrends history={f.fundamentalsHistory} />
                      </div>
                    )}
                  <IncomeFlowChart symbol={symbol} />
                  <More label="alle Kennzahlen zu Profitabilität, Bilanz und Bewertung">
                    <FundamentalsGrid
                      financials={f}
                      ratios={m.ratios}
                      evMultiples={m.evMultiples}
                    />
                  </More>
                </div>
              </Section>
              {/* TIER 6: EARNINGS (history + forward) */}
              {(f.earningsSurprises?.length > 0 ||
                f.earningsEstimates?.length > 0) && (
                <Section fixed title="Quartalszahlen" finding={earningsFinding(f)} info="section.earnings">
                  <EarningsBlock financials={f} />
                </Section>
              )}
              {/* TIER 5: QUALITY & RISK */}
              <Section fixed title="Qualität & Risiko" finding={qualityFinding(m)} info="section.quality">
                <BalanceChecks health={m.health} />
                <QualityScores metrics={m} />
              </Section>
            </TabPane>

            <TabPane on={tab === 'analysts'} seen={shown.has('analysts')}>
              {/* TIER 7b: HOW GOOD THE TARGETS IN THE CONSENSUS CARD HAVE BEEN */}
              <Section fixed
                title="Analysten: Trefferquote"
                info="section.analystRecord"
                subtitle="Jedes archivierte Kursziel gegen den Kurs ein Jahr später"
                storageKey="analyst-record"
              >
                <AnalystTrackRecord symbol={symbol} />
              </Section>
              {/* TIER 7c: THE SAME QUESTION, ASKED OF OUR OWN VERDICTS */}
              <Section fixed
                title="Unser Urteil: Trefferquote"
                info="section.verdictRecord"
                subtitle="Jeder Urteilswechsel gegen den S&P 500 danach"
                storageKey="verdict-record"
              >
                <VerdictTrackRecord symbol={symbol} />
              </Section>
              {/* TIER 10: OWNERSHIP & FLOW */}
              <Section fixed title="Eigentümer & Insider" finding={ownershipFinding(f, big)} info="section.ownership">
                <div className="space-y-5">
                  <OwnershipFlow financials={f} />
                  <HoldersPanel symbol={symbol} />
                </div>
              </Section>
            </TabPane>

            <TabPane on={tab === 'history'} seen={shown.has('history')}>
              {/* TIER 10b: WHAT HAPPENED WHEN — every archived event on one axis */}
              <Section fixed title="Zeitleiste" info="section.timeline" subtitle="Journal, Analysten, Insider, Zahlen, Dividenden, Urteil, Ereignisse, Kurssprünge" storageKey="timeline">
                <StockTimeline symbol={symbol} />
              </Section>
              {/* TIER 11: DISTILL + PERPLEXITY + NEWS + SEARCH TRACES */}
              <Section fixed title="Research & Nachrichten" finding={researchFinding(bundle.news, bundle.perplexity, bundle.deepResearch ?? null)} info="section.research">
                <NewsAndResearch
                  symbol={symbol}
                  news={bundle.news}
                  perplexity={bundle.perplexity}
                  deepResearch={bundle.deepResearch ?? null}
                  pplx={flags.pplx}
                  distill={bundle.distill}
                  searches={analysis?.searches ?? null}
                  onRefreshed={() => setLocalRefresh((x) => x + 1)}
                />
              </Section>
            </TabPane>

            <TabPane on={tab === 'journal'} seen={shown.has('journal')}>
              {/* TIER 2b: MY OWN VIEW — notes, purchases, sales and why, beside the case for and against */}
              <Section fixed title="Mein Journal" finding={journalCount ? `${journalCount} ${journalCount === 1 ? 'Eintrag' : 'Einträge'}` : null} info="section.journal" subtitle="Notizen, Käufe und Verkäufe zu dieser Aktie — und warum" storageKey="journal">
                <Suspense fallback={<p className="text-xs text-ink-500">Lade Journal …</p>}>
                  <Journal symbol={symbol} />
                </Suspense>
              </Section>
            </TabPane>
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
      {busy ? "⟳ Hole Daten …" : "↻ Daten holen"}
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

/**
 * Memoised: the app re-renders on every poll, keystroke and progress line, and
 * this page — twenty sections, ten charts — has no reason to follow unless its
 * own props changed.
 */
export default memo(AnalysisView);
