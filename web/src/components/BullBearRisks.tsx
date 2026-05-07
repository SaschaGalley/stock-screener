interface Props {
  llm: {
    bullCase: string;
    bearCase: string;
    keyRisks: string[];
  } | null;
}

export default function BullBearRisks({ llm }: Props) {
  if (!llm) return null;

  return (
    <section className="grid gap-3 lg:grid-cols-3">
      <CaseCard
        title="Bull Case"
        icon="🚀"
        accent="emerald"
        body={llm.bullCase}
      />
      <CaseCard
        title="Bear Case"
        icon="🐻"
        accent="red"
        body={llm.bearCase}
      />
      <RisksCard risks={llm.keyRisks} />
    </section>
  );
}

function CaseCard({ title, icon, accent, body }: {
  title: string;
  icon: string;
  accent: 'emerald' | 'red';
  body: string;
}) {
  const borderClass = accent === 'emerald' ? 'border-l-emerald-700' : 'border-l-red-700';
  return (
    <article className={`rounded-lg border border-ink-800 ${borderClass} border-l-4 bg-ink-900 p-4`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      </div>
      <p className="text-xs leading-relaxed text-ink-300">{body}</p>
    </article>
  );
}

function RisksCard({ risks }: { risks: string[] }) {
  return (
    <article className="rounded-lg border border-ink-800 border-l-4 border-l-amber-700 bg-ink-900 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base">⚠️</span>
        <h3 className="text-sm font-semibold text-ink-100">Key Risks</h3>
      </div>
      <ul className="space-y-2 text-xs text-ink-300">
        {risks.map((r, i) => (
          <li key={i} className="flex gap-1.5 leading-relaxed">
            <span className="mt-0.5 shrink-0 text-amber-400">›</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
