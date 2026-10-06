import { useId, useState } from 'react';
import Journal from '../components/Journal';
import { ManualResearch, ResearchReports } from '../components/ManualResearch';
import Page from '../components/Page';
import { normalizeSymbols } from '../../../src/journal';
import { RESEARCH_KIND_META } from '../../../src/research/kinds';

/**
 * The whole journal on one page, newest first: every note, purchase and sale,
 * whichever stocks it names — or none, for a thought about the market. And
 * the questions that span several stocks, researched by hand.
 */
export default function JournalPage({ symbols }: { symbols: string[] }) {
  return (
    <Page title="Journal" subtitle="Was ich gelesen, gedacht, gekauft und verkauft habe — und warum" width="max-w-3xl">
      <ThemeResearch suggest={symbols} />
      <Journal suggest={symbols} startOpen />
    </Page>
  );
}

/**
 * A question across several stocks — who wins the AI race, whose margins
 * survive the tariff — run in a chat app's research mode. The answer shows
 * here and on the page of every stock it names.
 */
function ThemeResearch({ suggest }: { suggest: string[] }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [tickers, setTickers] = useState('');
  const [tick, setTick] = useState(0);
  const named = normalizeSymbols(tickers.split(/[\s,;]+/));

  return (
    <section className="space-y-2 rounded border border-ink-800 bg-ink-900 px-3 py-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-baseline gap-2 text-left">
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-400">{open ? '▾' : '▸'} {RESEARCH_KIND_META.theme.label}</span>
        <span className="text-2xs text-ink-600">{RESEARCH_KIND_META.theme.hint}</span>
      </button>
      {open && (
        <div className="space-y-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Die Frage, z. B. Wer gewinnt das KI-Rennen — und wer verliert dabei Marge?"
            className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
          />
          <input
            value={tickers}
            onChange={(e) => setTickers(e.target.value.toUpperCase())}
            list={listId}
            placeholder="Aktien, z. B. GOOGL MSFT NVDA"
            className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-200 placeholder:font-sans placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
          />
          <datalist id={listId}>{suggest.map((s) => <option key={s} value={s} />)}</datalist>
          <ManualResearch kinds={['theme']} symbols={named} question={question} onSaved={() => setTick((n) => n + 1)} />
        </div>
      )}
      <ResearchReports kinds={['theme']} tick={tick} title="Bisherige Themen" />
    </section>
  );
}
