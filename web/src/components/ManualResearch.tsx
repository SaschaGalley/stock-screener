import { useEffect, useState } from 'react';
import { api } from '../api';
import { MANUAL_RESEARCH_TOOLS, type ManualResearchTool } from '../../../src/models';
import {
  RESEARCH_KIND_META, REVIEW_CAUSE_LABEL, REVIEW_VERDICT_LABEL, THEME_POSITION_LABEL, THESIS_VERDICT_LABEL,
  type ResearchKind, type ResearchPasteSummary, type ResearchReport, type ReviewVerdict, type ThesisVerdict,
} from '../../../src/research/kinds';

/**
 * Research run by hand: pick what to ask, copy the prompt into a chat app's
 * research mode, paste the answer back. What the answer was read as shows
 * before it is kept.
 */
export function ManualResearch({ kinds, symbols, question, decision, replaces, onSaved }: {
  kinds: ResearchKind[];
  symbols: string[];
  /** For a theme: the question asked across the stocks. */
  question?: string;
  /** For a review: the decision it looks back on. */
  decision?: string;
  /** A line on what keeping the answer replaces, when it does. */
  replaces?: (kind: ResearchKind) => string | null;
  onSaved: (kind: ResearchKind) => void;
}) {
  const [kind, setKind] = useState<ResearchKind>(kinds[0]);
  const [pasting, setPasting] = useState(false);
  const [copied, setCopied] = useState(false);
  // The prompt, shown to copy by hand where the browser refuses the clipboard.
  const [promptText, setPromptText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = symbols.join(',');
  useEffect(() => { setPasting(false); setPromptText(null); setError(null); }, [key]);
  const ready = symbols.length > 0 && (RESEARCH_KIND_META[kind].scope === 'one' || !!question?.trim());

  async function copy() {
    setError(null);
    try {
      const { prompt } = await api.getResearchPrompt(kind, symbols, { question, decision });
      try {
        await navigator.clipboard.writeText(prompt);
        setPromptText(null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        setPromptText(prompt);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {kinds.length > 1 && (
          <div className="flex overflow-hidden rounded border border-ink-700">
            {kinds.map((k) => (
              <button
                key={k}
                onClick={() => { setKind(k); setPromptText(null); setError(null); }}
                title={RESEARCH_KIND_META[k].hint}
                className={`px-2 py-1 text-2xs transition ${
                  k === kind ? 'bg-ink-700 font-medium text-ink-50' : 'bg-ink-950 text-ink-400 hover:text-ink-200'
                }`}
              >
                {RESEARCH_KIND_META[k].label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => void copy()}
          disabled={!ready}
          title="Für den Research-Modus von Perplexity, ChatGPT, Claude oder Gemini"
          className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-2xs font-medium text-ink-200 transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copied ? '✓ Kopiert' : 'Prompt kopieren'}
        </button>
        <button
          onClick={() => setPasting((p) => !p)}
          disabled={!ready}
          className={`rounded border px-2 py-1 text-2xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
            pasting ? 'border-ink-600 bg-ink-700 text-ink-50' : 'border-ink-700 bg-ink-900 text-ink-200 hover:bg-ink-800'
          }`}
        >
          Ergebnis einfügen
        </button>
      </div>
      {kinds.length > 1 && <p className="text-2xs text-ink-500">{RESEARCH_KIND_META[kind].hint}</p>}
      {error && <p className="text-2xs text-amber-300">⚠ {error}</p>}
      {promptText && (
        <div>
          <div className="mb-1 flex items-center justify-between text-2xs text-ink-500">
            <span>Die Zwischenablage ist gesperrt — hier markieren und kopieren:</span>
            <button onClick={() => setPromptText(null)} className="text-ink-400 hover:text-ink-200">Schließen</button>
          </div>
          <textarea
            readOnly
            value={promptText}
            rows={8}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-2xs text-ink-300"
          />
        </div>
      )}
      {pasting && ready && (
        <PasteAnswer
          key={`${kind}|${key}`}
          kind={kind}
          symbols={symbols}
          question={question}
          decision={decision}
          replaces={replaces?.(kind) ?? null}
          onSaved={() => { setPasting(false); onSaved(kind); }}
        />
      )}
    </div>
  );
}

function PasteAnswer({ kind, symbols, question, decision, replaces, onSaved }: {
  kind: ResearchKind;
  symbols: string[];
  question?: string;
  decision?: string;
  replaces: string | null;
  onSaved: () => void;
}) {
  const [tool, setTool] = useState<ManualResearchTool>(MANUAL_RESEARCH_TOOLS[0]);
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<ResearchPasteSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = (save: boolean) => ({ kind, symbols, question, decision, text, tool, save });

  // Read as it is pasted, so what was found shows before anything is kept.
  useEffect(() => {
    setSummary(null);
    setError(null);
    if (!text.trim()) return;
    let live = true;
    const t = setTimeout(() => {
      api.pasteResearch(input(false))
        .then((r) => { if (live) setSummary(r.summary); })
        .catch((e) => { if (live) setError((e as Error).message); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, tool]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.pasteResearch(input(true));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-ink-700 bg-ink-900 p-3">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-500">
        <span>{RESEARCH_KIND_META[kind].label} · Antwort aus</span>
        <div className="flex overflow-hidden rounded border border-ink-700">
          {MANUAL_RESEARCH_TOOLS.map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={`px-2 py-0.5 text-2xs transition ${
                t === tool ? 'bg-ink-700 font-medium text-ink-50' : 'bg-ink-950 text-ink-400 hover:text-ink-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        autoFocus
        placeholder="Die komplette Antwort hier einfügen — das JSON samt Codeblock, oder den Bericht, wenn das Werkzeug keinen JSON geschrieben hat."
        className="w-full resize-y rounded border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-2xs text-ink-200 placeholder:font-sans placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={!summary || saving}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink-950 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Speichere …' : 'Übernehmen'}
        </button>
        {summary && (
          <span className="text-2xs text-ink-400">
            Erkannt: {summary.structured ? summary.found.join(' · ') : 'kein JSON gefunden — wird als Bericht in Textform übernommen'}
            {summary.sources > 0 && ` · ${summary.sources} ${summary.sources === 1 ? 'Quelle' : 'Quellen'}`}
          </span>
        )}
        {error && <span className="text-2xs text-amber-300">⚠ {error}</span>}
      </div>
      {replaces && <p className="text-2xs text-ink-600">{replaces}</p>}
    </div>
  );
}

// ── Reading reports back ─────────────────────────────────────────────────────

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

/**
 * The research reports naming `symbol` — or, without one, all of `kinds` —
 * newest first, the newest open.
 */
export function ResearchReports({ symbol, kinds, tick, title }: {
  symbol?: string;
  kinds?: ResearchKind[];
  /** Bumped after a save, so the list is read again. */
  tick: number;
  title: string;
}) {
  const [reports, setReports] = useState<ResearchReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getResearch(symbol)
      .then((r) => { if (live) setReports(r.reports.filter((x) => !kinds || kinds.includes(x.kind))); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tick]);

  async function remove(r: ResearchReport) {
    if (!window.confirm(`${RESEARCH_KIND_META[r.kind].label} vom ${fmtDay(r.createdAt)} löschen?`)) return;
    try {
      await api.deleteResearch(r.id);
      setReports((prev) => prev?.filter((x) => x.id !== r.id) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <p className="text-2xs text-red-400">⚠ {error}</p>;
  if (!reports || reports.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{title}</h4>
      {reports.map((r, i) => <ReportCard key={r.id} report={r} open={i === 0} onDelete={() => void remove(r)} />)}
    </div>
  );
}

/** One report, collapsible, with its kind, tool and day on the summary line. */
export function ReportCard({ report: r, open, onDelete }: { report: ResearchReport; open: boolean; onDelete: () => void }) {
  return (
    <details open={open} className="group rounded border border-ink-800 bg-ink-950 px-3 py-2">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-ink-200">{RESEARCH_KIND_META[r.kind].label}</span>
        {r.question && <span className="text-ink-300">„{r.question}“</span>}
        {r.kind === 'theme' && <span className="font-mono text-2xs text-ink-500">{r.symbols.join(' ')}</span>}
        {r.kind === 'review' && r.data && (
          <span className={`rounded border px-1.5 py-px text-2xs ${REVIEW_BADGE[r.data.verdict]}`}>{REVIEW_VERDICT_LABEL[r.data.verdict]}</span>
        )}
        <span className="text-2xs text-ink-500">{r.tool} · {fmtDay(r.createdAt)}</span>
        <button
          onClick={(e) => { e.preventDefault(); onDelete(); }}
          className="ml-auto text-2xs text-ink-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
        >
          Löschen
        </button>
      </summary>
      <div className="mt-2 text-xs leading-relaxed text-ink-300">
        <ReportBody report={r} />
      </div>
    </details>
  );
}

const REVIEW_BADGE: Record<ReviewVerdict, string> = {
  held:      'border-emerald-800 bg-emerald-950 text-emerald-400',
  partly:    'border-amber-800 bg-amber-950 text-amber-300',
  failed:    'border-red-800 bg-red-950 text-red-400',
  too_early: 'border-ink-700 bg-ink-800 text-ink-400',
};

function ReportBody({ report: r }: { report: ResearchReport }) {
  if (!r.data) return <div className="whitespace-pre-wrap">{r.raw}</div>;
  if (r.kind === 'review') {
    const d = r.data;
    return (
      <div className="space-y-2">
        <p className="text-ink-400">{REVIEW_CAUSE_LABEL[d.cause]}</p>
        {d.lesson && <p className="rounded border border-accent/30 bg-accent-soft px-2 py-1 text-ink-100"><span className="font-medium">Lehre:</span> {d.lesson}</p>}
        {d.reasonCheck && <Block title="Die Begründung im Nachhinein"><p>{d.reasonCheck}</p></Block>}
        {d.drivers && <Block title="Was die Aktie tatsächlich bewegt hat"><p>{d.drivers}</p></Block>}
        {d.now && <Block title="Gilt der Grund heute noch?"><p>{d.now}</p></Block>}
        {d.whatHappened.length > 0 && (
          <Block title="Was seitdem passiert ist">
            <ul>{d.whatHappened.map((w, i) => (
              <li key={i}>{w.date && <span className="font-mono text-ink-400">{w.date} </span>}{w.event}{w.effect && <span className="text-ink-500"> — {w.effect}</span>} <Source url={w.source} /></li>
            ))}</ul>
          </Block>
        )}
      </div>
    );
  }
  if (r.kind === 'earnings') {
    const d = r.data;
    return (
      <div className="space-y-2">
        {(d.reportDate || d.impliedMove) && (
          <p className="text-ink-400">
            {d.reportDate && <>Termin {new Date(`${d.reportDate}T12:00:00`).toLocaleDateString('de-DE')}</>}
            {d.reportDate && d.impliedMove && ' · '}
            {d.impliedMove && <>Optionen preisen {d.impliedMove} ein</>}
          </p>
        )}
        {d.bar && <Block title="Wo die Latte liegt"><p>{d.bar}</p></Block>}
        {d.watch.length > 0 && (
          <Block title="Worauf es ankommt">
            <ul className="space-y-1.5">
              {d.watch.map((w, i) => (
                <li key={i}>
                  <span className="font-medium text-ink-100">{w.item}</span> — {w.why}
                  {(w.bullIf || w.bearIf) && (
                    <div className="text-2xs">
                      {w.bullIf && <span className="text-emerald-400">▲ {w.bullIf}</span>}
                      {w.bullIf && w.bearIf && <span className="text-ink-600"> · </span>}
                      {w.bearIf && <span className="text-red-400">▼ {w.bearIf}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Block>
        )}
        {d.consensus.length > 0 && (
          <Block title="Konsens">
            <ul>{d.consensus.map((c, i) => <li key={i}>{c.metric}: <span className="text-ink-100">{c.value}</span> <Source url={c.source} /></li>)}</ul>
          </Block>
        )}
        {d.history.length > 0 && (
          <Block title="Die letzten Meldungen">
            <ul>{d.history.map((h, i) => <li key={i}><span className="font-mono text-ink-400">{h.period}</span> {h.result}{h.reaction && <span className="text-ink-500"> — Reaktion {h.reaction}</span>}</li>)}</ul>
          </Block>
        )}
        {d.risks.length > 0 && (
          <Block title="Risiken">
            <ul>{d.risks.map((x, i) => <li key={i}>{x.risk} <Source url={x.source} /></li>)}</ul>
          </Block>
        )}
      </div>
    );
  }
  if (r.kind === 'thesis') {
    const d = r.data;
    return (
      <div className="space-y-2">
        <ul className="space-y-2">
          {d.theses.map((t, i) => (
            <li key={i}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={`rounded border px-1.5 py-px text-2xs font-medium ${VERDICT_BADGE[t.verdict]}`}>{THESIS_VERDICT_LABEL[t.verdict]}</span>
                <span className="font-medium text-ink-100">{t.thesis}</span>
              </div>
              {t.against && <p className="mt-0.5"><span className="text-red-400">Dagegen:</span> {t.against}</p>}
              {t.for && <p><span className="text-emerald-400">Dafür:</span> {t.for}</p>}
              {t.wouldChange && <p className="text-ink-500">Entscheidet: {t.wouldChange}</p>}
              {t.sources.length > 0 && <p className="text-2xs">{t.sources.map((u, k) => <Source key={k} url={u} />)}</p>}
            </li>
          ))}
        </ul>
        {d.missed.length > 0 && (
          <Block title="Was deine Einträge nicht bedenken">
            <ul>{d.missed.map((m, i) => <li key={i}>{m.point} <Source url={m.source} /></li>)}</ul>
          </Block>
        )}
      </div>
    );
  }
  const d = r.data;
  return (
    <div className="space-y-2">
      {d.answer && <p className="text-ink-100">{d.answer}</p>}
      {d.companies.length > 0 && (
        <ul className="space-y-1.5">
          {d.companies.map((c, i) => (
            <li key={i}>
              <a href={`#/stock/${encodeURIComponent(c.ticker)}`} className="font-mono text-ink-100 hover:text-accent">{c.ticker}</a>
              <span className="ml-2 text-2xs text-ink-400">{THEME_POSITION_LABEL[c.position]}</span>
              {c.strengths && <p><span className="text-emerald-400">Stärken:</span> {c.strengths}</p>}
              {c.weaknesses && <p><span className="text-red-400">Schwächen:</span> {c.weaknesses}</p>}
              {c.evidence && <p className="text-ink-500">{c.evidence} <Source url={c.source} /></p>}
            </li>
          ))}
        </ul>
      )}
      {d.uncertainties.length > 0 && (
        <Block title="Was es entscheidet">
          <ul>{d.uncertainties.map((u, i) => <li key={i}>{u.question}{u.settles && <span className="text-ink-500"> — {u.settles}{u.when && `, ${u.when}`}</span>}</li>)}</ul>
        </Block>
      )}
      {d.watch.length > 0 && (
        <Block title="Termine">
          <ul>{d.watch.map((w, i) => <li key={i}>{w.date && <span className="font-mono text-ink-400">{w.date} </span>}{w.event}{w.why && <span className="text-ink-500"> — {w.why}</span>}</li>)}</ul>
        </Block>
      )}
    </div>
  );
}

const VERDICT_BADGE: Record<ThesisVerdict, string> = {
  supported:    'border-emerald-800 bg-emerald-950 text-emerald-400',
  mixed:        'border-amber-800 bg-amber-950 text-amber-300',
  contradicted: 'border-red-800 bg-red-950 text-red-400',
  untestable:   'border-ink-700 bg-ink-800 text-ink-400',
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">{title}</div>
      {children}
    </div>
  );
}

function Source({ url }: { url: string | null }) {
  if (!url) return null;
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* shown as given */ }
  return <a href={url} target="_blank" rel="noreferrer noopener" className="mr-1 text-2xs text-accent hover:underline">{host}</a>;
}
