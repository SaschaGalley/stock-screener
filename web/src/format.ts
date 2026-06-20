// Shared formatting helpers for the React frontend.

export function fmt(n: number | null | undefined, suffix = '', decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${n.toFixed(decimals)}${suffix}`;
}

export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function fmtSignedPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  const v = n * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  return `$${n.toFixed(2)}`;
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

/**
 * Color for a recommendation badge.
 * Strong = filled (saturated foreground bg). Regular = outlined (tinted bg
 * with a foreground-color border + foreground-color text). The fill-vs-outline
 * pattern carries the strength signal without needing extra theme vars.
 */
export function recommendationColor(rec: string): string {
  if (rec.includes('STRONG BUY'))  return 'bg-emerald-500 text-white';
  if (rec.includes('BUY'))         return 'bg-emerald-900 text-emerald-400 border border-emerald-500';
  if (rec.includes('STRONG SELL')) return 'bg-red-500 text-white';
  if (rec.includes('SELL'))        return 'bg-red-900 text-red-400 border border-red-500';
  return 'bg-amber-500 text-white';   // HOLD
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
