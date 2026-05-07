interface Props {
  llm: {
    bullCase: string[] | string;
    bearCase: string[] | string;
    keyRisks: string[];
  } | null;
}

/** Tolerate both old (string) and new (string[]) shapes — old cached analyses
 * predate the schema change but should still render reasonably. */
function asBullets(v: string[] | string): string[] {
  if (Array.isArray(v)) return v;
  // Best-effort split of a long paragraph into sentences (legacy shape)
  return v.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim().length > 10);
}

export default function BullBearRisks({ llm }: Props) {
  if (!llm) return null;
  return (
    <section className="grid gap-3 lg:grid-cols-3">
      <CaseCard title="Bull Case" icon="▲" accent="emerald" bullets={asBullets(llm.bullCase)} />
      <CaseCard title="Bear Case" icon="▼" accent="red"     bullets={asBullets(llm.bearCase)} />
      <CaseCard title="Key Risks" icon="!" accent="amber"   bullets={llm.keyRisks} />
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
          <li key={i} className="flex gap-2 text-xs leading-relaxed text-ink-300">
            <span className={`mt-0.5 shrink-0 ${iconClass}`}>·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
