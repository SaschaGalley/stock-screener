/**
 * Where the money has gone lately, measured rather than told: each US sector's
 * SPDR fund against the S&P 500 over one, three and six months, from the price
 * archive the evaluation already keeps.
 *
 * The four words are the quadrants of a relative rotation graph (de
 * Kempenaer's RRG) reduced to their signs: ahead of the index over three
 * months and still gaining over the last one, a sector leads; ahead but losing
 * ground, it weakens; behind and losing, it lags; behind but gaining, it
 * improves. A description of the last months, not a tested forecast — sector
 * momentum is a documented effect (Moskowitz and Grinblatt 1999), this
 * reading of it is not one the backtest has checked.
 *
 * Pure and dependency-free: the web app imports the types.
 */

export type SectorPhase = 'führt' | 'verliert Schwung' | 'hinkt' | 'holt auf';

export interface SectorTrend {
  /** In Yahoo's vocabulary, as the stocks carry it. */
  sector: string;
  etf:    string;
  r1m:    number | null;
  r3m:    number | null;
  r6m:    number | null;
  /** The same windows less the index's return. */
  rel1m:  number | null;
  rel3m:  number | null;
  rel6m:  number | null;
  phase:  SectorPhase | null;
}

/** Trading sessions in a month, a quarter, half a year. */
const SESSIONS = { r1m: 21, r3m: 63, r6m: 126 } as const;

type Closes = readonly { day: string; close: number }[];

/** The return over the last `n` sessions; null without that much history. */
function back(xs: Closes, n: number): number | null {
  if (xs.length <= n) return null;
  const from = xs[xs.length - 1 - n].close;
  return from > 0 ? xs[xs.length - 1].close / from - 1 : null;
}

export function sectorPhase(rel3m: number | null, rel1m: number | null): SectorPhase | null {
  if (rel3m === null || rel1m === null) return null;
  if (rel3m > 0) return rel1m > 0 ? 'führt' : 'verliert Schwung';
  return rel1m > 0 ? 'holt auf' : 'hinkt';
}

/**
 * Every sector's trend against the index, strongest over three months first.
 * `closes` are dividend-adjusted where the archive has it, oldest first.
 */
export function sectorTrends(
  sectors: readonly { sector: string; etf: string }[], closes: ReadonlyMap<string, Closes>, index: string,
): SectorTrend[] {
  const idx = closes.get(index) ?? [];
  const rel = (x: number | null, n: number) => {
    const i = back(idx, n);
    return x === null || i === null ? null : x - i;
  };
  return sectors.map(({ sector, etf }) => {
    const xs = closes.get(etf) ?? [];
    const r1m = back(xs, SESSIONS.r1m), r3m = back(xs, SESSIONS.r3m), r6m = back(xs, SESSIONS.r6m);
    const rel1m = rel(r1m, SESSIONS.r1m), rel3m = rel(r3m, SESSIONS.r3m), rel6m = rel(r6m, SESSIONS.r6m);
    return { sector, etf, r1m, r3m, r6m, rel1m, rel3m, rel6m, phase: sectorPhase(rel3m, rel1m) };
  }).sort((a, b) => (b.rel3m ?? -Infinity) - (a.rel3m ?? -Infinity));
}
