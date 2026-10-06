import type { ReactNode } from 'react';
import { useMoney } from '../currency';
import { fmtSignedPct } from '../format';
import {
  CASE_SECTION_LABEL, CASE_TITLE, readCases,
  type CaseDirection, type CasePointView, type CaseSection, type CaseView, type StoredCases,
} from '../../../src/cases';
import Term from './Term';

/** A price this side of the case would put on the stock, with where it comes from. */
export interface CaseScenario {
  label: string;
  value: number | null;
  hint:  string;
}

interface Props {
  llm: StoredCases | null;
  /**
   * What each side is worth in numbers — the optimistic and pessimistic ends
   * of the DCF's scenarios and of the analysts' targets. An argument without a
   * price leaves the reader to guess how much it matters.
   */
  scenarios?: { price: number; bull: CaseScenario[]; bear: CaseScenario[] };
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
export default function BullBearRisks({ llm, scenarios }: Props) {
  if (!llm) return null;
  const cases = readCases(llm);
  return (
    <section className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <CaseCard direction="bull" side={cases.bull} price={scenarios?.price} scenarios={scenarios?.bull} />
        <CaseCard direction="bear" side={cases.bear} price={scenarios?.price} scenarios={scenarios?.bear} />
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

function CaseCard({ direction, side, price, scenarios }: {
  direction: CaseDirection; side: CaseView; price?: number; scenarios?: CaseScenario[];
}) {
  const a = ACCENT[direction];
  const label = (section: CaseSection) => CASE_SECTION_LABEL[section][direction];
  const { fmtPrice } = useMoney();
  const shown = (scenarios ?? []).filter((s) => s.value !== null && s.value > 0);
  return (
    <article className={`flex flex-col rounded-lg border border-ink-700 ${a.border} border-l-4 bg-ink-900 p-4`}>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-base font-bold ${a.text}`}>{a.icon}</span>
        <h3 className="text-[15px] font-semibold text-ink-100">{CASE_TITLE[direction]}</h3>
        {price !== undefined && shown.length > 0 && (
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            {shown.map((s) => (
              <Term
                key={s.label}
                text={s.hint}
                className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-xs text-ink-300"
              >
                <span className="font-sans text-ink-500">{s.label}</span> {fmtPrice(s.value)}{' '}
                <span className={s.value! >= price ? 'text-emerald-400' : 'text-red-400'}>
                  {fmtSignedPct(s.value! / price - 1, 0)}
                </span>
              </Term>
            ))}
          </div>
        )}
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
    <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-500">{children}</h4>
  );
}

/**
 * A section's points. A point with a headline shows it above its text, so a
 * side can be read by its headlines alone; older points are the text alone.
 */
function Points({ points, bulletClass, muted = false }: { points: CasePointView[]; bulletClass: string; muted?: boolean }) {
  return (
    <ul className="space-y-2.5">
      {points.map((p, i) => (
        <li key={i} className="flex gap-2 leading-relaxed">
          <span className={`mt-0.5 shrink-0 ${bulletClass}`}>·</span>
          <div className="min-w-0">
            {p.title && <div className={`font-semibold text-ink-100 ${muted ? 'text-[13px]' : 'text-sm'}`}>{p.title}</div>}
            <div className={muted ? 'text-[13px] text-ink-400' : 'text-sm text-ink-300'}>{p.text}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
