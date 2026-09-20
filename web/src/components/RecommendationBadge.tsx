import { recommendationColor } from '../format';

/**
 * The verdict chip. One component so the AI-Verdict card and the list cannot
 * drift into two different-looking badges for the same label — the fill
 * (STRONG) vs. outline (regular) distinction only carries meaning if it looks
 * identical everywhere it appears.
 *
 * `compact` is the list's size: the row is as tall as the identity block and
 * not a pixel more, and at the chip's full padding it was the one cell that
 * pushed the table's rows past the rail's.
 */
export default function RecommendationBadge({ rec, compact = false }: { rec: string; compact?: boolean }) {
  return (
    <span
      className={`inline-block rounded font-bold ${
        compact ? 'px-1.5 py-0.5 text-[10px] leading-[14px]' : 'px-2.5 py-1 text-xs'
      } ${recommendationColor(rec)}`}
    >
      {rec}
    </span>
  );
}
