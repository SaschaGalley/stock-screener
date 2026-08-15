import { recommendationColor } from '../format';

/**
 * The verdict chip. One component so the AI-Verdict card and the overview table
 * cannot drift into two different-looking badges for the same label — the fill
 * (STRONG) vs. outline (regular) distinction only carries meaning if it looks
 * identical everywhere it appears.
 */
export default function RecommendationBadge({ rec }: { rec: string }) {
  return (
    <span className={`inline-block rounded px-2.5 py-1 text-xs font-bold ${recommendationColor(rec)}`}>
      {rec}
    </span>
  );
}
