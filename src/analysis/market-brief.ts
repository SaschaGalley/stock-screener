/**
 * The market brief: where equity markets stand, which sectors lead and which
 * lag, what moves them and what could go wrong — researched by Perplexity for
 * the depot check, which hands it to the depot manager and shows it on the
 * page. It is asked about the market only: nothing of the depot goes into the
 * question (CLAUDE.md).
 *
 * Pure and dependency-free: the web app imports the types. The question and
 * the parsing are in `data/market-brief.ts`.
 */

export const SECTOR_DIRECTIONS = ['strong', 'weak', 'turning-up', 'turning-down'] as const;
export type SectorDirection = (typeof SECTOR_DIRECTIONS)[number];

export const SECTOR_DIRECTION_LABEL: Record<SectorDirection, string> = {
  'strong':       'stark',
  'weak':         'schwach',
  'turning-up':   'dreht nach oben',
  'turning-down': 'dreht nach unten',
};

export interface MarketBrief {
  model:     string;
  fetchedAt: string;
  /** Where markets stand, in a few sentences with figures. */
  state:     string;
  /** Where the money moved from and to. */
  rotation:  string;
  sectors:   { sector: string; direction: SectorDirection; why: string; source: string | null }[];
  drivers:   { what: string; impact: string | null; source: string | null }[];
  problems:  { what: string; source: string | null }[];
  calendar:  { date: string | null; event: string; watch: string }[];
  citations: string[];
  /** Which question produced it: a brief to an older question is not reused. */
  promptHash: string;
  costUsd?:  number;
}
