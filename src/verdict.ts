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
