/**
 * Reading a recommendation label, once.
 *
 * "Is STRONG BUY bullish?" was answered in two places with two vocabularies:
 * the server mapped labels to buy/hold/sell for the consensus band, the web
 * mapped them to positive/neutral/negative for colours. Same question, same
 * substring checks, two chances to disagree the day a new label appears.
 *
 * Dependency-free so the web app can import it across the package boundary,
 * like `src/models.ts` and `src/symbols.ts`.
 */

/**
 * The recommendation vocabulary, declared once.
 *
 * It lives here rather than beside the zod schemas because this file is the one
 * both sides can import as a value: `src/types.ts` pulls in zod, and the web
 * app would drag the whole server dependency tree into its bundle to ask what a
 * label means. `types.ts` re-exports it, so every existing importer is
 * unaffected.
 */
export const RECOMMENDATIONS = ['STRONG BUY', 'BUY', 'HOLD', 'SELL', 'STRONG SELL'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/**
 * Score → label. The only definition of where one verdict ends and the next
 * begins.
 *
 * This used to live as a private table inside the scorer, which left the web
 * app no way to ask the question — so the list coloured its scores against its
 * own thresholds (green from 7, amber from 5) while the badge beside them came
 * from the real bands. A 4.6 was therefore a HOLD with an amber badge and a red
 * number, and a 6.6 a BUY with a green badge and an amber one: two of the four
 * zones disagreed with the chip sitting next to them.
 *
 * The bands are set where the LLM's own labels sat, so a stored history and a
 * fresh factor score remain comparable on the same axis.
 */
export const SCORE_BANDS: { min: number; verdict: Recommendation }[] = [
  { min: 8.0,        verdict: 'STRONG BUY' },
  { min: 6.5,        verdict: 'BUY' },
  { min: 4.5,        verdict: 'HOLD' },
  { min: 3.0,        verdict: 'SELL' },
  { min: -Infinity,  verdict: 'STRONG SELL' },
];

/** The band a 0–10 score falls in. */
export function verdictForScore(score: number): Recommendation {
  return SCORE_BANDS.find((b) => score >= b.min)!.verdict;
}

/** Direction a recommendation points, independent of its strength. */
export type RecommendationTone = 'positive' | 'neutral' | 'negative';

/** How the consensus band counts a label. */
export type RecommendationVote = 'buy' | 'hold' | 'sell';

/**
 * STRONG is deliberately not a tone of its own: the word is already in the
 * label, so strength is rendered as emphasis (filled vs. outlined badge) rather
 * than as a fourth colour.
 */
export function recommendationTone(rec: string): RecommendationTone {
  const r = rec.toUpperCase();
  if (r.includes('SELL')) return 'negative';
  if (r.includes('BUY'))  return 'positive';
  return 'neutral';   // HOLD
}

/** The same reading, in the vocabulary the consensus band counts in. */
export function recommendationVote(rec: string): RecommendationVote {
  switch (recommendationTone(rec)) {
    case 'positive': return 'buy';
    case 'negative': return 'sell';
    default:         return 'hold';
  }
}

/** True for labels that carry the STRONG qualifier. */
export function isStrongRecommendation(rec: string): boolean {
  return rec.toUpperCase().includes('STRONG');
}
