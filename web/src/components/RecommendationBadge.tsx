import { recommendationColor, verdictForScore } from '../format';
import Tip from './Tip';

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
  rec, score, heldBack = [], size = 'md',
}: {
  rec: string;
  score?: number | null;
  heldBack?: string[];
  /** `sm` is the list's: a row is only as tall as its tallest cell. */
  size?: 'sm' | 'md';
}) {
  const capped = heldBack.length > 0;
  const wouldBe = capped && typeof score === 'number' ? verdictForScore(score) : null;
  const chip = size === 'sm' ? 'px-2 py-0.5 text-[11px] leading-4' : 'px-2.5 py-1 text-xs';

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block rounded font-bold ${chip} ${recommendationColor(rec)}`}>
        {rec}
      </span>
      {capped && (
        <Tip
          className="text-[11px] text-amber-400"
          content={
            <>
              <div className="font-semibold text-ink-100">
                {wouldBe
                  ? <>Der Score allein wäre {wouldBe} — das Urteil ist bewusst auf {rec} gedeckelt:</>
                  : 'Urteil gedeckelt:'}
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {heldBack.map((r) => <li key={r}>{r}</li>)}
              </ul>
              <div className="mt-1.5 text-ink-400">
                Ein Deckel begrenzt das Label, nie die Zahl — die Aktie bleibt, wo ihr Score sie einsortiert.
              </div>
            </>
          }
        >
          ⛔
        </Tip>
      )}
    </span>
  );
}
