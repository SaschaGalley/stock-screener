import { recommendationColor, verdictForScore } from '../format';

/**
 * The verdict chip. One component so the verdict card and the list cannot drift
 * into two different-looking badges for the same label — the fill (STRONG) vs.
 * outline (regular) distinction only carries meaning if it looks identical
 * everywhere it appears.
 *
 * `heldBack` is for the one case where the label does not follow the score: a
 * cap. A 7.8 reading HOLD two rows above a 7.4 reading BUY looks like a bug
 * unless the reader is told the label was deliberately held below its own band,
 * and *why* — so the reason travels with the chip rather than sitting in small
 * print beside the number. Pass the reasons only when a cap actually bit; a cap
 * that changed nothing is not something to announce.
 */
export default function RecommendationBadge({
  rec, score, heldBack = [],
}: { rec: string; score?: number | null; heldBack?: string[] }) {
  const capped = heldBack.length > 0;
  const wouldBe = capped && typeof score === 'number' ? verdictForScore(score) : null;

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block rounded px-2.5 py-1 text-xs font-bold ${recommendationColor(rec)}`}>
        {rec}
      </span>
      {capped && (
        <span
          className="cursor-help text-[11px] text-amber-400"
          title={[
            wouldBe ? `Der Score allein wäre ${wouldBe} — das Urteil ist bewusst auf ${rec} gedeckelt:` : 'Urteil gedeckelt:',
            ...heldBack.map((r) => `· ${r}`),
            '',
            'Ein Deckel begrenzt das Label, nie die Zahl — die Aktie bleibt, wo ihr Score sie einsortiert.',
          ].join('\n')}
        >
          ⛔
        </span>
      )}
    </span>
  );
}
