/**
 * The market brief, asked of Perplexity: the question, and the answer read
 * into `MarketBrief` (`analysis/market-brief.ts`).
 *
 * The question is about the market and nothing else. It names the reader — a
 * European private investor holding US and European stocks — so the answer
 * covers both sides of the Atlantic, and the sector vocabulary the stocks
 * carry, so a sector in the answer can be matched to a holding. What the
 * investor holds is never in it.
 */

import { createHash } from 'crypto';

import {
  SECTOR_DIRECTIONS, type MarketBrief, type SectorDirection,
} from '../analysis/market-brief.js';
import type { PerplexityModelId } from '../models.js';
import { logger } from '../utils/logger.js';
import { SECTOR_ETFS } from './macro.js';
import { extractJson, pplxComplete, text as plain } from './perplexity.js';

const SYSTEM =
  'You are the chief market strategist of a European private bank, writing the morning note for its '
  + 'portfolio managers. You separate data from opinion, quantify whenever a figure exists, and date and '
  + 'source every claim. You never pad a section: an empty list is a valid answer. Never refuse, and never '
  + 'comment on your search. Write every text value in German, with decimal commas (4,2 %).';

const SECTORS = SECTOR_ETFS.map((s) => `"${s.sector}"`).join(', ');

// {date} is replaced at runtime and is deliberately outside the hash.
const TEMPLATE = `The equity market as of {date}, for a European private investor holding US and European stocks.

1. "state": three to five sentences on where equity markets stand now — the US (S&P 500, Nasdaq) and
   Europe (STOXX 600, DAX): the trend of the last weeks, the distance from the highs, breadth, valuation
   against history, sentiment and positioning. With figures.
2. "rotation": one or two sentences: which sectors and styles (growth or value, large or small caps,
   cyclical or defensive) money has moved out of and into over the last one to three months.
3. "sectors": every sector that stands out, leading or lagging, turning up or down. "sector" is exactly
   one of ${SECTORS}; "direction" one of ${SECTOR_DIRECTIONS.map((d) => `"${d}"`).join(', ')}; "why" one
   or two sentences with figures.
4. "drivers": up to five things moving markets now — rates and central banks, inflation, the earnings
   season, the dollar against the euro, oil, politics and tariffs — each with its "impact" on equities.
5. "problems": up to five specific risks or stress points building now, with figures where they exist —
   credit spreads, defaults, guidance cuts, valuation extremes, concentration in a few stocks.
6. "calendar": dated events of the next four weeks that can move markets — central bank meetings,
   inflation and labour data, major earnings — and what to watch in each.

Return ONLY this JSON:
{
  "state":    "...",
  "rotation": "...",
  "sectors":  [{"sector": "Technology", "direction": "strong", "why": "...", "source": "url"}],
  "drivers":  [{"what": "...", "impact": "...", "source": "url"}],
  "problems": [{"what": "...", "source": "url"}],
  "calendar": [{"date": "YYYY-MM-DD", "event": "...", "watch": "..."}]
}`;

export const MARKET_BRIEF_PROMPT_HASH = createHash('md5').update(SYSTEM + TEMPLATE).digest('hex').slice(0, 8);

/**
 * A text value without its inline sources: the brief writes them into the
 * sentence as "[https://…]" or "(https://…)" beside its own `source` fields,
 * and a sentence read aloud does not need them twice.
 */
const text = (v: unknown) => plain(typeof v === 'string' ? v.replace(/\s*[[(]https?:\/\/[^\])\s]*[\])]/g, '') : v);
const optText = (v: unknown) => text(v) || null;

const KNOWN_SECTORS = new Map(SECTOR_ETFS.map((s) => [s.sector.toLowerCase(), s.sector]));

function direction(v: unknown): SectorDirection | null {
  const s = text(v).toLowerCase().replace(/[\s_]+/g, '-');
  return (SECTOR_DIRECTIONS as readonly string[]).includes(s) ? s as SectorDirection : null;
}

/**
 * The brief from an answer, or null when the answer holds no JSON or no
 * picture of the market. Items without their text are dropped, a sector
 * outside the vocabulary or without a direction too: nothing is filled in.
 */
export function parseMarketBrief(raw: string): Omit<MarketBrief, 'model' | 'fetchedAt' | 'citations' | 'promptHash' | 'costUsd'> | null {
  const o = extractJson(raw);
  const state = o ? text(o.state) : '';
  if (!o || !state) return null;
  const list = <T>(v: unknown, f: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((x) => (x && typeof x === 'object' ? [f(x as Record<string, unknown>)] : [])).filter((x): x is T => x !== null) : [];
  return {
    state,
    rotation: text(o.rotation),
    sectors: list(o.sectors, (x) => {
      const sector = KNOWN_SECTORS.get(text(x.sector).toLowerCase());
      const dir = direction(x.direction);
      return sector && dir ? { sector, direction: dir, why: text(x.why), source: optText(x.source) } : null;
    }),
    drivers:  list(o.drivers, (x) => (text(x.what) ? { what: text(x.what), impact: optText(x.impact), source: optText(x.source) } : null)),
    problems: list(o.problems, (x) => (text(x.what) ? { what: text(x.what), source: optText(x.source) } : null)),
    calendar: list(o.calendar, (x) => (text(x.event) ? { date: optText(x.date), event: text(x.event), watch: text(x.watch) } : null)),
  };
}

/** Ask Perplexity for today's brief, and the answer it was read from. Throws when the answer holds none. */
export async function fetchMarketBrief(model: PerplexityModelId, apiKey: string): Promise<{ brief: MarketBrief; raw: string }> {
  logger.step(`Marktlage von Perplexity (${model})…`);
  const user = TEMPLATE.replace('{date}', new Date().toISOString().slice(0, 10));
  // A week of news is what a market note is about; older pages crowd it out.
  const answer = await pplxComplete(model, SYSTEM, user, apiKey, { search_recency_filter: 'week' });
  const brief = parseMarketBrief(answer.raw);
  if (!brief) throw new Error('Perplexity lieferte keine lesbare Marktlage.');
  return {
    brief: {
      model, fetchedAt: new Date().toISOString(), ...brief,
      citations: answer.citations, promptHash: MARKET_BRIEF_PROMPT_HASH,
      ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}),
    },
    raw: answer.raw,
  };
}
