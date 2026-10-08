/**
 * The depot check: which stocks off the depot are worth an analysis, and, once
 * analysed, which of them — and which held ones — a reader might act on.
 *
 * Two readings must agree before a stock is listed for acting on: the score,
 * which is the numbers and the analysis text, and the chart. The backtest gives
 * the pairing some support where it gives the score alone little: among the
 * top tenth by score, the half the price had confirmed beat the half it had not
 * by 2.5 % over six months (t 2.0, in both halves of the years), while the
 * score by itself ranks the next month at 0.014. What comes out are
 * possibilities to look at, not orders, and the page says so.
 *
 * The depot manager's text is the one place holdings reach a model, and
 * `managerInput` is the one place that decides what of them does: names,
 * sectors and weights in per cent of the depot — never quantities, prices
 * paid, values, gains or dates (CLAUDE.md).
 *
 * Pure and dependency-free: the web app imports the types.
 */

import { SCORE_BANDS } from '../verdict.js';

export type ChartTrend = 'up' | 'down' | 'sideways';

export interface DepotCheckSettings {
  /** Score a stock off the depot needs to be a candidate. */
  minScore:      number;
  /** At most this many candidates, the best first. */
  maxCandidates: number;
  /** A held stock scored below this is weighed for reducing. */
  reduceBelow:   number;
}

export interface ScoredStock {
  symbol:  string;
  name:    string | null;
  sector:  string | null;
  score:   number | null;
  verdict: string | null;
}

export interface CheckedStock extends ScoredStock {
  /** The score that made a candidate one, before its analysis; null for a held stock. */
  scoreBefore: number | null;
  /** What the model read in the chart: its trend and the one-line summary. */
  chart:       { trend: ChartTrend; summary: string; asOf: string } | null;
  /** Share of the depot, for a held stock; null for a candidate. */
  weight:      number | null;
  /** What went wrong analysing it or reading its chart, if anything did. */
  error:       string | null;
}

export interface DepotCheckLists {
  /** Off the depot: still above the bar after the analysis, a buy verdict, a rising chart. */
  buy:          CheckedStock[];
  /** Off the depot and still above the bar, but the chart does not rise — or the verdict was held back. */
  waitForChart: CheckedStock[];
  /** Candidates the analysis took below the bar. */
  dropped:      CheckedStock[];
  /** In the depot, scored below `reduceBelow`, and the chart falls. */
  reduce:       CheckedStock[];
  /** In the depot and scored below `reduceBelow`, but the chart does not fall. */
  watch:        CheckedStock[];
}

/** What a depot manager would do, as the model answers. */
export interface ManagerView {
  summary: string;
  moves:   { action: ManagerAction; symbol: string; reason: string }[];
  risks:   string[];
}

export const MANAGER_ACTIONS = ['kaufen', 'aufstocken', 'reduzieren', 'verkaufen', 'halten', 'beobachten'] as const;
export type ManagerAction = (typeof MANAGER_ACTIONS)[number];

export interface DepotCheckResult {
  generatedAt:  string;
  settings:     DepotCheckSettings;
  /** The model the analyses, chart readings and the manager's text were asked of. */
  model:        string;
  candidates:   CheckedStock[];
  /** The held stocks scored below `reduceBelow`, the ones the check read the chart of. */
  holdings:     CheckedStock[];
  lists:        DepotCheckLists;
  manager:      ManagerView | null;
  managerError: string | null;
}

export interface DepotCheckStatus {
  state:      'running' | 'done' | 'failed' | 'interrupted';
  startedAt:  string;
  finishedAt: string | null;
  /** What it is doing, for the page: „Analyse 4/25: ASML.AS“. */
  phase:      string | null;
  done:       number;
  total:      number;
  error:      string | null;
}

/** The stocks off the depot scored at or above the bar, best first, at most `maxCandidates`. */
export function selectCandidates(
  stocks: readonly ScoredStock[], held: ReadonlySet<string>, s: DepotCheckSettings,
): ScoredStock[] {
  return stocks
    .filter((x) => x.score !== null && x.score >= s.minScore && !held.has(x.symbol))
    .sort((a, b) => (b.score! - a.score!) || a.symbol.localeCompare(b.symbol))
    .slice(0, s.maxCandidates);
}

const BUY_VERDICTS = new Set(['BUY', 'STRONG BUY']);

/** Sorts the analysed candidates and the weak holdings into what a reader might act on. */
export function classifyDepotCheck(
  candidates: readonly CheckedStock[], holdings: readonly CheckedStock[], s: DepotCheckSettings,
): DepotCheckLists {
  const byScore = (a: CheckedStock, b: CheckedStock) => (b.score ?? -1) - (a.score ?? -1) || a.symbol.localeCompare(b.symbol);
  const above = candidates.filter((c) => c.score !== null && c.score >= s.minScore);
  const weak = holdings.filter((h) => h.score !== null && h.score < s.reduceBelow);
  const buys = (c: CheckedStock) => BUY_VERDICTS.has(c.verdict ?? '') && c.chart?.trend === 'up';
  return {
    buy:          above.filter(buys).sort(byScore),
    waitForChart: above.filter((c) => !buys(c)).sort(byScore),
    dropped:      candidates.filter((c) => !above.includes(c)).sort(byScore),
    reduce:       weak.filter((h) => h.chart?.trend === 'down').sort((a, b) => -byScore(a, b)),
    watch:        weak.filter((h) => h.chart?.trend !== 'down').sort((a, b) => -byScore(a, b)),
  };
}

// ── The depot manager ────────────────────────────────────────────────────────

/** A held position as the check sees it: the depot view's, of which only some fields go further. */
export interface HeldForManager {
  symbol:    string | null;
  name:      string;
  assetType: string;
  sector:    string | null;
  weight:    number | null;
  score:     number | null;
  verdict:   string | null;
}

const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);
const trendDe: Record<ChartTrend, string> = { up: 'aufwärts', down: 'abwärts', sideways: 'seitwärts' };

/** A stock as the manager reads it: no figure the check did not produce itself. */
function stockLine(c: CheckedStock) {
  return {
    symbol: c.symbol, name: c.name ?? c.symbol, sector: c.sector, score: c.score, urteil: c.verdict,
    chart: c.chart ? `${trendDe[c.chart.trend]}: ${c.chart.summary}` : null,
  };
}

/**
 * Everything the model is told, and nothing more: each position's name,
 * ticker, kind, sector, its weight in per cent, and the app's own score,
 * verdict and chart reading of it; the sectors' weights; the check's lists.
 * Quantities, prices paid, values, gains, dates and the journal stay here.
 */
export function managerInput(input: {
  positions: readonly HeldForManager[];
  sectors:   readonly { sector: string; weight: number }[];
  charts:    ReadonlyMap<string, CheckedStock['chart']>;
  lists:     DepotCheckLists;
  limits:    { maxPosition: number; maxSector: number };
}) {
  return {
    depot: input.positions.map((p) => ({
      name: p.name, symbol: p.symbol, art: p.assetType, sector: p.sector, gewichtProzent: pct(p.weight),
      score: p.score, urteil: p.verdict,
      chart: p.symbol && input.charts.get(p.symbol) ? trendDe[input.charts.get(p.symbol)!.trend] : null,
    })),
    sektorenProzent: input.sectors.map((s) => ({ sector: s.sector, gewichtProzent: pct(s.weight) })),
    kaufenAnsehen:         input.lists.buy.map(stockLine),
    hochBewertetChartNicht: input.lists.waitForChart.map(stockLine),
    reduzierenAnsehen:     input.lists.reduce.map(stockLine),
    schwachChartHaelt:     input.lists.watch.map(stockLine),
    grenzen: { positionProzent: pct(input.limits.maxPosition), sektorProzent: pct(input.limits.maxSector) },
  };
}

const bandsDe = SCORE_BANDS
  .map((b) => (Number.isFinite(b.min) ? `${b.verdict} ab ${b.min.toFixed(1).replace('.', ',')}` : `${b.verdict} darunter`))
  .join(', ');

/** The system prompt: who writes, what the figures mean, and what not to do. */
export const MANAGER_SYSTEM = [
  'Du bist ein erfahrener Depotmanager und schreibst für einen Privatanleger, der sein Depot selbst führt.',
  'Du gibst keine Anlageberatung. Du zeigst, was ein Depotmanager mit diesem Depot und diesen Kandidaten tun würde und warum,',
  'als Möglichkeiten, die der Anleger selbst prüft. Grundlage sind ausschließlich die Daten in der Nachricht:',
  'erfinde keine Kurse, Kennzahlen, Nachrichten oder Termine.',
  '',
  'Was die Daten bedeuten:',
  `- score: 0 bis 10, aus Kennzahlen und Analysetext; urteil: ${bandsDe}. Im Backtest sagt der Score die Rendite des nächsten Monats`,
  '  nur schwach voraus (Rangkorrelation 0,014). Stütze dich nicht auf kleine Unterschiede.',
  '- chart: Trend laut Chart-Lesung (aufwärts, abwärts, seitwärts) und ihre Zusammenfassung.',
  '- gewichtProzent: Anteil am Depotwert. grenzen: ab dieser Position- bzw. Sektorgröße ist es ein Klumpen.',
  '- kaufenAnsehen: hoch bewertet und Chart aufwärts; hochBewertetChartNicht: hoch bewertet, Chart (noch) nicht;',
  '  reduzierenAnsehen: im Depot, schwach bewertet, Chart abwärts; schwachChartHaelt: im Depot, schwach, Chart hält.',
  '',
  'Wie du vorgehst:',
  '- Denk an das ganze Depot: Klumpen, Sektoren, wie viele Positionen. Ein Kauf, der einen Sektor über die Grenze bringt, ist eher keiner.',
  '- Fonds und ETFs nicht wegen ihres Gewichts reduzieren; sie streuen selbst.',
  '- Wenige, begründete Schritte statt vieler. Lieber „beobachten“ als ein schwach begründeter Kauf oder Verkauf.',
  '- Schreibe Deutsch, knapp und konkret, ohne Floskeln. Nenne Aktien mit Namen und Ticker. Zahlen mit Dezimalkomma (8,4; 12,3 %).',
  '',
  'Du antwortest ausschließlich mit einem JSON-Objekt nach diesem Schema:',
  '{',
  '  "summary": "drei bis fünf Sätze: was ein Depotmanager mit diesem Depot jetzt tun würde, und warum",',
  `  "moves": [ { "action": ${MANAGER_ACTIONS.map((a) => `"${a}"`).join(' | ')}, "symbol": "Ticker wie in den Daten", "reason": "ein Satz Begründung" } ],`,
  '  "risks": [ "was er im Blick behält: Klumpen, Sektoren, was gegen die Schritte spricht" ]',
  '}',
  'moves: je Aktie höchstens ein Schritt, die wichtigsten zuerst, höchstens zehn.',
].join('\n');

/** The message: the input as JSON, with the question. */
export function managerUser(input: ReturnType<typeof managerInput>): string {
  return [
    'Hier ist das Depot mit den Ergebnissen des Depot-Checks.',
    'Was würde ein Depotmanager jetzt tun? Gib eine kurze Einschätzung, die Schritte (je Aktie eine Handlung mit Begründung)',
    'und die Risiken, die er im Blick behält.',
    '',
    JSON.stringify(input, null, 1),
  ].join('\n');
}
