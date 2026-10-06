import { useState, useEffect } from 'react';
import {
  DEEP_RESEARCH_MODEL, DEFAULT_PERPLEXITY_MODEL, type PerplexityModelId, perplexityLabel,
} from '../../../../src/models';
import { ManualResearch, ResearchReports } from '../ManualResearch';
import { api } from '../../api';
import PerplexityBrief from './PerplexityBrief';
import { useFirst } from '../More';
import Section from '../Section';
import type {
  SearchTrace,
  SearchProviderTrace,
  DistillBundle,
  DistillBriefing,
  DistillDossierBlock,
  DistillInsight,
  PerplexityContext,
  PplxChoice,
} from '../../types';

interface Props {
  symbol: string;
  news: any[];
  perplexity: PerplexityContext | null;
  /** The newest deep research report, bought by hand. */
  deepResearch: PerplexityContext | null;
  /** The sidebar's Perplexity choice — the model a refresh asks for. */
  pplx: PplxChoice;
  distill: DistillBundle | null;
  searches: SearchTrace | null;
  /** Called after a successful Distill or Perplexity refresh so the parent can
   *  re-fetch the bundle that now carries it. */
  onRefreshed: () => void;
}

/** Friendly label + accent shade per provider. Kept simple — these are debug
 *  bins, not user-facing branding. */
const PROVIDER_META: Record<SearchProviderTrace['provider'], { label: string; tint: string }> = {
  'tavily':              { label: 'Tavily',            tint: 'border-l-violet-500' },
  'brave':               { label: 'Brave',             tint: 'border-l-orange-500' },
  'claude-web-search':   { label: 'Claude web_search', tint: 'border-l-amber-500' },
  'openai-web-search':   { label: 'OpenAI web_search', tint: 'border-l-emerald-500' },
};

/**
 * The research tab: each source its own card, the one the analysis weighs
 * most first. It shared a tab with the timeline, and both ran long — a
 * reader after the Perplexity brief scrolled through a year of events to
 * reach it, one after the events through three reports.
 */
export default function ResearchTab({ symbol, news, perplexity, deepResearch, pplx, distill, searches, onRefreshed }: Props) {
  return (
    <>
      {/* Distill — first because it's the most-weighted qualitative signal in
          the LLM prompt. Always rendered (even with zero briefings) so the
          user can trigger a first generation via the refresh button. */}
      <DistillSection symbol={symbol} distill={distill} onRefreshed={onRefreshed} />

      {/* Also shown with nothing stored yet when Perplexity is selected, so a
          first synthesis can be fetched without running an analysis. */}
      {(perplexity || pplx) && (
        <PerplexitySection symbol={symbol} perplexity={perplexity} pplx={pplx} onRefreshed={onRefreshed} />
      )}

      <DeepResearchSection symbol={symbol} deep={deepResearch} onRefreshed={onRefreshed} />

      {news.length > 0 && <NewsSection news={news} />}

      {/* Search traces — one collapsible block per provider that ran. Persisted
          on the cached analysis so the user can audit what context the LLM saw
          (debug / provenance / "why did Claude get this wrong?"). Native
          providers expose only the queries because the actual fetched URLs are
          processed server-side by Anthropic/OpenAI and never reach our SDK. */}
      {searches && searches.providers.length > 0 && <SearchesSection searches={searches} />}
    </>
  );
}

const dayDe = (iso: string) => new Date(iso).toLocaleDateString('de-DE');
const timeDe = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function NewsSection({ news }: { news: any[] }) {
  const [first, more] = useFirst(news, 6, 'Meldungen');
  const newest = Math.max(...news.map((n) => n.datetime ?? 0));
  return (
    <Section fixed
      title="Nachrichten"
      info="section.news"
      finding={`${news.length} ${news.length === 1 ? 'Meldung' : 'Meldungen'}${newest > 0 ? `, die neueste vom ${new Date(newest * 1000).toLocaleDateString('de-DE')}` : ''}`}
    >
      <ul className="divide-y divide-ink-800">
        {first.map((n, i) => (
          <li key={i} className="flex items-baseline gap-3 py-2 first:pt-0">
            <span className="w-20 shrink-0 font-mono text-xs text-ink-500">
              {new Date(n.datetime * 1000).toLocaleDateString('de-DE')}
            </span>
            <div className="min-w-0">
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-sm text-ink-100 hover:underline">
                {n.headline}
              </a>
              <div className="text-xs text-ink-500">{n.source}</div>
            </div>
          </li>
        ))}
      </ul>
      {more}
    </Section>
  );
}

function SearchesSection({ searches }: { searches: SearchTrace }) {
  const queries = searches.providers.reduce((n, p) => n + p.queries.length, 0);
  return (
    <Section fixed
      title="Suchen der Analyse"
      info="section.searches"
      finding={`${searches.providers.length} Anbieter, ${queries} ${queries === 1 ? 'Suchanfrage' : 'Suchanfragen'}`}
    >
      <div className="space-y-2">
        {searches.providers.map((p, i) => (
          <SearchProviderBlock key={`${p.provider}-${i}`} trace={p} />
        ))}
      </div>
    </Section>
  );
}

/**
 * Wrapper around the Distill briefings list with an explicit "↻ Refresh"
 * button that calls the Distill backend's POST /briefings/refresh. State
 * machine: idle → in-flight (spinner + helpful copy explaining the wait) →
 * either an error toast or a parent-triggered bundle refresh that brings the
 * new briefings + cost badge in.
 *
 * Read-only key handling: 403 from the stock-cli proxy is converted into a
 * disabled button + persistent tooltip rather than an alert. Once the user
 * sees that state they know to mint a write-scoped key in the Distill admin
 * — no need to bug them again on subsequent stocks.
 */
function DistillSection({
  symbol,
  distill,
  onRefreshed,
}: {
  symbol: string;
  distill: DistillBundle | null;
  onRefreshed: () => void;
}) {
  const briefing = distill?.briefing ?? null;
  // The company block first, then its sectors — the same order the analysis
  // prompt uses, and the order that reads company-then-backdrop.
  // A block with no dossier text but with insights still carries material — that
  // is a just-switched-on entity, whose dossier arrives with tonight's sweep.
  const blocks: DistillDossierBlock[] = [distill?.company, ...(distill?.sectors ?? [])]
    .filter((b): b is DistillDossierBlock =>
      !!b && (!!b.content?.trim() || (b.insights?.items.length ?? 0) > 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Persistent error states — once tripped, the button stays disabled with a
  // hint until the user fixes the upstream config (no point retrying).
  const [persistent, setPersistent] = useState<
    | { kind: 'unauthorized' }
    /** Symbol-specific: the server carries the candidate list in `detail`. */
    | { kind: 'entity-unresolved'; detail: string }
    | null
  >(null);

  // Reset transient + persistent error state when switching tickers — a config
  // error surfaced on one symbol must not leave Refresh disabled for the next.
  useEffect(() => {
    setPersistent(null);
    setError(null);
  }, [symbol]);

  async function handleRefresh() {
    if (busy || persistent) return;
    setBusy(true);
    setError(null);
    try {
      await api.refreshDistill(symbol);
      onRefreshed();
    } catch (e) {
      const msg = (e as Error).message ?? 'Neu holen fehlgeschlagen';
      if (msg.includes('distill_unauthorized')) {
        setPersistent({ kind: 'unauthorized' });
      } else if (msg.includes('distill_entity_unresolved')) {
        // No single Distill entity answers to this ticker. Retrying changes
        // nothing until someone adds the ISIN or picks the right entity, so
        // disable the button and show what the registry offered.
        setPersistent({
          kind:   'entity-unresolved',
          detail: msg.replace(/^distill_entity_unresolved:\s*/, ''),
        });
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  const company = blocks.some((b) => b.kind !== 'sector');
  const sectors = blocks.filter((b) => b.kind === 'sector').length;
  const finding = [
    company && 'Firmendossier',
    sectors > 0 && `${sectors} ${sectors === 1 ? 'Branchendossier' : 'Branchendossiers'}`,
    briefing && `Briefing vom ${dayDe(briefing.createdAt)}`,
  ].filter(Boolean).join(' · ') || null;

  return (
    <Section fixed
      title="Distill"
      info="section.distill"
      finding={finding}
      subtitle="Noch kein Dossier und kein Briefing"
      rightHeader={<>
        {distill?.fetchedAt && <span className="text-xs text-ink-500">geholt {timeDe(distill.fetchedAt)}</span>}
        <RefreshButton busy={busy} disabled={!!persistent} onClick={handleRefresh} />
      </>}
    >

      {busy && (
        <div className="mb-2 rounded border border-accent/30 bg-accent-soft px-3 py-1.5 text-xs text-ink-300">
          ⟳ Wird neu geholt … beim ersten Mal kann das ein paar Minuten dauern,
          bis Distill den Rückstand verarbeitet hat.
        </div>
      )}
      {error && (
        <div className="mb-2 rounded border border-amber-700 bg-amber-950 px-3 py-1.5 text-xs text-amber-300">
          ⚠ {error}
        </div>
      )}
      {persistent && (
        <PersistentHint
          kind={persistent.kind}
          detail={'detail' in persistent ? persistent.detail : undefined}
        />
      )}

      {blocks.length === 0 && !briefing ? (
        <div className="rounded border border-dashed border-ink-800 px-3 py-2 text-xs text-ink-500">
          Nichts von Distill — weder ein Dossier noch frische Insights. Der Sweep
          baut Dossiers einmal pro Nacht für eingeschaltete Entities.
        </div>
      ) : (
        <div className="space-y-2">
          {blocks.map((b) => <DossierBlock key={b.ref} block={b} symbol={symbol} />)}
          {briefing && <DistillBriefingBlock briefing={briefing} />}
        </div>
      )}
    </Section>
  );
}

/**
 * The stored Perplexity synthesis, with a refresh that goes past the cache.
 *
 * Every analysis — re-runs included — serves the stored synthesis until the
 * cache window in the admin settings runs out (14 days by default), because
 * each call is billed. This button is the one way to buy a new one sooner.
 */
function PerplexitySection({
  symbol,
  perplexity,
  pplx,
  onRefreshed,
}: {
  symbol: string;
  perplexity: PerplexityContext | null;
  pplx: PplxChoice;
  onRefreshed: () => void;
}) {
  // The sidebar's choice wins; without one, keep the model the stored
  // synthesis came from. Deep research is never the regular brief's model
  // here — it has its own block and its own button.
  const chosen = pplx ?? perplexity?.model ?? DEFAULT_PERPLEXITY_MODEL;
  const model = chosen === DEEP_RESEARCH_MODEL ? DEFAULT_PERPLEXITY_MODEL : chosen;
  const refresh = usePerplexityRefresh(symbol, model, onRefreshed);

  return (
    <Section fixed
      title="Perplexity"
      info="section.perplexity"
      finding={perplexity ? `Recherche vom ${briefMeta(perplexity)}` : null}
      subtitle="Noch keine Recherche"
      rightHeader={<>
        <RefreshButton
          busy={refresh.busy}
          disabled={false}
          onClick={refresh.run}
          title={`Perplexity neu abfragen (${perplexityLabel(model)}) — ohne Cache, kostet einen Aufruf.`}
        />
      </>}
    >

      {refresh.busy && <Busy>⟳ Frage Perplexity ab… dauert mit {perplexityLabel(model)} meist eine halbe bis zwei Minuten.</Busy>}
      {refresh.error && <Failed>{refresh.error}</Failed>}

      {perplexity ? (
        <div className="rounded border border-ink-800 bg-ink-950 px-3 py-2">
          <div className="max-h-[48rem] overflow-y-auto">
            <PerplexityBrief context={perplexity} />
          </div>
          <Citations urls={perplexity.citations} />
        </div>
      ) : (
        <div className="rounded border border-dashed border-ink-800 px-3 py-2 text-xs text-ink-500">
          Noch keine Perplexity-Recherche für {symbol}. Die nächste Analyse holt eine,
          „↻ Neu holen“ sofort.
        </div>
      )}
    </Section>
  );
}

/**
 * Research beyond the regular brief: the deep company report, kept beside it,
 * and the research run by hand for reading — the preview of a report, the
 * check of my own theses, a question across several stocks.
 *
 * The company report is its own purchase: through the API about a dollar and
 * several minutes, against a few cents for the brief. The other way in is a
 * subscription: copy the prompt, run it in a chat app's research mode, paste
 * the answer back. Either way every analysis inside the window set in the
 * admin settings reads it, so a report kept today shapes the verdicts of the
 * next weeks — the buttons say so. The other kinds are for reading only.
 */
function DeepResearchSection({ symbol, deep, onRefreshed }: {
  symbol: string;
  deep: PerplexityContext | null;
  onRefreshed: () => void;
}) {
  const refresh = usePerplexityRefresh(symbol, DEEP_RESEARCH_MODEL, onRefreshed);
  const cost = perplexityLabel(DEEP_RESEARCH_MODEL);
  // Bumped after a report other than the company brief is kept, so the list is read again.
  const [tick, setTick] = useState(0);

  function start() {
    if (!window.confirm(
      `Deep Research für ${symbol} über die API anfordern? ${cost} pro Bericht, dauert 3–5 Minuten. `
      + 'Der Bericht geht danach in jede Analyse ein, bis er älter ist als im Admin eingestellt.',
    )) return;
    refresh.run();
  }

  return (
    <Section fixed
      title="Deep Research & eigene Recherchen"
      info="section.deepResearch"
      finding={deep ? `Firmenbericht vom ${briefMeta(deep)}` : null}
      subtitle="Kein Firmenbericht"
      rightHeader={<>
        <button
          onClick={start}
          disabled={refresh.busy}
          title={`Firmenbericht über die API: ${cost} — Dutzende Suchen, 3–5 Minuten.`}
          className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-xs font-medium text-ink-300 transition hover:bg-ink-800 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {refresh.busy ? '⟳ läuft …' : 'Über die API'}
        </button>
      </>}
    >

      {refresh.busy && <Busy>⟳ Deep Research läuft — Perplexity sucht und schreibt drei bis fünf Minuten. Die Seite kann offen bleiben.</Busy>}
      {refresh.error && <Failed>{refresh.error}</Failed>}
      <div className="mb-3">
        <ManualResearch
          kinds={['company', 'earnings', 'thesis']}
          symbols={[symbol]}
          replaces={(kind) => kind === 'company' && deep
            ? `Ersetzt den Bericht vom ${dayDe(deep.fetchedAt)} in den Analysen; der alte bleibt im Archiv.`
            : null}
          onSaved={(kind) => (kind === 'company' ? onRefreshed() : setTick((n) => n + 1))}
        />
      </div>

      {deep ? (
        <details className="rounded border border-ink-800 bg-ink-950 px-3 py-2" open>
          <summary className="cursor-pointer text-2xs text-ink-500">
            Firmenbericht vom {dayDe(deep.fetchedAt)} — geht in jede Analyse ein, solange er im Zeitfenster liegt
          </summary>
          <div className="mt-2 max-h-[48rem] overflow-y-auto">
            <PerplexityBrief context={deep} />
          </div>
          <Citations urls={deep.citations} />
        </details>
      ) : (
        <div className="rounded border border-dashed border-ink-800 px-3 py-2 text-xs text-ink-500">
          Kein Firmenbericht für {symbol}. Am günstigsten mit einem Abo: „Prompt kopieren“, in
          Perplexity (oder ChatGPT, Claude, Gemini) im Research-Modus laufen lassen, die Antwort mit
          „Ergebnis einfügen“ zurückholen. Über die API kostet er {cost}.
        </div>
      )}

      <div className="mt-3">
        <ResearchReports symbol={symbol} tick={tick} title="Weitere Recherchen" />
      </div>
    </Section>
  );
}

function usePerplexityRefresh(symbol: string, model: PerplexityModelId, onRefreshed: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [symbol]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.refreshPerplexity(symbol, model);
      onRefreshed();
    } catch (e) {
      setError((e as Error).message ?? 'Neu holen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/** "14.8.2026, sonar-pro, 0,42 $" — when a brief was bought, from where, for how much. */
function briefMeta(context: PerplexityContext): string {
  return [
    dayDe(context.fetchedAt),
    context.pastedFrom ? `${context.pastedFrom}, von Hand` : context.model,
    context.costUsd !== undefined && `${context.costUsd.toFixed(2).replace('.', ',')} $`,
  ].filter(Boolean).join(', ');
}

function Busy({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 rounded border border-accent/30 bg-accent-soft px-3 py-1.5 text-xs text-ink-300">
      {children}
    </div>
  );
}

function Failed({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 rounded border border-amber-700 bg-amber-950 px-3 py-1.5 text-xs text-amber-300">
      ⚠ {children}
    </div>
  );
}

function Citations({ urls }: { urls: string[] | undefined }) {
  if (!urls?.length) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-2xs text-ink-500">{urls.length} {urls.length === 1 ? 'Quelle' : 'Quellen'}</summary>
      <ul className="mt-1 space-y-0.5 pl-4 text-2xs text-ink-500">
        {urls.map((u, i) => (
          <li key={i}><a href={u} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">{u}</a></li>
        ))}
      </ul>
    </details>
  );
}

function RefreshButton({ busy, disabled, onClick, title }: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title={disabled
        ? 'Gerade nicht möglich — der Hinweis darunter sagt, was fehlt.'
        : title ?? 'Distill neu holen: verarbeitet offene Insights und baut das Briefing (neu).'}
      className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? '⟳' : '↻'} Neu holen
    </button>
  );
}

/** Persistent configuration-error hint. Once the user sees this, the fix is
 *  upstream (Distill admin or .env) — no point in retrying without action.
 *  `detail` replaces the canned copy when the server sent something specific. */
function PersistentHint({ kind, detail }: {
  kind: 'unauthorized' | 'entity-unresolved';
  detail?: string;
}) {
  const messages: Record<typeof kind, string> = {
    'unauthorized':
      'Distill hat den Schlüssel abgelehnt. `DISTILL_API_KEY` in der .env prüfen und ob der Schlüssel im Distill-Admin noch existiert.',
    'entity-unresolved':
      'Das Kürzel passt nicht zu genau einer Distill-Entity. Die ISIN ergänzen oder die Entity in Distill wählen — raten hängte womöglich das Briefing einer anderen Firma an.',
  };
  return (
    <div className="mt-1 text-2xs italic text-ink-500">
      {detail ?? messages[kind]}
    </div>
  );
}


/**
 * A single Distill briefing. Open by default for the most-recent one to keep
 * the prominent signal visible without a click, collapsed for the rest. The
 * body is either plain text or Distill's restricted markdown subset (only
 * **bold** and `- bullet lists` — no headers, no code blocks). We render
 * inline rather than pulling in react-markdown to keep the bundle small.
 */
/**
 * One rolling dossier.
 *
 * Sector blocks are tinted and captioned differently on purpose: the failure
 * mode this integration actually hits is a sector dossier being read as though
 * it described the company, and the reader here makes the same mistake the
 * model would.
 */
function DossierBlock({ block, symbol }: { block: DistillDossierBlock; symbol: string }) {
  const isSector = block.kind === 'sector';
  const window = block.periodStart && block.periodEnd
    ? `${dayDe(block.periodStart)} – ${dayDe(block.periodEnd)}`
    : null;

  return (
    <details
      className={`rounded border border-l-2 border-ink-800 bg-ink-950 ${isSector ? 'border-l-ink-600' : 'border-l-accent'}`}
      open={!isSector}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-ink-100">
            <span className={`mr-1.5 rounded px-1 py-px text-3xs uppercase tracking-wider ${
              isSector ? 'bg-ink-800 text-ink-400' : 'bg-accent-soft text-accent'
            }`}>
              {isSector ? 'Sektor' : 'Firma'}
            </span>
            {block.displayName}
          </span>
          <span className="shrink-0 text-2xs text-ink-500">
            {window}
            {block.stale && <span className="ml-1 text-ink-600" title="Ein spätes Dokument kam in ein schon gebautes Dossier — der Zeitraum oben gilt weiter.">· nachgereicht</span>}
          </span>
        </div>
        {isSector && (
          <div className="mt-0.5 text-2xs text-ink-500">
            Branchenbild, nicht {symbol} — Hintergrund, vor dem die Aktie gelesen wird.
          </div>
        )}
      </summary>
      <div className="border-t border-ink-800 px-3 py-2 text-xs leading-relaxed text-ink-200">
        {block.content?.trim()
          ? renderDistillBody(block.content, 'markdown')
          : (
            <p className="text-xs italic text-ink-500">
              Noch kein Dossier gebaut — der Sweep zieht es heute Nacht nach. Unten steht
              das Rohmaterial, das stattdessen ins Prompt geht.
            </p>
          )}
        <InsightList insights={block.insights?.items ?? []} truncated={!!block.insights?.truncated} />
      </div>
    </details>
  );
}

/**
 * The raw statements a dossier does not reproduce.
 *
 * Rendered as a distinct, quieter list because they carry different weight: no
 * editorial fold happened, so one line is one source. The date shown is the
 * news date (Distill's period axis), not when it was ingested.
 */
function InsightList({ insights, truncated }: { insights: DistillInsight[]; truncated: boolean }) {
  if (insights.length === 0) return null;
  return (
    <div className="mt-3 border-t border-dashed border-ink-800 pt-2">
      <div className="mb-1 text-xs font-semibold text-ink-300">
        Nicht im Dossier · {insights.length} roh
        {truncated && <span className="ml-1 font-normal normal-case tracking-normal text-ink-500">(gekappt — es gibt mehr)</span>}
      </div>
      <ul className="space-y-1">
        {insights.map((i) => (
          <li key={i.id} className="text-xs text-ink-400">
            <span className="font-mono text-ink-500">{i.at ? dayDe(i.at) : '—'}</span>
            {i.sourceName && <span className="ml-1 text-ink-500">{i.sourceName}</span>}
            {i.documentUrl ? (
              <a
                href={i.documentUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="ml-1 text-ink-300 underline decoration-ink-700 underline-offset-2 hover:text-ink-100"
              >
                {i.documentTitle ?? 'Quelle'}
              </a>
            ) : i.documentTitle && <span className="ml-1 text-ink-300">{i.documentTitle}</span>}
            <div className="text-ink-400">{i.content}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DistillBriefingBlock({ briefing }: { briefing: DistillBriefing }) {
  return (
    <details
      className="rounded border border-l-2 border-ink-800 border-l-accent bg-ink-950"
      open
    >
      <summary className="cursor-pointer px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-ink-100">{briefing.briefingTypeName}</span>
          <span className="shrink-0 text-2xs text-ink-500">
            {dayDe(briefing.createdAt)} · {briefing.insightCount} Insights · {briefing.model}
            {briefing.costUsd !== null && (
              <span className="ml-1 font-mono tabular" title="Modellkosten dieses Briefings">
                · {briefing.costUsd.toFixed(4).replace('.', ',')} $
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 truncate text-2xs text-ink-500">{briefing.title}</div>
      </summary>
      <div className="border-t border-ink-800 px-3 py-2 text-xs leading-relaxed text-ink-200">
        {renderDistillBody(briefing.body, briefing.format)}
      </div>
    </details>
  );
}

/** Restricted markdown renderer — Distill emits `## headings`, `- bullets` and `**bold**`. */
function renderDistillBody(body: string, format: 'plain' | 'markdown'): React.ReactNode {
  const lines = body.split('\n');
  if (format === 'plain') {
    return lines.map((l, i) =>
      l.trim() === ''
        ? <div key={i} className="h-2" />
        : <p key={i} className="mt-1">{l}</p>,
    );
  }
  // markdown: handle `- ` bullets and `**bold**` inline emphasis
  const out: React.ReactNode[] = [];
  let bulletBuffer: string[] = [];
  const flushBullets = (key: number) => {
    if (bulletBuffer.length === 0) return;
    out.push(
      <ul key={`ul-${key}`} className="mt-1 list-disc space-y-0.5 pl-5">
        {bulletBuffer.map((b, j) => <li key={j}>{renderInlineBold(b)}</li>)}
      </ul>,
    );
    bulletBuffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      // The briefing is its own document and heads its sections with `##`.
      // Without this branch they rendered as the literal text "## Summary" —
      // the levels are collapsed to one visual weight here because a briefing
      // is flat: sections, never subsections.
      flushBullets(i);
      out.push(
        <p
          key={i}
          className="mt-3 text-xs font-semibold uppercase tracking-wider text-ink-400 first:mt-0"
        >
          {heading[2]}
        </p>,
      );
    } else if (trimmed.startsWith('- ')) {
      bulletBuffer.push(trimmed.slice(2));
    } else if (trimmed === '') {
      flushBullets(i);
      out.push(<div key={`gap-${i}`} className="h-2" />);
    } else {
      flushBullets(i);
      out.push(<p key={i} className="mt-1">{renderInlineBold(line)}</p>);
    }
  }
  flushBullets(lines.length);
  return out;
}

function renderInlineBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} className="font-semibold text-ink-50">{p.slice(2, -2)}</strong>
      : p,
  );
}

function SearchProviderBlock({ trace }: { trace: SearchProviderTrace }) {
  const meta = PROVIDER_META[trace.provider] ?? { label: trace.provider, tint: 'border-l-ink-600' };
  const isNative = trace.provider === 'claude-web-search' || trace.provider === 'openai-web-search';
  return (
    <details className={`rounded border border-l-2 border-ink-800 bg-ink-950 ${meta.tint}`}>
      <summary className="cursor-pointer px-3 py-1.5 text-xs">
        <span className="font-semibold text-ink-100">{meta.label}</span>
        <span className="ml-2 text-2xs text-ink-500">
          {trace.queries.length} {trace.queries.length === 1 ? 'Suchanfrage' : 'Suchanfragen'}
          {trace.results.length > 0 ? ` · ${trace.results.length} Treffer` : ' · beim Anbieter abgerufen'}
          {' · '}{timeDe(trace.fetchedAt)}
        </span>
      </summary>
      <div className="space-y-3 px-3 py-2 text-xs">
        {trace.queries.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-300">Suchanfragen</div>
            <ul className="list-disc pl-4 text-ink-300">
              {trace.queries.map((q, i) => (
                <li key={i} className="font-mono">{q}</li>
              ))}
            </ul>
          </div>
        )}

        {trace.results.length > 0 ? (
          <div>
            <div className="mb-1 text-xs font-semibold text-ink-300">Treffer</div>
            <ul className="space-y-1.5">
              {trace.results.slice(0, 20).map((r, i) => (
                <li key={i} className="rounded border border-ink-800 bg-ink-900 p-2">
                  <a href={r.url} target="_blank" rel="noopener noreferrer"
                     className="block truncate font-medium text-ink-100 hover:underline">
                    {r.title || r.url}
                  </a>
                  <div className="mt-0.5 truncate text-2xs text-ink-500">{r.url}</div>
                  {r.content && (
                    <div className="mt-1 line-clamp-3 text-2xs text-ink-400">{r.content}</div>
                  )}
                  {r.score !== undefined && (
                    <div className="mt-1 font-mono text-3xs text-ink-500">Relevanz {r.score.toFixed(3).replace('.', ',')}</div>
                  )}
                </li>
              ))}
            </ul>
            {trace.results.length > 20 && (
              <div className="mt-1 text-2xs text-ink-500">+ {trace.results.length - 20} weitere …</div>
            )}
          </div>
        ) : isNative ? (
          <div className="text-2xs italic text-ink-500">
            Eingebaute Suche des Modellanbieters — er ruft die Seiten selbst ab und gibt sie nicht heraus.
            Zu sehen sind nur die Suchanfragen.
          </div>
        ) : null}
      </div>
    </details>
  );
}
