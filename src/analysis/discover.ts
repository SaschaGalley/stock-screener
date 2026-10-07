/**
 * What to look at next: lists drawn from the reference universe.
 *
 * The universe (S&P 500, EURO STOXX 50, DAX) is scored every few nights to give
 * the score a population, and until now it was only ever seen as a rank and as
 * the peers of a stock already on the list. Each list here asks one question of
 * it — which score best, whose verdict just turned, what trades well below its
 * value without a warning, where insiders buy and where the analysts grow more
 * optimistic — and answers with the stocks and the reason each is there.
 *
 * Watchlist stocks are not in it: they are the ones already being looked at.
 *
 * Pure and dependency-free so the web app can import the types.
 */

import { RECOMMENDATIONS, recommendationTone } from '../verdict.js';

/** One stock of the universe, as its last refresh left it. */
export interface UniverseStock {
  symbol:     string;
  name:       string | null;
  sector:     string | null;
  industry:   string | null;
  logoDomain: string | null;
  currency:   string | null;
  price:      number | null;
  marketCap:  number | null;
  /** When its score was last computed — the universe comes round every few nights. */
  asOf:       string | null;
  /** Numbers only: a universe stock never has a written analysis. */
  score:      number | null;
  verdict:    string | null;
  /** The score's pillars, 0–10, with their names. */
  pillars:    { label: string; score: number }[];
  /** The median of the primary models, and their lower quartile. */
  fair:       number | null;
  fairP25:    number | null;
  /** Share of the primary models above the price. */
  undervalued: number | null;
  /** How far the models can be trusted here, 0–10. */
  confidence: number | null;
  /** Health pillar, 0–10. */
  health:     number | null;
  /** Altman's distress zone. */
  distress:   boolean;
  /** A cap held the verdict below its band. */
  capped:     boolean;
  /** The statements are old enough to distrust. */
  stale:      boolean;
}

/** One reading of the published verdict. */
export interface VerdictReading { at: string; verdict: string; score: number | null }
/** A rating or price-target action, as Yahoo lists them. */
export interface AnalystMove { at: string; firm: string; action: string | null; target: string | null }
/** An insider's purchase on the open market. */
export interface InsiderBuy { day: string; filer: string | null; value: number | null }

export interface BestItem    { symbol: string; strong: string[]; weak: string[] }
export interface TurnItem    { symbol: string; day: string; from: string; to: string; fromScore: number | null; toScore: number | null; up: boolean }
export interface CheapItem   { symbol: string; gap: number; fair: number; undervalued: number | null }
export interface InsiderItem { symbol: string; buys: number; buyers: number; value: number | null; last: string }
export interface AnalystItem { symbol: string; upgrades: number; downgrades: number; raises: number; cuts: number; firms: string[]; last: string }

export interface DiscoverLists {
  best:     BestItem[];
  turns:    TurnItem[];
  cheap:    CheapItem[];
  insiders: InsiderItem[];
  analysts: AnalystItem[];
}

export interface DiscoverUniverse extends DiscoverLists {
  /** How many stocks the lists were drawn from. */
  size:    number;
  /** The newest and the oldest refresh among them. */
  newest:  string | null;
  oldest:  string | null;
  /** Every stock named in a list, by symbol. */
  stocks:  Record<string, UniverseStock>;
}

/** A pillar this high is a strength worth naming, this low a weakness. */
export const STRONG_PILLAR = 7;
export const WEAK_PILLAR = 3;
/** Verdict turns this recent are news. */
export const TURN_DAYS = 30;
/** Analyst actions and insider purchases this recent count. */
export const ANALYST_DAYS = 30;
export const INSIDER_DAYS = 90;
/**
 * Below its value by at least this much, and with the cautious quarter of the
 * models still above the price — so one model's outlier cannot carry it.
 */
export const CHEAP_GAP = 0.25;
/**
 * And not by more than this: a value over twice the price is far more often
 * the models misreading a company (a one-off gain, a balance sheet they do not
 * fit) than a market missing it.
 */
export const CHEAP_MAX_GAP = 1;
/** The models are trusted at least this much (0–10). */
export const CHEAP_CONFIDENCE = 5;
/** The balance sheet scores at least this (0–10); the universe's median is about 5. */
export const CHEAP_HEALTH = 4;
/** An analyst signal needs this much weight: an upgrade counts two, a raised target one. */
export const ANALYST_MIN_NET = 4;
/** The longest a list is sent; the page shows the first few of whatever the filters leave. */
export const LIST_CAP = 100;

const DAY_MS = 86_400_000;
const rank = (v: string) => {
  const i = RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);
  return i === -1 ? RECOMMENDATIONS.length : i;
};
const since = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

/**
 * One line per company, and none already on the list under another ticker:
 * ASML trades in Amsterdam for the EURO STOXX 50 and in New York for the
 * watchlist, Alphabet has two share classes in the S&P 500. Yahoo gives every
 * line the same name, so the name is the company; the largest line stays.
 */
export function onePerCompany(stocks: readonly UniverseStock[], listed: Iterable<string>): UniverseStock[] {
  const taken = new Set(listed);
  return [...stocks]
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    .filter((s) => {
      if (!s.name) return true;
      if (taken.has(s.name)) return false;
      taken.add(s.name);
      return true;
    });
}

/** The best scores, with what carries each and what holds it back. Buy verdicts only. */
export function bestScores(stocks: readonly UniverseStock[]): BestItem[] {
  return stocks
    .filter((s) => s.score !== null && s.verdict !== null && recommendationTone(s.verdict) === 'positive')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, LIST_CAP)
    .map((s) => {
      const byScore = [...s.pillars].sort((a, b) => b.score - a.score);
      return {
        symbol: s.symbol,
        strong: byScore.filter((p) => p.score >= STRONG_PILLAR).slice(0, 3).map((p) => p.label),
        weak:   byScore.filter((p) => p.score <= WEAK_PILLAR).reverse().slice(0, 2).map((p) => p.label),
      };
    });
}

/**
 * The verdict's last change, where it falls in the last `TURN_DAYS`: what it
 * was before, what it is now, and the scores either side. Readings come every
 * few nights for the universe, so each day's last one stands for the day.
 */
export function lastTurn(readings: readonly VerdictReading[], now: Date): Omit<TurnItem, 'symbol'> | null {
  const days: (VerdictReading & { day: string })[] = [];
  for (const r of [...readings].sort((a, b) => a.at.localeCompare(b.at))) {
    const day = r.at.slice(0, 10);
    if (days.length && days[days.length - 1].day === day) days[days.length - 1] = { ...r, day };
    else days.push({ ...r, day });
  }
  for (let k = days.length - 1; k > 0; k--) {
    const before = days[k - 1], after = days[k];
    if (before.verdict === after.verdict) continue;
    if (after.day < since(now, TURN_DAYS).slice(0, 10)) return null;
    return {
      day: after.day, from: before.verdict, to: after.verdict,
      fromScore: before.score, toScore: after.score, up: rank(after.verdict) < rank(before.verdict),
    };
  }
  return null;
}

export function verdictTurns(readings: ReadonlyMap<string, readonly VerdictReading[]>, now: Date): TurnItem[] {
  return [...readings]
    .flatMap(([symbol, rs]) => {
      const t = lastTurn(rs, now);
      return t ? [{ symbol, ...t }] : [];
    })
    .sort((a, b) => b.day.localeCompare(a.day) || a.symbol.localeCompare(b.symbol))
    .slice(0, LIST_CAP);
}

/**
 * Well below the value the models give, and nothing that says why it should
 * be: the models trusted, most of them above the price, the balance sheet
 * sound, no cap on the verdict, no sell verdict and the statements current.
 */
export function belowValue(stocks: readonly UniverseStock[]): CheapItem[] {
  return stocks
    .flatMap((s): CheapItem[] => {
      if (!s.price || s.price <= 0 || s.fair === null || s.fairP25 === null) return [];
      const gap = s.fair / s.price - 1;
      const ok = gap >= CHEAP_GAP && gap <= CHEAP_MAX_GAP
        && s.fairP25 > s.price
        && (s.confidence ?? 0) >= CHEAP_CONFIDENCE
        && (s.health ?? 0) >= CHEAP_HEALTH
        && !s.distress && !s.capped && !s.stale
        && (s.verdict === null || recommendationTone(s.verdict) !== 'negative');
      return ok ? [{ symbol: s.symbol, gap, fair: s.fair, undervalued: s.undervalued }] : [];
    })
    .sort((a, b) => b.gap - a.gap)
    .slice(0, LIST_CAP);
}

/** Purchases on the open market in the last `INSIDER_DAYS`: how many, by how many people, for how much. */
export function insiderBuying(buys: ReadonlyMap<string, readonly InsiderBuy[]>, now: Date): InsiderItem[] {
  const from = since(now, INSIDER_DAYS).slice(0, 10);
  return [...buys]
    .flatMap(([symbol, rows]): InsiderItem[] => {
      const recent = rows.filter((r) => r.day >= from);
      if (recent.length === 0) return [];
      const values = recent.map((r) => r.value).filter((v): v is number => v !== null && v > 0);
      return [{
        symbol,
        buys:   recent.length,
        buyers: new Set(recent.map((r) => r.filer ?? `?${r.day}`)).size,
        value:  values.length ? values.reduce((a, b) => a + b, 0) : null,
        last:   recent.map((r) => r.day).sort().at(-1)!,
      }];
    })
    .sort((a, b) => (b.buyers - a.buyers) || ((b.value ?? 0) - (a.value ?? 0)))
    .slice(0, LIST_CAP);
}

/**
 * Where the analysts' actions of the last `ANALYST_DAYS` lean upwards: an
 * upgrade weighs two, a raised target one, and the downgrades and cuts are
 * taken off. Targets follow a rising price as a matter of course, so a few
 * raises alone do not make the list.
 */
export function analystsWarming(moves: ReadonlyMap<string, readonly AnalystMove[]>, now: Date): AnalystItem[] {
  const from = since(now, ANALYST_DAYS);
  return [...moves]
    .flatMap(([symbol, rows]): (AnalystItem & { net: number })[] => {
      const recent = rows.filter((r) => r.at >= from);
      const upgrades = recent.filter((r) => r.action === 'up').length;
      const downgrades = recent.filter((r) => r.action === 'down').length;
      const raises = recent.filter((r) => r.target === 'Raises').length;
      const cuts = recent.filter((r) => r.target === 'Lowers').length;
      const net = 2 * (upgrades - downgrades) + (raises - cuts);
      if (net < ANALYST_MIN_NET || upgrades < downgrades) return [];
      const firms = [...new Set(recent
        .filter((r) => r.action === 'up' || r.target === 'Raises')
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((r) => r.firm))];
      return [{ symbol, upgrades, downgrades, raises, cuts, firms, last: recent.map((r) => r.at).sort().at(-1)!.slice(0, 10), net }];
    })
    .sort((a, b) => (b.net - a.net) || b.last.localeCompare(a.last))
    .slice(0, LIST_CAP)
    .map(({ net: _, ...item }) => item);
}

/** Every list, and the stocks they name. */
export function discoverUniverse(input: {
  stocks:   readonly UniverseStock[];
  verdicts: ReadonlyMap<string, readonly VerdictReading[]>;
  moves:    ReadonlyMap<string, readonly AnalystMove[]>;
  buys:     ReadonlyMap<string, readonly InsiderBuy[]>;
  now:      Date;
}): DiscoverUniverse {
  const known = new Map(input.stocks.map((s) => [s.symbol, s]));
  const only = <T>(m: ReadonlyMap<string, T>) => new Map([...m].filter(([s]) => known.has(s)));
  const lists: DiscoverLists = {
    best:     bestScores(input.stocks),
    turns:    verdictTurns(only(input.verdicts), input.now),
    cheap:    belowValue(input.stocks),
    insiders: insiderBuying(only(input.buys), input.now),
    analysts: analystsWarming(only(input.moves), input.now),
  };
  const named = new Set(Object.values(lists).flatMap((l: { symbol: string }[]) => l.map((x) => x.symbol)));
  const dates = input.stocks.map((s) => s.asOf).filter((d): d is string => !!d).sort();
  return {
    ...lists,
    size:   input.stocks.length,
    newest: dates.at(-1) ?? null,
    oldest: dates[0] ?? null,
    stocks: Object.fromEntries([...named].map((s) => [s, known.get(s)!])),
  };
}
