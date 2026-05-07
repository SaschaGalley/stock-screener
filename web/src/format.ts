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

/** Color class for a margin-of-safety value (positive = green, negative = red). */
export function mosColor(mos: number | null | undefined): string {
  if (mos === null || mos === undefined || !Number.isFinite(mos)) return 'text-ink-400';
  if (mos > 0.20)  return 'text-emerald-400';
  if (mos > 0)     return 'text-emerald-500';
  if (mos > -0.20) return 'text-amber-400';
  return 'text-red-400';
}

export function mosBgColor(mos: number | null | undefined): string {
  if (mos === null || mos === undefined || !Number.isFinite(mos)) return 'bg-ink-800';
  if (mos > 0.20)  return 'bg-emerald-900/30 border-emerald-700/50';
  if (mos > 0)     return 'bg-emerald-950/30 border-emerald-800/50';
  if (mos > -0.20) return 'bg-amber-950/30 border-amber-800/50';
  return 'bg-red-950/30 border-red-800/50';
}

/** Color for a recommendation token. */
export function recommendationColor(rec: string): string {
  if (rec.includes('STRONG BUY'))  return 'bg-emerald-600 text-white';
  if (rec.includes('BUY'))         return 'bg-emerald-700 text-white';
  if (rec.includes('STRONG SELL')) return 'bg-red-600 text-white';
  if (rec.includes('SELL'))        return 'bg-red-700 text-white';
  return 'bg-amber-600 text-white';
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
