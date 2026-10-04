import { useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import { fmtSignedPct } from '../format';
import {
  JOURNAL_KINDS, JOURNAL_LABEL, JOURNAL_SINCE, linkMentions, mentionedSymbols, normalizeSymbols,
  type JournalEntry, type JournalInput, type JournalKind, type JournalMove,
} from '../../../src/journal';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const KIND_BADGE: Record<JournalKind, string> = {
  note: 'border-ink-700 bg-ink-800 text-ink-300',
  buy:  'border-emerald-800 bg-emerald-950 text-emerald-400',
  sell: 'border-red-800 bg-red-950 text-red-400',
};

/** Today in the browser's own calendar, not UTC's — at 1 a.m. they disagree. */
const today = () => new Date().toLocaleDateString('sv-SE');
const fmtDay = (day: string) => `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}`;
const fmtStamp = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const byNewest = (a: JournalEntry, b: JournalEntry) => b.day.localeCompare(a.day) || b.id - a.id;

const DRAFT_PREFIX = 'stockcli:journal-draft:';
const readDraft = (key: string) => { try { return localStorage.getItem(DRAFT_PREFIX + key) ?? ''; } catch { return ''; } };
const writeDraft = (key: string, body: string) => {
  try {
    if (body.trim()) localStorage.setItem(DRAFT_PREFIX + key, body); else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch { /* a draft is a convenience */ }
};

interface Props {
  /** Only the entries naming this stock, and new ones start out naming it. */
  symbol?: string;
  /** Tickers to offer while typing the stock field. */
  suggest?: string[];
  /** The editor open from the start rather than behind a button. */
  startOpen?: boolean;
}

/**
 * The journal: what I read, thought, bought and sold, and why — in my words,
 * as unstructured as it comes, with markdown where it helps.
 *
 * Each entry names its stocks, in the field or as `$TICKER` in the text, and
 * shows how each has moved since its day: the first half of learning from it.
 * An edit keeps the earlier wording one click away, because a reason rewritten
 * after the fact is hindsight.
 */
export default function Journal({ symbol, suggest, startOpen = false }: Props) {
  const [entries, setEntries] = useState<JournalEntry[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(startOpen);
  // Bumped after a save, so the editor starts over empty.
  const [fresh, setFresh] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [off, setOff] = useState<Set<JournalKind>>(() => new Set());
  const [search, setSearch] = useState('');

  useEffect(() => {
    let live = true;
    setEntries(undefined);
    setError(null);
    api.getJournal(symbol)
      .then((r) => { if (live) setEntries(r.entries); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [symbol]);

  const put = (e: JournalEntry) => setEntries((prev) => [...(prev ?? []).filter((x) => x.id !== e.id), e].sort(byNewest));

  async function remove(e: JournalEntry) {
    if (!window.confirm(`Eintrag vom ${fmtDay(e.day)} löschen?`)) return;
    try {
      await api.deleteJournal(e.id);
      setEntries((prev) => prev?.filter((x) => x.id !== e.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const counts = useMemo(() => {
    const c = new Map<JournalKind, number>();
    for (const e of entries ?? []) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [entries]);
  const needle = search.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !off.has(e.kind) && (!needle
    || e.body.toLowerCase().includes(needle) || e.symbols.some((s) => s.toLowerCase().includes(needle))));
  const toggle = (k: JournalKind) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="space-y-3">
      {composing ? (
        <Editor
          key={fresh}
          symbol={symbol}
          suggest={suggest}
          draftKey={symbol ?? '*'}
          submitLabel="Eintragen"
          onSave={async (input) => {
            put(await api.addJournal(input));
            writeDraft(symbol ?? '*', '');
            setFresh((n) => n + 1);
            if (!startOpen) setComposing(false);
          }}
          onCancel={startOpen ? undefined : () => setComposing(false)}
        />
      ) : (
        <button
          onClick={() => setComposing(true)}
          className="w-full rounded border border-dashed border-ink-700 px-3 py-2 text-left text-xs text-ink-400 transition hover:border-ink-600 hover:text-ink-200"
        >
          ＋ {symbol ? `Notiz, Kauf oder Verkauf zu ${symbol}` : 'Neuer Eintrag'}
        </button>
      )}

      {error && <p className="text-xs text-red-400">⚠ {error}</p>}
      {entries === undefined && !error && <p className="text-xs text-ink-500">Lade Journal …</p>}
      {entries && entries.length === 0 && (
        <p className="text-xs text-ink-500">
          {symbol
            ? `Noch nichts zu ${symbol} notiert.`
            : 'Noch keine Einträge. Schreib auf, was du gelesen hast, was du denkst, was du kaufst oder verkaufst — und warum.'}
        </p>
      )}

      {entries && entries.length > 3 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {JOURNAL_KINDS.filter((k) => counts.has(k)).map((k) => (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`rounded-full border px-2 py-0.5 text-xs transition ${
                off.has(k) ? 'border-ink-800 text-ink-600' : 'border-ink-700 bg-ink-950 text-ink-300'
              }`}
            >
              {JOURNAL_LABEL[k]} <span className="font-mono text-ink-500">{counts.get(k)}</span>
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Suchen …"
            className="ml-auto w-40 rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-xs text-ink-200 placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
          />
        </div>
      )}

      {entries && entries.length > 0 && shown.length === 0 && (
        <p className="text-xs text-ink-500">Kein Eintrag passt zu Filter und Suche.</p>
      )}

      <ByMonth entries={shown}>
        {(e) => editing === e.id ? (
          <Editor
            key={e.id}
            initial={e}
            suggest={suggest}
            submitLabel="Speichern"
            onSave={async (input) => {
              put(await api.editJournal(e.id, input));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <EntryCard entry={e} onEdit={() => setEditing(e.id)} onDelete={() => void remove(e)} />
        )}
      </ByMonth>
    </div>
  );
}

function ByMonth({ entries, children }: { entries: JournalEntry[]; children: (e: JournalEntry) => React.ReactNode }) {
  const groups: { month: string; entries: JournalEntry[] }[] = [];
  for (const e of entries) {
    const month = e.day.slice(0, 7);
    const g = groups[groups.length - 1];
    if (g && g.month === month) g.entries.push(e); else groups.push({ month, entries: [e] });
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.month}>
          <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">
            {MONTHS[Number(g.month.slice(5, 7)) - 1]} {g.month.slice(0, 4)}
          </h3>
          <div className="space-y-2 border-l border-ink-800 pl-3">
            {g.entries.map((e) => <div key={e.id}>{children(e)}</div>)}
          </div>
        </section>
      ))}
    </div>
  );
}

function EntryCard({ entry, onEdit, onDelete }: { entry: JournalEntry; onEdit: () => void; onDelete: () => void }) {
  const moves = new Map(entry.moves.map((m) => [m.symbol, m]));
  // Written down well after the day it is about: worth knowing when reading the reason.
  const written = entry.createdAt.slice(0, 10);
  const backdated = (Date.parse(written) - Date.parse(entry.day)) / 86_400_000 > 1;
  return (
    <article className="group rounded border border-ink-800 bg-ink-950 px-3 py-2">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-mono text-ink-400">{fmtDay(entry.day)}</span>
        <span className={`rounded border px-1.5 py-px text-2xs font-medium ${KIND_BADGE[entry.kind]}`}>{JOURNAL_LABEL[entry.kind]}</span>
        {entry.symbols.map((s) => <SymbolMove key={s} symbol={s} move={moves.get(s)} kind={entry.kind} />)}
        <span className="ml-auto flex gap-3 text-2xs sm:opacity-0 sm:transition sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <button onClick={onEdit} className="text-ink-400 hover:text-ink-100">Bearbeiten</button>
          <button onClick={onDelete} className="text-ink-500 hover:text-red-400">Löschen</button>
        </span>
      </header>
      <Markdown body={entry.body} />
      {(backdated || entry.revisions.length > 0) && (
        <footer className="mt-1.5 text-2xs text-ink-500">
          {backdated && <span>nachgetragen am {fmtDay(written)}</span>}
          {backdated && entry.revisions.length > 0 && <span> · </span>}
          {entry.revisions.length > 0 && <Revisions entry={entry} />}
        </footer>
      )}
    </article>
  );
}

function SymbolMove({ symbol, move, kind }: { symbol: string; move?: JournalMove; kind: JournalKind }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <a href={`#/stock/${encodeURIComponent(symbol)}`} className="font-mono text-ink-100 hover:text-accent">{symbol}</a>
      {move && (
        <span
          className={`font-mono text-2xs ${move.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
          title={`${JOURNAL_SINCE[kind]}: ${move.fromClose.toFixed(2)} am ${fmtDay(move.fromDay)} → ${move.toClose.toFixed(2)} am ${fmtDay(move.toDay)}, Dividenden eingerechnet, wo vorhanden`}
        >
          {fmtSignedPct(move.change)}
        </span>
      )}
    </span>
  );
}

function Revisions({ entry }: { entry: JournalEntry }) {
  const n = entry.revisions.length;
  return (
    <details className="inline">
      <summary className="inline cursor-pointer hover:text-ink-300">
        bearbeitet am {fmtStamp(entry.updatedAt)} · {n} frühere Fassung{n > 1 ? 'en' : ''}
      </summary>
      <ol className="mt-2 space-y-2 border-l border-ink-800 pl-3">
        {[...entry.revisions].reverse().map((r) => (
          <li key={r.savedAt}>
            <div>
              Fassung bis {fmtStamp(r.savedAt)} · {fmtDay(r.day)} · {JOURNAL_LABEL[r.kind]}
              {r.symbols.length > 0 && ` · ${r.symbols.join(', ')}`}
            </div>
            <Markdown body={r.body} muted />
          </li>
        ))}
      </ol>
    </details>
  );
}

function Markdown({ body, muted = false }: { body: string; muted?: boolean }) {
  return (
    <div className={`prose-stock mt-1 text-sm leading-relaxed ${muted ? 'opacity-70' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Stock links stay in the app; everything else opens beside it.
          a: ({ href, children }) => href?.startsWith('#')
            ? <a href={href}>{children}</a>
            : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
        }}
      >
        {linkMentions(body)}
      </ReactMarkdown>
    </div>
  );
}

function Editor({ initial, symbol, suggest, draftKey, submitLabel, onSave, onCancel }: {
  initial?: JournalEntry;
  symbol?: string;
  suggest?: string[];
  /** Where an unsaved new entry is kept, so leaving the page does not lose it. */
  draftKey?: string;
  submitLabel: string;
  onSave: (input: JournalInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const listId = useId();
  const [day, setDay] = useState(initial?.day ?? today());
  const [kind, setKind] = useState<JournalKind>(initial?.kind ?? 'note');
  const [body, setBody] = useState(() => initial?.body ?? (draftKey ? readDraft(draftKey) : ''));
  // The field holds the stocks named outright; those mentioned as $TICKER in
  // the text are read from it and shown beside the field, not copied into it.
  const [field, setField] = useState(() => {
    if (!initial) return symbol ?? '';
    const inText = new Set(mentionedSymbols(initial.body));
    return initial.symbols.filter((s) => !inText.has(s)).join(' ');
  });
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (draftKey) writeDraft(draftKey, body); }, [draftKey, body]);

  // Opened on purpose — an edit, or the button — so the cursor goes in at
  // once, and at the end: an edit is mostly an addition.
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textRef.current;
    if (!el || !(initial || onCancel)) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const named = normalizeSymbols(field.split(/[\s,;]+/));
  const fromText = mentionedSymbols(body).filter((s) => !named.includes(s));
  const needsStock = kind !== 'note' && named.length + fromText.length === 0;

  async function save() {
    if (busy || !body.trim() || needsStock) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ day, kind, symbols: named, body });
      if (draftKey) writeDraft(draftKey, '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded border border-ink-700 bg-ink-900 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded border border-ink-700">
          {JOURNAL_KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-2.5 py-1 text-xs transition ${
                k === kind ? 'bg-ink-700 font-medium text-ink-50' : 'bg-ink-950 text-ink-400 hover:text-ink-200'
              }`}
            >
              {JOURNAL_LABEL[k]}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={day}
          max={today()}
          onChange={(e) => setDay(e.target.value)}
          className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 [color-scheme:dark] focus:border-ink-500 focus:outline-none"
        />
        <input
          value={field}
          onChange={(e) => setField(e.target.value.toUpperCase())}
          list={suggest ? listId : undefined}
          placeholder="Aktien, z. B. NOW MSFT"
          className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-200 placeholder:font-sans placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
        />
        {suggest && <datalist id={listId}>{suggest.map((s) => <option key={s} value={s} />)}</datalist>}
      </div>
      {fromText.length > 0 && (
        <p className="text-2xs text-ink-500">Aus dem Text verknüpft: <span className="font-mono text-ink-300">{fromText.join(' ')}</span></p>
      )}

      {preview ? (
        <div className="min-h-[6rem] rounded border border-ink-800 bg-ink-950 px-3 py-2">
          {body.trim() ? <Markdown body={body} /> : <p className="text-xs text-ink-600">Nichts zu zeigen.</p>}
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}
          rows={Math.min(16, Math.max(4, body.split('\n').length + 1))}
          ref={textRef}
          placeholder={kind === 'note'
            ? 'Was hast du gelesen, was denkst du? Markdown geht, $TICKER verknüpft die Aktie.'
            : `Warum ${kind === 'buy' ? 'kaufst' : 'verkaufst'} du — und was müsste passieren, damit du falsch liegst?`}
          className="w-full resize-y rounded border border-ink-700 bg-ink-950 px-3 py-2 text-sm leading-relaxed text-ink-100 placeholder:text-ink-600 focus:border-ink-500 focus:outline-none"
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy || !body.trim() || needsStock}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-ink-950 transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Speichere …' : submitLabel}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="rounded px-2 py-1 text-xs text-ink-400 hover:text-ink-200">Abbrechen</button>
        )}
        <button onClick={() => setPreview((p) => !p)} className="rounded px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
          {preview ? 'Schreiben' : 'Vorschau'}
        </button>
        <span className="ml-auto text-2xs text-ink-600">
          {needsStock ? 'Welche Aktie?' : '⌘/Strg + Enter speichert'}
        </span>
        {error && <span className="w-full text-xs text-red-400">⚠ {error}</span>}
      </div>
    </div>
  );
}
