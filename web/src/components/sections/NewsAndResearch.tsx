interface Props {
  news: any[];
  perplexity: any;
}

export default function NewsAndResearch({ news, perplexity }: Props) {
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
