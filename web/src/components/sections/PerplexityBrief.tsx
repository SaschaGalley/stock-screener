import type { PerplexityContext } from '../../types';

type Findings = NonNullable<PerplexityContext['findings']>;
type Claim = Findings['bullClaims'][number];
type Finding = Findings['events'][number];

/**
 * A Perplexity brief, laid out by its structure.
 *
 * The stored markdown is what the models read; a reader needs more than that
 * gives them. The debate comes first because it is what the rest is for, each
 * claim keeps its argument beneath it, and the grade sits where the eye lands.
 * Rows from before the structured brief fall back to the markdown, and a list
 * an older brief never asked for is not shown as empty.
 */
export default function PerplexityBrief({ context }: { context: PerplexityContext }) {
  const f = context.findings;
  if (!f) return <Markdownish text={context.synthesis} />;

  return (
    <div className="space-y-4 text-xs">
      {f.debate && f.debate.length > 0 && (
        <Block title="Kerndebatte">
          <ul className="space-y-2">
            {f.debate.map((d, i) => (
              <li key={i} className="rounded border border-l-2 border-ink-800 border-l-accent bg-ink-900/40 px-2.5 py-2">
                <div className="font-semibold text-ink-100">{d.question}</div>
                {d.why && <p className="mt-1 text-ink-300">{d.why}</p>}
                {d.settles && (
                  <p className="mt-1 text-ink-400">
                    <Label>Entscheidet</Label>{d.settles}
                    {d.when && <span className="ml-1 font-mono text-ink-500">· {d.when}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Ereignisse" empty={f.events.length === 0 && 'Keine Ereignisse, die den Ausblick verändern.'}>
        <FindingList items={f.events} />
      </Block>

      {f.kpis && (
        <Block title="Operative Kennzahlen" empty={f.kpis.length === 0 && 'Keine berichteten Kennzahlen jenseits der Abschlüsse gefunden.'}>
          <ul className="space-y-2">
            {f.kpis.map((k, i) => (
              <li key={i}>
                <div className="font-semibold text-ink-200">{k.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1.5">
                  {k.values.map((v, j) => (
                    <span key={j} className="rounded bg-ink-900 px-1.5 py-0.5 text-ink-300">
                      <span className="font-mono text-ink-500">{v.period}</span> {v.value}
                    </span>
                  ))}
                </div>
                {k.read && <p className="mt-1 text-ink-400">{k.read}</p>}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Belege gegen die Bullen-These"
        empty={f.bearEvidence.length === 0 && 'Keine spezifischen Gegenbelege gefunden — das ist eine Aussage, keine Lücke.'}>
        <FindingList items={f.bearEvidence} />
      </Block>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Bullen-Thesen, geprüft" empty={f.bullClaims.length === 0 && 'Keine Bullen-Thesen im Umlauf gefunden.'}>
          <ClaimList claims={f.bullClaims} />
        </Block>
        {f.bearClaims && (
          <Block title="Bären-Thesen, geprüft" empty={f.bearClaims.length === 0 && 'Keine Bären-Thesen im Umlauf gefunden.'}>
            <ClaimList claims={f.bearClaims} />
          </Block>
        )}
      </div>

      {f.catalysts && (
        <Block title="Termine" empty={f.catalysts.length === 0 && 'Keine datierten Termine gefunden.'}>
          <ul className="space-y-1">
            {f.catalysts.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-20 shrink-0 font-mono text-ink-500">{c.date ?? '—'}</span>
                <span className="text-ink-300">
                  <span className="font-semibold text-ink-200">{c.event}</span>
                  {c.watch && <> — {c.watch}</>}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}

const GRADE: Record<Claim['evidence'], { label: string; cls: string }> = {
  'independent':     { label: 'unabhängig belegt',      cls: 'border-emerald-800 bg-emerald-950 text-emerald-300' },
  'management-only': { label: 'nur Management-Aussage', cls: 'border-amber-800 bg-amber-950 text-amber-300' },
  'opinion':         { label: 'bisher nur Meinung',     cls: 'border-amber-800 bg-amber-950 text-amber-300' },
  'contradicted':    { label: 'widerlegt',              cls: 'border-red-800 bg-red-950 text-red-300' },
};

function ClaimList({ claims }: { claims: Claim[] }) {
  return (
    <ul className="space-y-2">
      {claims.map((c, i) => {
        const grade = GRADE[c.evidence] ?? GRADE['opinion'];
        const parts: [string, string | null | undefined][] = [
          ['Wirkung', c.mechanism], ['Einsatz', c.stake], ['Beleg', c.detail],
          ['Dagegen', c.counter], ['Entscheidet', c.settles],
        ];
        return (
          <li key={i} className="rounded border border-ink-800 px-2.5 py-2">
            <div className="font-semibold text-ink-100">{c.claim}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className={`rounded border px-1.5 py-px text-2xs ${grade.cls}`}>{grade.label}</span>
              {c.proponents && <span className="text-2xs text-ink-500">{c.proponents}</span>}
            </div>
            <dl className="mt-1.5 space-y-1">
              {parts.filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="text-ink-300">
                  <Label>{k}</Label>{v}
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function FindingList({ items }: { items: Finding[] }) {
  return (
    <ul className="space-y-2">
      {items.map((e, i) => (
        <li key={i}>
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-ink-500">{e.date ?? 'undatiert'}</span>
            <span className={`rounded px-1 py-px text-3xs uppercase tracking-wider ${
              e.independent ? 'bg-ink-800 text-ink-300' : 'bg-amber-950 text-amber-400'
            }`}>
              {e.independent ? 'unabhängig' : 'Unternehmen'}
            </span>
            {e.source && /^https?:/.test(e.source) && (
              <a href={e.source} target="_blank" rel="noopener noreferrer" className="text-2xs text-blue-400 hover:underline">
                Quelle
              </a>
            )}
          </div>
          <p className="mt-0.5 text-ink-200">{e.what}</p>
          {e.impact && <p className="mt-0.5 text-ink-400"><Label>Folge</Label>{e.impact}</p>}
        </li>
      ))}
    </ul>
  );
}

function Block({ title, empty, children }: { title: string; empty?: string | false; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-ink-300">{title}</h4>
      {empty ? <p className="italic text-ink-500">{empty}</p> : children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mr-1 text-ink-500">{children}:</span>;
}

/** The old free-text rows: bold lines as headings, the rest as paragraphs. */
function Markdownish({ text }: { text: string }) {
  return (
    <div className="prose-stock text-xs">
      {text.split('\n').map((line, i) => (
        <p key={i} className={line.startsWith('**') ? 'mt-3 font-semibold text-ink-100' : 'mt-1'}>
          {line.replace(/\*\*/g, '')}
        </p>
      ))}
    </div>
  );
}
