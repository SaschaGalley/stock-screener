import type { OverviewRow } from '../types';

/**
 * The two halves behind one headline, in the space of one line.
 *
 * The score used to be a single opaque number a model chose, and the only
 * provenance the list offered was the model's name underneath it — which said
 * who produced the number, never what went into it. These three figures say
 * what the name could not: how the arithmetic scored the company, how the prose
 * scored it, and how much of the arithmetic was actually backed by data.
 *
 * A gap between Z and T is the interesting case and the reason both are shown:
 * numbers and narrative disagreeing is information, and averaging them into one
 * digit is exactly how that information used to get lost.
 */
export default function ScoreSplit({ row }: { row: OverviewRow }) {
  if (row.factorScore === null) return null;

  const conf = row.scoreConfidence === null ? null : Math.round(row.scoreConfidence * 100);
  const title = [
    `Zahlen (deterministisch): ${row.factorScore.toFixed(1)}/10`,
    row.narrativeScore === null
      ? 'Text (Distill/Perplexity): keine verwertbare Quelle'
      : `Text (Distill/Perplexity, ohne Kenntnis der Bewertung): ${row.narrativeScore.toFixed(1)}/10`,
    conf === null ? '' : `Konfidenz der Zahlen: ${conf} % — sie bestimmt das Mischungsverhältnis`,
    row.verdictCapped ? 'Die Überzeugung ist gedeckelt (Datenqualität, fehlende Coverage oder Bilanzrisiko)' : '',
  ].filter(Boolean).join('\n');

  return (
    <div className="font-mono text-[9px] font-normal text-ink-600" title={title}>
      Z {row.factorScore.toFixed(1)}
      {row.narrativeScore !== null && <> · T {row.narrativeScore.toFixed(1)}</>}
      {conf !== null && <> · {conf}%</>}
      {row.verdictCapped && <span className="ml-0.5 text-amber-500" title="Überzeugung gedeckelt">⛔</span>}
    </div>
  );
}
