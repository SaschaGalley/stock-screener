import type { SearchTrace, SearchProviderTrace } from '../../types';

interface Props {
  news: any[];
  perplexity: any;
  searches: SearchTrace | null;
}

/** Friendly label + accent shade per provider. Kept simple — these are debug
 *  bins, not user-facing branding. */
const PROVIDER_META: Record<SearchProviderTrace['provider'], { label: string; tint: string }> = {
  'tavily':              { label: 'Tavily',            tint: 'border-l-violet-500' },
  'brave':               { label: 'Brave',             tint: 'border-l-orange-500' },
  'claude-web-search':   { label: 'Claude web_search', tint: 'border-l-amber-500' },
  'openai-web-search':   { label: 'OpenAI web_search', tint: 'border-l-emerald-500' },
};

export default function NewsAndResearch({ news, perplexity, searches }: Props) {
  return (
    <div className="space-y-6">
      {perplexity && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Perplexity Research
            </h3>
            <span className="text-[10px] text-ink-600">
              {perplexity.model} · {new Date(perplexity.fetchedAt).toLocaleString()}
            </span>
          </div>
          <div className="prose-stock max-h-96 overflow-y-auto rounded border border-ink-800 bg-ink-950 p-3 text-xs">
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
