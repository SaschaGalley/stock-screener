import { useState, useEffect } from 'react';
import {
  DEEP_RESEARCH_MODEL, DEFAULT_PERPLEXITY_MODEL, type PerplexityModelId, perplexityLabel,
} from '../../../../src/models';
import { ManualResearch, ResearchReports } from '../ManualResearch';
import { api } from '../../api';
import PerplexityBrief from './PerplexityBrief';
import { useFirst } from '../More';
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

export default function NewsAndResearch({ symbol, news, perplexity, deepResearch, pplx, distill, searches, onRefreshed }: Props) {
  const [firstNews, moreNews] = useFirst(news, 4, 'Meldungen');
  return (
    <div className="space-y-6">
      {/* Distill — top of the section because it's the most-weighted qualitative
          signal in the LLM prompt. Always rendered (even with zero briefings)
          so the user can trigger a first generation via the Refresh button. */}
      <DistillSection symbol={symbol} distill={distill} onRefreshed={onRefreshed} />

      {/* Also shown with nothing stored yet when Perplexity is selected, so a
          first synthesis can be fetched without running an analysis. */}
      {(perplexity || pplx) && (
        <PerplexitySection symbol={symbol} perplexity={perplexity} pplx={pplx} onRefreshed={onRefreshed} />
      )}

      <DeepResearchSection symbol={symbol} deep={deepResearch} onRefreshed={onRefreshed} />

      {/* Search Traces — one collapsible block per provider that ran. Persisted
          on the cached analysis so the user can audit what context the LLM saw
          (debug / provenance / "why did Claude get this wrong?"). Native
          providers expose only the queries because the actual fetched URLs are
          processed server-side by Anthropic/OpenAI and never reach our SDK. */}
      {searches && searches.providers.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-ink-300">
              Search Traces
            </h3>
            <span className="text-2xs text-ink-500">
              {searches.providers.length} provider{searches.providers.length === 1 ? '' : 's'} · debug context
            </span>
          </div>
          <div className="space-y-2">
            {searches.providers.map((p, i) => (
              <SearchProviderBlock key={`${p.provider}-${i}`} trace={p} />
            ))}
          </div>
        </div>
      )}

      {news.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-ink-300">Recent News</h3>
          <ul className="space-y-2">
            {firstNews.map((n, i) => (
              <li key={i} className="rounded border border-ink-800 bg-ink-950 p-2.5 text-xs">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink-100 hover:underline">
                  {n.headline}
                </a>
                <div className="mt-1 flex items-center justify-between text-2xs text-ink-500">
                  <span>{n.source}</span>
                  <span>{new Date(n.datetime * 1000).toLocaleDateString()}</span>
                </div>
              </li>
            ))}
          </ul>
          {moreNews}
        </div>
      )}
    </div>
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
      const msg = (e as Error).message ?? 'Refresh failed';
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

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-300">
          Distill Briefing
        </h3>
        <div className="flex items-center gap-2">
          {distill?.fetchedAt && (
            <span className="text-2xs text-ink-500">
              {new Date(distill.fetchedAt).toLocaleString()}
            </span>
          )}
          <RefreshButton busy={busy} disabled={!!persistent} onClick={handleRefresh} />
        </div>
      </div>

      {busy && (
        <div className="mb-2 rounded border border-accent/30 bg-accent-soft px-3 py-1.5 text-xs text-ink-300">
          ⟳ Refreshing… first-time tickers can take a few minutes while the
          backlog is distilled.
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
    </div>
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
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-300">
          Perplexity Research
        </h3>
        <div className="flex items-center gap-2">
          {perplexity && <BriefMeta context={perplexity} />}
          <RefreshButton
            busy={refresh.busy}
            disabled={false}
            onClick={refresh.run}
            title={`Perplexity neu abfragen (${perplexityLabel(model)}) — ohne Cache, kostet einen Aufruf.`}
          />
        </div>
      </div>

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
          oder ↻ Refresh sofort.
        </div>
      )}
    </div>
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
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-300">
          Deep Research
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {deep && <BriefMeta context={deep} />}
          <button
            onClick={start}
            disabled={refresh.busy}
            title={`Firmenbericht über die API: ${cost} — Dutzende Suchen, 3–5 Minuten.`}
            className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-2xs font-medium text-ink-400 transition hover:bg-ink-800 hover:text-ink-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {refresh.busy ? '⟳ läuft…' : 'API'}
          </button>
        </div>
      </div>

      {refresh.busy && <Busy>⟳ Deep Research läuft — Perplexity sucht und schreibt drei bis fünf Minuten. Die Seite kann offen bleiben.</Busy>}
      {refresh.error && <Failed>{refresh.error}</Failed>}
      <div className="mb-3">
        <ManualResearch
          kinds={['company', 'earnings', 'thesis']}
          symbols={[symbol]}
          replaces={(kind) => kind === 'company' && deep
            ? `Ersetzt den Bericht vom ${new Date(deep.fetchedAt).toLocaleDateString()} in den Analysen; der alte bleibt im Archiv.`
            : null}
          onSaved={(kind) => (kind === 'company' ? onRefreshed() : setTick((n) => n + 1))}
        />
      </div>

      {deep ? (
        <details className="rounded border border-ink-800 bg-ink-950 px-3 py-2" open>
          <summary className="cursor-pointer text-2xs text-ink-500">
            Firmenbericht vom {new Date(deep.fetchedAt).toLocaleDateString()} — geht in jede Analyse ein, solange er im Zeitfenster liegt
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
    </div>
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
      setError((e as Error).message ?? 'Refresh failed');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function BriefMeta({ context }: { context: PerplexityContext }) {
  return (
    <span className="text-2xs text-ink-500">
      {context.pastedFrom ? `${context.pastedFrom}, von Hand` : context.model} · {new Date(context.fetchedAt).toLocaleString()}
      {context.costUsd !== undefined && ` · ${context.costUsd.toFixed(2).replace('.', ',')} $`}
    </span>
  );
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
      <summary className="cursor-pointer text-2xs text-ink-500">{urls.length} sources</summary>
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
        ? 'Refresh unavailable — see the hint below for the fix.'
        : title ?? 'Trigger a Distill refresh — drains pending insights and (re)generates the briefing.'}
      className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-2xs font-medium text-ink-200 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? '⟳' : '↻'} Refresh
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
      'Distill rejected the key as invalid. Check `DISTILL_API_KEY` in your .env and confirm the key still exists in the Distill admin.',
    'entity-unresolved':
      'This ticker does not map to exactly one Distill entity. Add the ISIN or pick the entity in Distill — guessing would attach another company’s briefing.',
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
    ? `${block.periodStart.slice(0, 10)} – ${block.periodEnd.slice(0, 10)}`
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
            {block.stale && <span className="ml-1 text-ink-600" title="A late document landed in an already-built tile — the window above still holds.">· stale</span>}
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
      <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">
        Nicht im Dossier · {insights.length} roh
        {truncated && <span className="ml-1 font-normal normal-case tracking-normal text-ink-500">(gekappt — es gibt mehr)</span>}
      </div>
      <ul className="space-y-1">
        {insights.map((i) => (
          <li key={i.id} className="text-xs text-ink-400">
            <span className="font-mono text-ink-500">{i.at?.slice(0, 10) ?? '—'}</span>
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
            {briefing.createdAt.slice(0, 10)} · {briefing.insightCount} insights · {briefing.model}
            {briefing.costUsd !== null && (
              <span className="ml-1 font-mono tabular" title="LLM cost for this briefing">
                · ${briefing.costUsd.toFixed(4)}
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
          {trace.queries.length} quer{trace.queries.length === 1 ? 'y' : 'ies'}
          {trace.results.length > 0 ? ` · ${trace.results.length} result${trace.results.length === 1 ? '' : 's'}` : ' · server-side fetch'}
          {' · '}{new Date(trace.fetchedAt).toLocaleString()}
        </span>
      </summary>
      <div className="space-y-3 px-3 py-2 text-xs">
        {trace.queries.length > 0 && (
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">Queries</div>
            <ul className="list-disc pl-4 text-ink-300">
              {trace.queries.map((q, i) => (
                <li key={i} className="font-mono">{q}</li>
              ))}
            </ul>
          </div>
        )}

        {trace.results.length > 0 ? (
          <div>
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">Results</div>
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
                    <div className="mt-1 font-mono text-3xs text-ink-500">score {r.score.toFixed(3)}</div>
                  )}
                </li>
              ))}
            </ul>
            {trace.results.length > 20 && (
              <div className="mt-1 text-2xs text-ink-500">+{trace.results.length - 20} more …</div>
            )}
          </div>
        ) : isNative ? (
          <div className="text-2xs italic text-ink-500">
            Native provider — the LLM vendor fetched these URLs server-side and didn't surface them via the SDK.
            Only the issued queries are observable.
          </div>
        ) : null}
      </div>
    </details>
  );
}
