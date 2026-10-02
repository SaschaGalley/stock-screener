import type { ReactNode } from 'react';
import {
  CASE_SECTION_LABEL, CASE_TITLE, readCases,
  type CaseDirection, type CaseSection, type CaseView, type StoredCases,
} from '../../../src/cases';

interface Props {
  llm: StoredCases | null;
}

/**
 * The case for and against, right under the verdict.
 *
 * Two columns, each in sections: the theses first, because they are the
 * argument a reader came for; then what the numbers say for that side; then,
 * pinned to the bottom of the column, what would move the verdict that way.
 * The triggers used to be a full-width block of their own underneath, where a
 * "↑ wenn …" and a "↓ wenn …" sat side by side and each had to announce its
 * direction — in its column the heading says it.
 *
 * Analyses from before the split carry one flat list per side; it renders
 * without a section heading rather than under a label it never had.
 */
export default function BullBearRisks({ llm }: Props) {
  if (!llm) return null;
  const cases = readCases(llm);
  return (
    <section className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <CaseCard direction="bull" side={cases.bull} />
        <CaseCard direction="bear" side={cases.bear} />
      </div>
      {cases.undirected.length > 0 && (
        <article className="rounded-lg border border-ink-700 border-l-4 border-l-amber-500 bg-ink-900 px-4 py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-300">Was das Urteil ändern würde</h3>
          <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
            {cases.undirected.map((w, i) => (
              <li key={i} className="text-xs leading-relaxed text-ink-300">{w}</li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}

const ACCENT: Record<CaseDirection, { border: string; text: string; icon: string; arrow: string }> = {
  bull: { border: 'border-l-emerald-500', text: 'text-emerald-400', icon: '▲', arrow: '↑' },
  bear: { border: 'border-l-red-500',     text: 'text-red-400',     icon: '▼', arrow: '↓' },
};

function CaseCard({ direction, side }: { direction: CaseDirection; side: CaseView }) {
  const a = ACCENT[direction];
  const label = (section: CaseSection) => CASE_SECTION_LABEL[section][direction];
  return (
    <article className={`flex flex-col rounded-lg border border-ink-700 ${a.border} border-l-4 bg-ink-900 p-4`}>
      <div className="mb-3 flex items-center gap-2">
        <span className={`text-base font-bold ${a.text}`}>{a.icon}</span>
        <h3 className="text-sm font-semibold text-ink-100">{CASE_TITLE[direction]}</h3>
      </div>

      <div className="space-y-4">
        {side.unsorted.length > 0 && <Points points={side.unsorted} bulletClass={a.text} />}
        {side.theses.length > 0 && (
          <div>
            <SectionLabel>{label('theses')}</SectionLabel>
            <Points points={side.theses} bulletClass={a.text} />
          </div>
        )}
        {side.figures.length > 0 && (
          <div>
            <SectionLabel>{label('figures')}</SectionLabel>
            <Points points={side.figures} bulletClass={a.text} muted />
          </div>
        )}
      </div>

      {side.triggers.length > 0 && (
        // mt-auto: both columns end on their triggers at the same height,
        // however long either side's argument ran.
        <div className="mt-auto pt-4">
          <div className="border-t border-ink-800 pt-3">
            <SectionLabel>
              <span className={`mr-1 ${a.text}`}>{a.arrow}</span>{label('triggers')} …
            </SectionLabel>
            <Points points={side.triggers} bulletClass={a.text} muted />
          </div>
        </div>
      )}
    </article>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{children}</h4>
  );
}

function Points({ points, bulletClass, muted = false }: { points: string[]; bulletClass: string; muted?: boolean }) {
  return (
    <ul className="space-y-2">
      {points.map((p, i) => (
        <li
          key={i}
          className={`flex gap-2 leading-relaxed ${muted ? 'text-xs text-ink-400' : 'text-[13px] text-ink-300'}`}
        >
          <span className={`mt-0.5 shrink-0 ${bulletClass}`}>·</span>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}
