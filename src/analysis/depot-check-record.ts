/**
 * What came of the depot checks: every step a check suggested — the depot
 * manager's and the check's own two lists — measured from the check's day
 * against the S&P 500, the way the verdict record and the review measure
 * theirs. A purchase was right when the stock beat the index afterwards; a
 * reduction, a sale or a profit taken when it lagged; holding and watching
 * are measured but not scored.
 *
 * The record starts with the first check kept. For months it will rest on a
 * few dozen steps over a few weeks, and the page says so: a median of five
 * steps is not a finding.
 *
 * Pure and dependency-free: the web app imports the types.
 */

import { MANAGER_ACTIONS, type DepotCheckResult, type ManagerAction } from './depot-check.js';

/** The check's own lists beside the manager's actions: the rule of score and chart, measured on its own. */
export const LIST_GROUPS = ['liste: kaufen ansehen', 'liste: reduzieren ansehen'] as const;
export type RecordGroup = ManagerAction | (typeof LIST_GROUPS)[number];
export const RECORD_GROUPS: readonly RecordGroup[] = [...MANAGER_ACTIONS, ...LIST_GROUPS];

/** Which way a step bets: up wants the stock to beat the index, down to lag it. */
export const GROUP_SIDE: Record<RecordGroup, 'up' | 'down' | null> = {
  'kaufen': 'up', 'aufstocken': 'up', 'halten': null, 'gewinne mitnehmen': 'down', 'reduzieren': 'down',
  'verkaufen': 'down', 'beobachten': null, 'liste: kaufen ansehen': 'up', 'liste: reduzieren ansehen': 'down',
};

/** One step of one check, to be measured. */
export interface CheckStep {
  key:    string;
  checkAt: string;
  /** The check's day, which the measure starts from. */
  day:    string;
  symbol: string;
  name:   string | null;
  group:  RecordGroup;
}

export interface StepOutcome extends CheckStep {
  /** The stock and the index since the check, in dollars; excess is the one over the other. */
  stock:  number | null;
  excess: number | null;
  hit:    boolean | null;
}

export interface GroupRecord {
  group:        RecordGroup;
  n:            number;
  /** Steps measured against the index. */
  measured:     number;
  medianExcess: number | null;
  /** Of the steps that bet a way, how many it went. */
  hits:         number;
  scored:       number;
  /** Median days since the check: how long the steps have had. */
  medianDays:   number | null;
}

/** Every step of every check: the manager's moves and the two lists, each stock once per group and check. */
export function checkSteps(checks: readonly { id: number; result: DepotCheckResult }[]): CheckStep[] {
  const out: CheckStep[] = [];
  for (const { id, result: r } of checks) {
    const day = r.generatedAt.slice(0, 10);
    const names = new Map([...r.candidates, ...r.holdings].map((c) => [c.symbol, c.name]));
    const add = (symbol: string, group: RecordGroup) => {
      const key = `${id}|${group}|${symbol}`;
      if (!out.some((s) => s.key === key)) out.push({ key, checkAt: r.generatedAt, day, symbol, name: names.get(symbol) ?? null, group });
    };
    for (const m of r.manager?.moves ?? []) add(m.symbol, m.action);
    for (const c of r.lists.buy) add(c.symbol, 'liste: kaufen ansehen');
    for (const c of r.lists.reduce) add(c.symbol, 'liste: reduzieren ansehen');
  }
  return out;
}

/** Whether a step went the way it bet. */
export function stepHit(group: RecordGroup, excess: number | null): boolean | null {
  const side = GROUP_SIDE[group];
  if (side === null || excess === null) return null;
  return side === 'up' ? excess > 0 : excess < 0;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Each group's record, in the order of `RECORD_GROUPS`; groups without a step are left out. */
export function groupRecord(outcomes: readonly StepOutcome[], today: string): GroupRecord[] {
  return RECORD_GROUPS.flatMap((group) => {
    const xs = outcomes.filter((o) => o.group === group);
    if (xs.length === 0) return [];
    const measured = xs.filter((o) => o.excess !== null);
    const scored = xs.filter((o) => o.hit !== null);
    return [{
      group, n: xs.length, measured: measured.length,
      medianExcess: median(measured.map((o) => o.excess!)),
      hits: scored.filter((o) => o.hit).length, scored: scored.length,
      medianDays: median(xs.map((o) => (Date.parse(today) - Date.parse(o.day)) / 86_400_000)),
    }];
  });
}

/** What the newest check says differently from the one before it, stock by stock. */
export function changesSince(before: DepotCheckResult | null, now: DepotCheckResult): { symbol: string; name: string | null; from: ManagerAction | null; to: ManagerAction | null }[] {
  if (!before?.manager || !now.manager) return [];
  const was = new Map(before.manager.moves.map((m) => [m.symbol, m.action]));
  const is = new Map(now.manager.moves.map((m) => [m.symbol, m.action]));
  const names = new Map([...now.candidates, ...now.holdings, ...before.candidates, ...before.holdings].map((c) => [c.symbol, c.name]));
  return [...new Set([...was.keys(), ...is.keys()])]
    .filter((s) => was.get(s) !== is.get(s))
    .map((symbol) => ({ symbol, name: names.get(symbol) ?? null, from: was.get(symbol) ?? null, to: is.get(symbol) ?? null }));
}

/** The history the page shows under the check. */
export interface DepotCheckHistory {
  checks:   { id: number; generatedAt: string; moves: number; model: string }[];
  record:   GroupRecord[];
  /** The newest check against the one before it. */
  changes:  ReturnType<typeof changesSince>;
  /** Every step measured, newest check first. */
  outcomes: StepOutcome[];
}
