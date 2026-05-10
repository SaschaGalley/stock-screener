import type { ConsensusBand } from '../types';

interface Props {
  consensus: ConsensusBand | null;
  /** Total height in pixels (matches the row height of a sidebar item). */
  height?: number;
}

/**
 * Thin vertical 3-segment bar showing aggregated buy/hold/sell consensus.
 *
 * Sections, top to bottom: green (buy) → amber (hold) → red (sell).
 * Section heights are proportional to the weighted vote share. The 0.6/0.4
 * AI-vs-analyst split is computed server-side in `computeConsensus()`.
 *
 * Renders nothing when there's no consensus data, so rows without analyses
 * or analyst coverage don't gain a meaningless solid bar.
 */
export default function ConsensusBar({ consensus, height = 44 }: Props) {
  if (!consensus || consensus.sources === 0) {
    return <div className="w-[3px] shrink-0" style={{ height }} />;
  }

  const buyPct  = Math.max(0, consensus.buy  * 100);
  const holdPct = Math.max(0, consensus.hold * 100);
  const sellPct = Math.max(0, consensus.sell * 100);

  return (
    <div
      className="flex w-[3px] shrink-0 flex-col overflow-hidden rounded-sm"
      style={{ height }}
      title={`Consensus: ${buyPct.toFixed(0)}% buy · ${holdPct.toFixed(0)}% hold · ${sellPct.toFixed(0)}% sell`}
      aria-label={`Buy ${buyPct.toFixed(0)}%, hold ${holdPct.toFixed(0)}%, sell ${sellPct.toFixed(0)}%`}
    >
      {/* Colors are CSS vars — edit the hex values in styles.css under
          --color-consensus-buy / -hold / -sell to retheme the bar. */}
      {buyPct  > 0 && <div style={{ flex: buyPct,  background: 'var(--color-consensus-buy)'  }} />}
      {holdPct > 0 && <div style={{ flex: holdPct, background: 'var(--color-consensus-hold)' }} />}
      {sellPct > 0 && <div style={{ flex: sellPct, background: 'var(--color-consensus-sell)' }} />}
    </div>
  );
}
