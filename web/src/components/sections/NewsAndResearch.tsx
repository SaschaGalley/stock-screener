import { useState, useEffect } from 'react';
import { api } from '../../api';
import type {
  SearchTrace,
  SearchProviderTrace,
  DistillBundle,
  DistillBriefing,
  DistillCacheState,
} from '../../types';

interface Props {
  symbol: string;
  news: any[];
  perplexity: any;
  distill: DistillBundle | null;
  searches: SearchTrace | null;
  /** Called after a successful Distill refresh so the parent can re-fetch
   *  the bundle and surface the new briefings + lastRefresh metadata. */
  onDistillRefreshed: () => void;
}

/** Friendly label + accent shade per provider. Kept simple — these are debug
 *  bins, not user-facing branding. */
const PROVIDER_META: Record<SearchProviderTrace['provider'], { label: string; tint: string }> = {
  'tavily':              { label: 'Tavily',            tint: 'border-l-violet-500' },
  'brave':               { label: 'Brave',             tint: 'border-l-orange-500' },
  'claude-web-search':   { label: 'Claude web_search', tint: 'border-l-amber-500' },
  'openai-web-search':   { label: 'OpenAI web_search', tint: 'border-l-emerald-500' },
};

export default function NewsAndResearch({ symbol, news, perplexity, distill, searches, onDistillRefreshed }: Props) {
  return (
    <div className="space-y-6">
      {/* Distill — top of the section because it's the most-weighted qualitative
          signal in the LLM prompt. Always rendered (even with zero briefings)
          so the user can trigger a first generation via the Refresh button. */}
      <DistillSection symbol={symbol} distill={distill} onRefreshed={onDistillRefreshed} />


      {perplexity && (
        <details className="rounded border border-ink-800 bg-ink-950" open>
          <summary className="cursor-pointer px-3 py-2 text-xs">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Perplexity Research
            </span>
            <span className="ml-2 text-[10px] text-ink-600">
              {perplexity.model} · {new Date(perplexity.fetchedAt).toLocaleString()}
            </span>
          </summary>
          <div className="border-t border-ink-800 px-3 py-2">
            <div className="prose-stock max-h-96 overflow-y-auto text-xs">
              {perplexity.synthesis.split('\n').map((line: string, i: number) => (
                <p key={i} className={line.startsWith('**') ? 'mt-3 font-semibold text-ink-100' : 'mt-1'}>
                  {line.replace(/\*\*/g, '')}
                </p>
              ))}
            </div>
            {perplexity.citations?.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] text-ink-500">
                  {perplexity.citations.length} sources
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4 text-[10px] text-ink-500">
                  {perplexity.citations.map((u: string, i: number) => (
                    <li key={i}><a href={u} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">{u}</a></li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </details>
      )}

      {/* Search Traces — one collapsible block per provider that ran. Persisted
          on the cached analysis so the user can audit what context the LLM saw
          (debug / provenance / "why did Claude get this wrong?"). Native
          providers expose only the queries because the actual fetched URLs are
          processed server-side by Anthropic/OpenAI and never reach our SDK. */}
      {searches && searches.providers.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Search Traces
            </h3>
            <span className="text-[10px] text-ink-600">
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
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">Recent News</h3>
          <ul className="space-y-2">
            {news.slice(0, 8).map((n, i) => (
              <li key={i} className="rounded border border-ink-800 bg-ink-950 p-2.5 text-xs">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink-100 hover:underline">
                  {n.headline}
                </a>
                <div className="mt-1 flex items-center justify-between text-[10px] text-ink-500">
                  <span>{n.source}</span>
                  <span>{new Date(n.datetime * 1000).toLocaleDateString()}</span>
                </div>
              </li>
            ))}
          </ul>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Persistent error states — once tripped, the button stays disabled with a
  // hint until the user fixes the upstream config (no point retrying).
  const [persistent, setPersistent] = useState<
    | { kind: 'read-only' }
    | { kind: 'unauthorized' }
    | { kind: 'ambiguous-type' }
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
      if (msg.includes('distill_read_only') || msg.includes('read-only')) {
        setPersistent({ kind: 'read-only' });
      } else if (msg.includes('distill_unauthorized')) {
        setPersistent({ kind: 'unauthorized' });
      } else if (msg.includes('distill_ambiguous_type')) {
        // Match the structured code only — substrings like 'default'/'Ambiguous'
        // tripped this refresh-disabling state on unrelated errors.
        setPersistent({ kind: 'ambiguous-type' });
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

  const last = distill?.lastRefresh;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Distill Briefing
        </h3>
        <div className="flex items-center gap-2">
          {last && <CacheStateBadge state={last.cacheState} />}
          {last && last.distillCostUsd > 0 && (
            <span
              className="font-mono text-[10px] text-ink-500 tabular"
              title="Cost of distill drain batches in this refresh"
            >
              +${last.distillCostUsd.toFixed(4)} distill
            </span>
          )}
          {distill?.fetchedAt && (
            <span className="text-[10px] text-ink-600">
              {new Date(distill.fetchedAt).toLocaleString()}
            </span>
          )}
          <RefreshButton busy={busy} disabled={!!persistent} onClick={handleRefresh} />
        </div>
      </div>

      {busy && (
        <div className="mb-2 rounded border border-accent/30 bg-accent-soft px-3 py-1.5 text-[11px] text-ink-300">
          ⟳ Refreshing… first-time tickers can take a few minutes while the
          backlog is distilled.
        </div>
      )}
      {error && (
        <div className="mb-2 rounded border border-amber-700 bg-amber-950 px-3 py-1.5 text-[11px] text-amber-300">
          ⚠ {error}
        </div>
      )}
      {persistent && (
        <PersistentHint
          kind={persistent.kind}
          detail={'detail' in persistent ? persistent.detail : undefined}
        />
      )}

      {briefing ? (
        <DistillBriefingBlock briefing={briefing} />
      ) : (
        <div className="rounded border border-dashed border-ink-800 px-3 py-2 text-[11px] text-ink-500">
          {last?.cacheState === 'empty-pool'
            ? 'No fresh insights available upstream — Distill has nothing new to summarise.'
            : 'No briefing cached yet — click Refresh to trigger one.'}
        </div>
      )}
    </div>
  );
}

function RefreshButton({ busy, disabled, onClick }: { busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title={disabled
        ? 'Refresh unavailable — see the hint below for the fix.'
        : 'Trigger a Distill refresh — drains pending insights and (re)generates the briefing.'}
      className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-[10px] font-medium text-ink-200 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? '⟳' : '↻'} Refresh
    </button>
  );
}

/** Persistent configuration-error hint. Once the user sees this, the fix is
 *  upstream (Distill admin or .env) — no point in retrying without action.
 *  `detail` replaces the canned copy when the server sent something specific. */
function PersistentHint({ kind, detail }: {
  kind: 'read-only' | 'unauthorized' | 'ambiguous-type' | 'entity-unresolved';
  detail?: string;
}) {
  const messages: Record<typeof kind, string> = {
    'read-only':
      'The configured Distill key is read-only. Mint a key with `briefings:write` scope in the Distill admin (Project → Access keys) to enable refresh.',
    'unauthorized':
      'Distill rejected the key as invalid. Check `DISTILL_API_KEY` in your .env and confirm the key still exists in the Distill admin.',
    'ambiguous-type':
      'The Distill project has multiple briefing types and no default — star one in the Distill admin (Project → Briefing-Typen) and the refresh will pick it up.',
    'entity-unresolved':
      'This ticker does not map to exactly one Distill entity. Add the ISIN or pick the entity in Distill — guessing would attach another company’s briefing.',
  };
  return (
    <div className="mt-1 text-[10px] italic text-ink-500">
      {detail ?? messages[kind]}
    </div>
  );
}

function CacheStateBadge({ state }: { state: DistillCacheState }) {
  const meta: Record<DistillCacheState, { label: string; cls: string; title: string }> = {
    'still-current': { label: 'still-current', cls: 'border-emerald-700 bg-emerald-900 text-emerald-400', title: 'Existing briefing still covers all fresh insights — no LLM call needed.' },
    'generated':     { label: 'generated',     cls: 'border-accent bg-accent-soft text-ink-200',          title: 'Fresh briefing was just generated (LLM call ran).' },
    'empty-pool':    { label: 'empty-pool',    cls: 'border-amber-700 bg-amber-950 text-amber-300',       title: 'No fresh insights available upstream — nothing to summarise.' },
    'unknown':       { label: 'unknown',       cls: 'border-ink-800 bg-ink-950 text-ink-500',             title: 'Server did not return a cache-state header.' },
  };
  const m = meta[state];
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${m.cls}`}
      title={m.title}
    >
      {m.label}
    </span>
  );
}

/**
 * A single Distill briefing. Open by default for the most-recent one to keep
 * the prominent signal visible without a click, collapsed for the rest. The
 * body is either plain text or Distill's restricted markdown subset (only
 * **bold** and `- bullet lists` — no headers, no code blocks). We render
 * inline rather than pulling in react-markdown to keep the bundle small.
 */
function DistillBriefingBlock({ briefing }: { briefing: DistillBriefing }) {
  return (
    <details
      className="rounded border border-l-2 border-ink-800 border-l-accent bg-ink-950"
      open
    >
      <summary className="cursor-pointer px-3 py-2 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-ink-100">{briefing.briefingTypeName}</span>
          <span className="shrink-0 text-[10px] text-ink-500">
            {briefing.createdAt.slice(0, 10)} · {briefing.insightCount} insights · {briefing.model}
            {briefing.costUsd !== null && (
              <span className="ml-1 font-mono tabular" title="LLM cost for this briefing">
                · ${briefing.costUsd.toFixed(4)}
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-ink-500">{briefing.title}</div>
      </summary>
      <div className="border-t border-ink-800 px-3 py-2 text-[12px] leading-relaxed text-ink-200">
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
          className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400 first:mt-0"
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
        <span className="ml-2 text-[10px] text-ink-500">
          {trace.queries.length} quer{trace.queries.length === 1 ? 'y' : 'ies'}
          {trace.results.length > 0 ? ` · ${trace.results.length} result${trace.results.length === 1 ? '' : 's'}` : ' · server-side fetch'}
          {' · '}{new Date(trace.fetchedAt).toLocaleString()}
        </span>
      </summary>
      <div className="space-y-3 px-3 py-2 text-[11px]">
        {trace.queries.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Queries</div>
            <ul className="list-disc pl-4 text-ink-300">
              {trace.queries.map((q, i) => (
                <li key={i} className="font-mono">{q}</li>
              ))}
            </ul>
          </div>
        )}

        {trace.results.length > 0 ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Results</div>
            <ul className="space-y-1.5">
              {trace.results.slice(0, 20).map((r, i) => (
                <li key={i} className="rounded border border-ink-800 bg-ink-900 p-2">
                  <a href={r.url} target="_blank" rel="noopener noreferrer"
                     className="block truncate font-medium text-ink-100 hover:underline">
                    {r.title || r.url}
                  </a>
                  <div className="mt-0.5 truncate text-[10px] text-ink-500">{r.url}</div>
                  {r.content && (
                    <div className="mt-1 line-clamp-3 text-[10px] text-ink-400">{r.content}</div>
                  )}
                  {r.score !== undefined && (
                    <div className="mt-1 font-mono text-[9px] text-ink-600">score {r.score.toFixed(3)}</div>
                  )}
                </li>
              ))}
            </ul>
            {trace.results.length > 20 && (
              <div className="mt-1 text-[10px] text-ink-600">+{trace.results.length - 20} more …</div>
            )}
          </div>
        ) : isNative ? (
          <div className="text-[10px] italic text-ink-500">
            Native provider — the LLM vendor fetched these URLs server-side and didn't surface them via the SDK.
            Only the issued queries are observable.
          </div>
        ) : null}
      </div>
    </details>
  );
}
