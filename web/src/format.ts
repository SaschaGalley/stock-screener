import { isStrongRecommendation, recommendationTone } from '../../src/verdict';

// Numbers are formatted the same way in the terminal and the browser, so the
// formatters come from the shared module; this file owns only the colours.
export {
  fmt, fmtPct, fmtSignedPct, fmtPercentPoints, fmtBig, fmtCount, fmtPrice, currencyPrefix,
} from '../../src/format';
// `fmtBig`/`fmtPrice`/`currencyPrefix` take the currency as an argument. Views that
// show a single stock get it from `useMoney()` (see currency.tsx) instead; the
// direct imports are for the list views, where every row has its own currency.

// Shared formatting helpers for the React frontend.

/** Colour for an upside in percentage points — green above, amber flat, red below. */
export function upsideColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'text-ink-500';
  if (n > 0)  return 'text-emerald-400';
  if (n < -5) return 'text-red-400';
  return 'text-amber-400';
}

// Theme-shade map for context (per tailwind.config.js):
//   *-400/500/600  → --color-success / -warning / -danger    (readable foreground)
//   *-700/800/900/950 → --color-*-soft                       (dark tinted bg)
// Anything that needs to be *visible* must use 400-600. The -700+ shades only
// work as recessed card backgrounds, never as text or solid badge fills.

/** Color class for a margin-of-safety value (positive = green, negative = red). */
export function mosColor(mos: number | null | undefined): string {
  if (mos === null || mos === undefined || !Number.isFinite(mos)) return 'text-ink-400';
  if (mos > 0)     return 'text-emerald-400';   // --color-success
  if (mos > -0.20) return 'text-amber-400';     // --color-warning
  return 'text-red-400';                         // --color-danger
}

/** Tinted card background + visible border edge for an MoS-themed callout. */
export function mosBgColor(mos: number | null | undefined): string {
  if (mos === null || mos === undefined || !Number.isFinite(mos)) return 'bg-ink-800';
  // bg = soft tint (recessed); border = readable foreground (so the edge reads).
  if (mos > 0)     return 'bg-emerald-900 border-emerald-500';
  if (mos > -0.20) return 'bg-amber-900 border-amber-500';
  return 'bg-red-900 border-red-500';
}

// The label reading itself lives in src/verdict.ts, shared with the server's
// consensus band — this module owns only what a tone should *look* like.
export { recommendationTone } from '../../src/verdict';
export type { RecommendationTone } from '../../src/verdict';

/**
 * Color for a recommendation badge.
 * Strong = filled (saturated foreground bg). Regular = outlined (tinted bg
 * with a foreground-color border + foreground-color text). The fill-vs-outline
 * pattern carries the strength signal without needing extra theme vars.
 */
export function recommendationColor(rec: string): string {
  const strong = isStrongRecommendation(rec);
  switch (recommendationTone(rec)) {
    case 'positive':
      return strong ? 'bg-emerald-500 text-white' : 'bg-emerald-900 text-emerald-400 border border-emerald-500';
    case 'negative':
      return strong ? 'bg-red-500 text-white' : 'bg-red-900 text-red-400 border border-red-500';
    default:
      return 'bg-amber-500 text-white';
  }
}

/**
 * Fill color for a recommendation-driven bar. Three tones only — the strong/
 * regular distinction lives in the badge, so repeating it here would just add a
 * shade the reader has to decode.
 */
export function recommendationBarColor(rec: string): string {
  switch (recommendationTone(rec)) {
    case 'positive': return 'bg-emerald-500';
    case 'negative': return 'bg-red-500';
    default:         return 'bg-amber-500';
  }
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60)        return 'just now';
  if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))}w ago`;
  if (diff < 365 * 86400) return `${Math.floor(diff / (30 * 86400))}mo ago`;
  return `${Math.floor(diff / (365 * 86400))}y ago`;
}

/**
 * Human-readable cache age — same scale as `relativeTime` but phrased as
 * "X unit old" so it reads naturally inside "✓ Cached (5h old)" style copy.
 * Rolls up automatically: minutes → hours → days → weeks → months → years
 * so an entry from a month ago shows "1mo old" instead of "43200m old".
 */
export function formatAge(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60)         return 'just now';
  if (diff < 3600)       return `${Math.floor(diff / 60)}m old`;
  if (diff < 86400)      return `${Math.floor(diff / 3600)}h old`;
  if (diff < 7 * 86400)  return `${Math.floor(diff / 86400)}d old`;
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))}w old`;
  if (diff < 365 * 86400) return `${Math.floor(diff / (30 * 86400))}mo old`;
  return `${Math.floor(diff / (365 * 86400))}y old`;
}
