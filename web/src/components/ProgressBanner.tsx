import type { ProgressEvent } from '../types';

interface Props {
  events: ProgressEvent[];
  active: boolean;
}

const STAGE_ICON: Record<string, string> = {
  init:           '⏳',
  resolve:        '🔍',
  financials:     '📊',
  rates:          '🌐',
  'sector-medians': '👥',
  news:           '📰',
  perplexity:     '🤖',
  'market-signals': '📈',
  metrics:        '🧮',
  search:         '🔎',
  llm:            '🧠',
  edgar:          '📁',
  reports:        '📝',
  done:           '✓',
};

export default function ProgressBanner({ events, active }: Props) {
  if (events.length === 0 && !active) return null;
  const last = events[events.length - 1];

  return (
    <div className="border-b border-blue-900/50 bg-blue-950/30 px-4 py-2">
      <details>
        <summary className="cursor-pointer text-sm text-blue-200 list-none">
          <span className="mr-2">{STAGE_ICON[last?.stage ?? 'init'] ?? '·'}</span>
          {active && <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}
          <span className="font-medium">{last?.message ?? 'Starting…'}</span>
          <span className="ml-2 text-[11px] text-blue-400">▾ {events.length} steps</span>
        </summary>
        <ul className="mt-2 space-y-0.5 text-xs">
          {events.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-4 shrink-0 text-blue-400">{STAGE_ICON[e.stage] ?? '·'}</span>
              <span className="font-mono text-blue-300">[{e.stage}]</span>
              <span className="text-blue-200">{e.message}</span>
              {e.cached && <span className="rounded bg-emerald-900/50 px-1 text-[10px] text-emerald-300">cached</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
