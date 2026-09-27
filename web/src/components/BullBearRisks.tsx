interface Props {
  llm: {
    bullCase: string[] | string;
    bearCase: string[] | string;
    /** Legacy: analyses from before 27 September kept risks apart. */
    keyRisks?: string[];
    watch?: string[];
  } | null;
}

/** Tolerate both old (string) and new (string[]) shapes — old cached analyses
 * predate the schema change but should still render reasonably. */
function asBullets(v: string[] | string): string[] {
  if (Array.isArray(v)) return v;
  // Best-effort split of a long paragraph into sentences (legacy shape)
  return v.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim().length > 10);
}

/**
 * The case for and against, right under the verdict.
 *
 * Two columns rather than three: a risk is the bear case looking forward, and
 * as a third list it mostly repeated the second in a narrower column. What is
 * genuinely different — the triggers that would change the verdict — sits
 * underneath, full width. Older analyses still carry separate risks; they are
 * folded into the bear side.
 */
export default function BullBearRisks({ llm }: Props) {
  if (!llm) return null;
  const bear = [...asBullets(llm.bearCase), ...(llm.keyRisks ?? [])];
  const watch = llm.watch ?? [];
  return (
    <section className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <CaseCard title="Bull Case" icon="▲" accent="emerald" bullets={asBullets(llm.bullCase)} />
        <CaseCard title="Bear Case" icon="▼" accent="red"     bullets={bear} />
      </div>
      {watch.length > 0 && (
        <article className="rounded-lg border border-ink-700 border-l-4 border-l-amber-500 bg-ink-900 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-300">Was das Urteil ändern würde</h3>
          <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
            {watch.map((w, i) => (
              <li key={i} className="text-xs leading-relaxed text-ink-300">{w}</li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}

function CaseCard({ title, icon, accent, bullets }: {
  title: string; icon: string;
  accent: 'emerald' | 'red' | 'amber';
  bullets: string[];
}) {
  const borderClass = accent === 'emerald' ? 'border-l-emerald-500'
                    : accent === 'red'     ? 'border-l-red-500'
                    : 'border-l-amber-500';
  const iconClass   = accent === 'emerald' ? 'text-emerald-400'
                    : accent === 'red'     ? 'text-red-400'
                    : 'text-amber-400';
  return (
    <article className={`rounded-lg border border-ink-700 ${borderClass} border-l-4 bg-ink-900 p-4`}>
      <div className="mb-3 flex items-center gap-2">
        <span className={`text-base font-bold ${iconClass}`}>{icon}</span>
        <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      </div>
      <ul className="space-y-2">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink-300">
            <span className={`mt-0.5 shrink-0 ${iconClass}`}>·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
