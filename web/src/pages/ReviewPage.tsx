import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Page from '../components/Page';
import Tip from '../components/Tip';
import { ManualResearch, ReportCard } from '../components/ManualResearch';
import { SearchIcon } from '../components/icons';
import { fmtSignedPct } from '../format';
import {
  decisionRight, REVIEW_FILTERS, REVIEW_SORTS,
  type ModelStance, type ReviewedDecision, type ReviewFilter, type ReviewSort,
} from '../../../src/analysis/review';
import { RECORD_HORIZONS } from '../../../src/analysis/verdict-record';
import type { ReviewPage as Page_ } from '../../../src/review-service';
import type { ResearchReport } from '../../../src/research/kinds';

type Check = Extract<ResearchReport, { kind: 'review' }>;

const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
const SIDE_LABEL = { buy: 'Kauf', sell: 'Verkauf' } as const;
const SIDE_BADGE = {
  buy:  'border-emerald-800 bg-emerald-950 text-emerald-400',
  sell: 'border-red-800 bg-red-950 text-red-400',
} as const;
const STANCE_LABEL: Record<ModelStance, string> = {
  with: 'mit dem Modell', against: 'gegen das Modell', neutral: 'Modell neutral', none: '',
};

/**
 * My purchases and sales looked back on, one line each: the day, the stock,
 * how the model saw it, and how it went against the S&P 500 one to twelve
 * months on, with the reason given under it. A click opens the rest — the
 * situation it was made in, the look-backs, a new one.
 *
 * It used to open with the statistics and then draw every decision as a card
 * with its own research form, all of them at once. The statistics are in the
 * evaluation now ("Meine Entscheidungen"); the list is searched, filtered,
 * sorted on the server and comes 25 at a time. See `analysis/review.ts`.
 */
export default function ReviewPage() {
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [sort, setSort] = useState<ReviewSort>('newest');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page_ | null>(null);
  const [decisions, setDecisions] = useState<ReviewedDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // The look-backs researched by hand, by the decision they look back on — newest first.
  const [checks, setChecks] = useState<Map<string, Check[]>>(new Map());

  const loadChecks = () => api.getResearch(undefined, 'review')
    .then((r) => {
      const by = new Map<string, Check[]>();
      for (const x of r.reports) {
        if (x.kind !== 'review' || !x.decision) continue;
        by.set(x.decision, [...(by.get(x.decision) ?? []), x]);
      }
      setChecks(by);
    })
    .catch(() => { /* the review stands without them */ });
  useEffect(() => { void loadChecks(); }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    setError(null);
    api.getReview({ q, filter, sort })
      .then((p) => { if (live) { setPage(p); setDecisions(p.decisions); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [q, filter, sort]);

  async function loadMore() {
    if (!page || page.next === null || more) return;
    setMore(true);
    try {
      const p = await api.getReview({ q, filter, sort, offset: page.next });
      setPage(p);
      setDecisions((prev) => [...prev, ...p.decisions]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  }

  const all = page?.counts.all ?? 0;
  const rest = page ? page.total - decisions.length : 0;

  return (
    <Page
      title="Rückblick"
      subtitle={page && page.counts.all > 0
        ? <>{all} {all === 1 ? 'Entscheidung' : 'Entscheidungen'} gegen den S&amp;P 500 · <a href="#/evaluation/decisions" className="text-accent hover:underline">Auswertung in Gruppen →</a></>
        : 'Meine Käufe und Verkäufe gegen den S&P 500'}
    >
      {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
      {!page && !error && <p className="p-8 text-center text-sm text-ink-500">Rechne nach …</p>}
      {page?.syncError && <p className="text-xs text-amber-300">⚠ {page.syncError}</p>}
      {page && page.counts.all === 0 && !q && (
        <p className="text-sm text-ink-500">
          Noch keine Käufe oder Verkäufe — weder im <a href="#/journal" className="text-accent hover:underline">Journal</a> noch aus umsatz.
        </p>
      )}

      {page && (page.counts.all > 0 || q) && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="relative w-full sm:w-64">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500"><SearchIcon size={14} /></span>
              <input
                type="search"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Aktie oder Begründung …"
                className="w-full rounded border border-ink-700 bg-ink-950 py-1.5 pl-8 pr-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-400">
              <span className="hidden sm:inline">Sortierung</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as ReviewSort)}
                className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 focus:border-accent focus:outline-none"
              >
                {REVIEW_SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REVIEW_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                disabled={f.key !== 'all' && page.counts[f.key] === 0}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition disabled:opacity-40 ${
                  filter === f.key ? 'border-ink-600 bg-ink-700 text-ink-50' : 'border-ink-800 text-ink-400 hover:text-ink-200'
                }`}
              >
                {f.label} <span className="font-mono text-ink-500">{page.counts[f.key]}</span>
              </button>
            ))}
          </div>

          {page.total === 0 && <p className="text-sm text-ink-500">Keine Entscheidung passt{q ? ` zu „${q}“` : ''}.</p>}
          <ul className="space-y-1.5">
            {decisions.map((d) => (
              <DecisionRow key={d.key} d={d} checks={checks.get(d.key) ?? []} onChecked={() => void loadChecks()} />
            ))}
          </ul>
          {page.next !== null && (
            <button
              onClick={() => void loadMore()}
              disabled={more}
              className="w-full rounded border border-dashed border-ink-700 py-2 text-sm text-ink-400 transition hover:border-ink-600 hover:text-ink-100 disabled:opacity-50"
            >
              {more ? 'Lade …' : `Weitere laden — noch ${rest} ${rest === 1 ? 'Entscheidung' : 'Entscheidungen'}`}
            </button>
          )}
        </>
      )}
    </Page>
  );
}

/** One decision in a line, the reason under it; a click opens the situation and the look-backs. */
function DecisionRow({ d, checks, onChecked }: { d: ReviewedDecision; checks: Check[]; onChecked: () => void }) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const s = d.situation;
  const flags = s?.flags.length ?? 0;
  const results = useMemo(() => RECORD_HORIZONS.map((h) => ({
    h, leg: d.outcome?.horizons[h], due: d.outcome?.due[h],
  })), [d]);

  return (
    <li className={`rounded border bg-ink-950 ${open ? 'border-ink-600' : 'border-ink-800'}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        className="cursor-pointer px-3 py-2 transition hover:bg-ink-900"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="w-20 shrink-0 font-mono text-sm text-ink-300">{fmtDay(d.day)}</span>
          <span className={`shrink-0 rounded border px-1.5 py-px text-2xs font-medium ${SIDE_BADGE[d.side]}`}>{SIDE_LABEL[d.side]}</span>
          <span className="min-w-0 truncate text-sm">
            {d.symbol
              ? <a href={`#/stock/${encodeURIComponent(d.symbol)}`} onClick={(e) => e.stopPropagation()} className="font-mono text-ink-100 hover:text-accent">{d.symbol}</a>
              : null}
            {d.name && <span className="ml-1.5 text-ink-500">{d.name}</span>}
          </span>
          {s?.verdict && (
            <span className={`shrink-0 text-xs ${s.stance === 'against' ? 'text-amber-300' : 'text-ink-500'}`}>
              {s.verdict}{s.stance !== 'none' && ` · ${STANCE_LABEL[s.stance]}`}
            </span>
          )}
          {flags > 0 && <span className="shrink-0 text-xs text-amber-300">⚠ {flags}</span>}
          {checks.length > 0 && <span className="shrink-0 text-xs text-ink-400">{checks.length} {checks.length === 1 ? 'Check' : 'Checks'}</span>}
          <span className="ml-auto flex shrink-0 flex-wrap gap-3 font-mono text-sm">
            {results.map(({ h, leg, due }) => {
              if (leg?.excess != null) {
                return (
                  <Tip key={h} focusable={false} content={`${h} ${h === 1 ? 'Monat' : 'Monate'}: Aktie ${fmtSignedPct(leg.stock)}, S&P 500 ${leg.index !== null ? fmtSignedPct(leg.index) : '—'}`}>
                    <span className={decisionRight(d.side, leg.excess) ? 'text-emerald-400' : 'text-red-400'}>
                      <span className="text-xs text-ink-600">{h}M </span>{fmtSignedPct(leg.excess, 0)}
                    </span>
                  </Tip>
                );
              }
              return due
                ? <Tip key={h} focusable={false} content={`gemessen ab ${fmtDay(due)}`}><span className="text-xs text-ink-700">{h}M ·</span></Tip>
                : null;
            })}
            {d.outcome?.since?.excess != null && (
              <Tip focusable={false} content="Von der Entscheidung bis heute, gegen den S&P 500">
                <span className="text-ink-400"><span className="text-xs text-ink-600">bisher </span>{fmtSignedPct(d.outcome.since.excess, 0)}</span>
              </Tip>
            )}
            {!d.outcome && <span className="text-xs text-ink-600">nicht messbar</span>}
          </span>
        </div>
        <div className={`mt-0.5 text-sm ${open ? '' : 'truncate'} ${d.reason ? 'text-ink-300' : 'text-ink-500'}`}>
          {d.reason ?? 'ohne Begründung'}
        </div>
      </div>

      {open && (
        <div className="space-y-2 border-t border-ink-800 px-3 py-2 text-sm">
          {!d.reason && (
            <p className="text-xs text-ink-500">Keine Begründung aufgeschrieben — <a href="#/journal" className="text-accent hover:underline">im Journal nachtragen</a>.</p>
          )}
          {s && s.flags.length > 0 && (
            <div>
              <h4 className="mb-0.5 text-xs font-semibold text-ink-300">Die Lage an dem Tag</h4>
              <ul className="space-y-0.5 text-xs text-amber-300">{s.flags.map((f) => <li key={f}>⚠ {f}</li>)}</ul>
            </div>
          )}
          {checks.length > 0 && (
            <div className="space-y-1.5">
              {checks.map((c) => (
                <ReportCard key={c.id} report={c} open={false} onDelete={async () => {
                  if (!window.confirm('Diesen Rückblick-Check löschen?')) return;
                  await api.deleteResearch(c.id).catch(() => undefined);
                  onChecked();
                }} />
              ))}
            </div>
          )}
          {d.symbol && (
            <div>
              <button onClick={() => setChecking((v) => !v)} className="text-xs text-ink-400 hover:text-ink-100">
                {checking ? '▾' : '▸'} {checks.length ? 'Neuer Rückblick-Check' : 'Rückblick-Check: hat die Begründung gehalten?'}
              </button>
              {checking && (
                <div className="mt-1.5">
                  <ManualResearch
                    kinds={['review']}
                    symbols={[d.symbol]}
                    decision={d.key}
                    onSaved={() => { setChecking(false); onChecked(); }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
