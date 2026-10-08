/**
 * The depot check: which stocks off the depot are worth an analysis, and, once
 * analysed, which of them — and which held ones — a reader might act on; for
 * every stock held, where the chart would put a stop and a trailing stop; and
 * what a depot manager would make of it all, the market included.
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
 * sectors, weights — the funds' too, read as what they hold — and, for single
 * stocks, the gain since purchase in per cent, the months held and the thesis
 * check's counts; the money ready to invest as a share of the depot; never
 * quantities, prices paid, values, amounts or the dates of trades (CLAUDE.md).
 *
 * Pure and dependency-free: the web app imports the types.
 */

import { SCORE_BANDS } from '../verdict.js';
import type { LookThrough } from './look-through.js';
import type { MarketBrief } from './market-brief.js';
import type { SectorTrend } from './sector-rotation.js';
import type { Protection } from './stops.js';

export type ChartTrend = 'up' | 'down' | 'sideways';

export interface DepotCheckSettings {
  /** Score a stock off the depot needs to be a candidate. */
  minScore:      number;
  /** At most this many candidates, the best first. */
  maxCandidates: number;
  /** A held stock scored below this is weighed for reducing. */
  reduceBelow:   number;
  /** Perplexity model of the market brief; null for none. Absent before 8.10.2026. */
  marketModel?:  string | null;
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
  /** What the model read in the chart: its trend, the phase and the summary. */
  chart:       { trend: ChartTrend; phase?: string; summary: string; asOf: string } | null;
  /** Stop and trailing stop from the bars, and the readings beside them. Absent before 8.10.2026. */
  protection?: Protection | null;
  /** Share of the depot, for a held stock; null for a candidate. */
  weight:      number | null;
  /** Value over cost less one, for a held stock. Absent before 8.10.2026. */
  gain?:       number | null;
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

export const MANAGER_ACTIONS = [
  'kaufen', 'aufstocken', 'halten', 'gewinne mitnehmen', 'reduzieren', 'verkaufen', 'beobachten',
] as const;
export type ManagerAction = (typeof MANAGER_ACTIONS)[number];

/** How a held position is protected: which of the chart's two levels, or neither. */
export const PROTECTIONS = ['stop', 'trailing', 'keiner'] as const;
export type ProtectionChoice = (typeof PROTECTIONS)[number];

export interface ManagerMove {
  action:   ManagerAction;
  symbol:   string;
  /** For a held stock; null for a purchase. Absent before 8.10.2026. */
  protect?: ProtectionChoice | null;
  /** The weight it would have after the step, in per cent of today's depot; the page turns it into euros. */
  targetPct?: number | null;
  reason:   string;
}

/** What a depot manager would do, as the model answers. */
export interface ManagerView {
  summary: string;
  moves:   ManagerMove[];
  risks:   string[];
}

export interface DepotCheckResult {
  generatedAt:  string;
  settings:     DepotCheckSettings;
  /** The model the analyses, chart readings and the manager's text were asked of. */
  model:        string;
  candidates:   CheckedStock[];
  /** Every single stock held, its chart read. Before 8.10.2026 only those under `reduceBelow`. */
  holdings:     CheckedStock[];
  lists:        DepotCheckLists;
  /** Perplexity's market brief, as the manager read it. Absent before 8.10.2026. */
  market?:      MarketBrief | null;
  marketError?: string | null;
  /** The US sector funds against the index. Absent before 8.10.2026. */
  sectorTrends?: SectorTrend[];
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

/** Sorts the analysed candidates and the held stocks into what a reader might act on. */
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
  gain:      number | null;
  score:     number | null;
  verdict:   string | null;
  /** What the funds add to its weight. */
  viaFunds?:    number | null;
  /** The score about four weeks ago. */
  scoreBefore?: { score: number; at: string } | null;
  /** What is scheduled for it. */
  upcoming?:    { day: string; title: string; detail: string | null }[];
  /** When the position was opened: only the months since go out. */
  openedAt?:    string;
  /** The newest thesis check: only its counts and age go out, never the theses. */
  thesis?:      { contradicted: number; total: number; at: string } | null;
}

/** Single stocks are judged one by one; funds, coins and metals are the depot's mix. */
export const isSingleStock = (p: { assetType: string }) => p.assetType === 'stock';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10);
const trendDe: Record<ChartTrend, string> = { up: 'aufwärts', down: 'abwärts', sideways: 'seitwärts' };

/** The chart as the manager reads it: the model's trend and phase, and its summary. */
function chartLine(c: CheckedStock['chart']) {
  return c ? { trend: trendDe[c.trend], phase: c.phase || null, lesart: c.summary } : null;
}

/** The levels and readings from the bars, as distances from the close: no price goes out. */
function technik(p: Protection | null | undefined) {
  if (!p) return null;
  return {
    rsi: p.rsi === null ? null : Math.round(p.rsi),
    ueber200TageProzent: pct(p.overSma200),
    kanal3Monate: p.channel,
    tagesschwankungProzent: pct(p.dailyMove),
    stopProzent: pct(p.stop?.distance),
    stopUnter: p.stop ? (p.stop.basis === 'support' ? 'Unterstützung' : 'drei Tagesschwankungen unter dem Kurs') : null,
    trailingProzent: pct(p.trailing?.width),
    widerstandProzent: pct(p.resistance),
  };
}

/** A stock off the depot as the manager reads it. */
function candidateLine(c: CheckedStock) {
  return {
    symbol: c.symbol, name: c.name ?? c.symbol, sector: c.sector, score: c.score, urteil: c.verdict,
    chart: chartLine(c.chart), technik: technik(c.protection),
  };
}

/**
 * Everything the model is told, and nothing more. Per position its name,
 * ticker, kind and weight in per cent; for a single stock also its sector, its
 * gain since purchase in per cent, and the app's own score, verdict, chart
 * reading and chart levels — the levels as distances, never as prices. Then the
 * sectors' weights, the candidates, the market brief and the sector funds.
 * Quantities, prices paid, values, dates, trades and the journal stay here; so
 * does the gain of a fund, a coin or a metal.
 */
export function managerInput(input: {
  positions:    readonly HeldForManager[];
  sectors:      readonly { sector: string; weight: number }[];
  /** The checked single stocks held, by ticker: their chart reading and levels. */
  holdings:     ReadonlyMap<string, CheckedStock>;
  lists:        DepotCheckLists;
  limits:       { maxPosition: number; maxSector: number };
  market:       MarketBrief | null;
  sectorTrends: readonly SectorTrend[];
  lookThrough?: LookThrough | null;
  /** Money ready to invest over the depot's value; null when not entered. */
  cashShare?:   number | null;
  today?:       string;
}) {
  const lt = input.lookThrough;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const months = (from: string) => Math.max(0, Math.floor((Date.parse(today) - Date.parse(from)) / (30.44 * 86_400_000)));
  const days = (from: string) => Math.max(0, Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000));
  return {
    depot: input.positions.map((p) => {
      const base = { name: p.name, symbol: p.symbol, art: p.assetType, gewichtProzent: pct(p.weight) };
      if (!isSingleStock(p)) return base;
      const h = p.symbol ? input.holdings.get(p.symbol) : undefined;
      return {
        ...base, ueberFondsProzent: pct(p.viaFunds), sector: p.sector, seitKaufProzent: pct(p.gain),
        gehaltenMonate: p.openedAt ? months(p.openedAt) : null,
        thesenCheck: p.thesis ? { widerlegt: p.thesis.contradicted, gesamt: p.thesis.total, vorTagen: days(p.thesis.at) } : null,
        score: p.score, scoreVor4Wochen: p.scoreBefore?.score ?? null, urteil: p.verdict,
        chart: chartLine(h?.chart ?? null), technik: technik(h?.protection),
        termine: (p.upcoming ?? []).map((e) => ({ datum: e.day, was: e.detail ? `${e.title} — ${e.detail}` : e.title })),
      };
    }),
    durchgerechnet: lt ? {
      sektorenProzent: lt.sectors.map((x) => ({ sector: x.sector, gesamt: pct(x.total), direkt: pct(x.direct) })),
      groessteWerte: lt.stocks.map((x) => ({ name: x.name, symbol: x.symbol, direkt: pct(x.direct), ueberFonds: pct(x.viaFunds) })),
      fondsBeschriebenProzent: pct(lt.funds.known),
    } : null,
    liquiditaetProzent: pct(input.cashShare),
    sektorenProzent: input.sectors.map((s) => ({ sector: s.sector, gewichtProzent: pct(s.weight) })),
    grenzen: { positionProzent: pct(input.limits.maxPosition), sektorProzent: pct(input.limits.maxSector) },
    kaufenAnsehen:          input.lists.buy.map(candidateLine),
    hochBewertetChartNicht: input.lists.waitForChart.map(candidateLine),
    markt: input.market ? {
      stand: input.market.fetchedAt.slice(0, 10),
      lage: input.market.state,
      rotation: input.market.rotation,
      sektoren: input.market.sectors.map((s) => ({ sector: s.sector, richtung: s.direction, warum: s.why })),
      treiber: input.market.drivers.map((d) => (d.impact ? `${d.what} — ${d.impact}` : d.what)),
      probleme: input.market.problems.map((x) => x.what),
      termine: input.market.calendar.map((c) => ({ datum: c.date, ereignis: c.event, worauf: c.watch })),
    } : null,
    sektorTrendUSA: input.sectorTrends.map((t) => ({
      sector: t.sector, phase: t.phase,
      gegenIndex1MProzent: pct(t.rel1m), gegenIndex3MProzent: pct(t.rel3m), gegenIndex6MProzent: pct(t.rel6m),
    })),
  };
}

const bandsDe = SCORE_BANDS
  .map((b) => (Number.isFinite(b.min) ? `${b.verdict} ab ${b.min.toFixed(1).replace('.', ',')}` : `${b.verdict} darunter`))
  .join(', ');

/** The system prompt: who writes, what the figures mean, how to weigh them, and what not to do. */
export const MANAGER_SYSTEM = [
  'Du bist ein erfahrener Depotmanager und schreibst für einen Privatanleger, der sein Depot selbst führt.',
  'Du gibst keine Anlageberatung. Du zeigst, was ein Depotmanager mit diesem Depot tun würde und warum,',
  'als Möglichkeiten, die der Anleger selbst prüft. Grundlage sind ausschließlich die Daten in der Nachricht:',
  'erfinde keine Kurse, Kennzahlen, Nachrichten oder Termine.',
  '',
  'Was die Daten bedeuten:',
  '- depot: jede Position mit ihrem Anteil am Depotwert (gewichtProzent). Fonds, ETFs, Krypto und Metalle stehen nur mit',
  '  Gewicht darin: Sie sind die Mischung des Depots, nicht Gegenstand einzelner Schritte.',
  '- Bei Aktien: seitKaufProzent ist, wo der Anleger mit der Position steht. ueberFondsProzent: was seine Fonds an derselben',
  '  Aktie zusätzlich halten. scoreVor4Wochen: der Score vor etwa vier Wochen; ein fallender Score sagt mehr als sein Stand.',
  '  termine: Quartalszahlen, Dividenden und Katalysatoren der nächsten Wochen. gehaltenMonate: wie lange die Position',
  '  schon läuft. thesenCheck: wie viele der Kaufthesen des Anlegers ein Abgleich mit der aktuellen Lage widerlegt sah,',
  '  vor wie vielen Tagen.',
  '- liquiditaetProzent: Geld, das der Anleger bereitliegen hat, in Prozent des Depotwerts; null, wenn er keines angab.',
  `  score: 0 bis 10, aus Kennzahlen und Analysetext; urteil: ${bandsDe}. Im Backtest sagt der Score die Rendite des`,
  '  nächsten Monats nur schwach voraus (Rangkorrelation 0,014). Stütze dich nicht auf kleine Unterschiede.',
  '- chart: Trend und Phase laut Chart-Lesung, lesart ihre Zusammenfassung.',
  '- technik, aus den Kursen gerechnet: rsi (über 70 heiß gelaufen, unter 30 ausverkauft); ueber200TageProzent (Abstand',
  '  zur 200-Tage-Linie); kanal3Monate (Lage im Kanal der letzten drei Monate); tagesschwankungProzent (typische',
  '  Tagesbewegung); stopProzent (wo ein Stop läge, vom Kurs aus: unter der nächsten tragenden Unterstützung, sonst drei',
  '  Tagesschwankungen tiefer); trailingProzent (Abstand eines Trailing-Stops vom Hoch der letzten 22 Handelstage);',
  '  widerstandProzent (nächster Widerstand darüber).',
  '- kaufenAnsehen: außerhalb des Depots, hoch bewertet, Chart aufwärts; hochBewertetChartNicht: hoch bewertet, Chart (noch) nicht.',
  '- markt: aktuelle Recherche zu Lage, Rotation, Sektoren, Treibern, Problemen und Terminen.',
  '  sektorTrendUSA: eigene Messung der US-Sektorfonds gegen den S&P 500 (führt, verliert Schwung, hinkt, holt auf).',
  '- durchgerechnet: Sektoren und größte Einzelwerte des ganzen Depots, die Fonds als das gelesen, was sie halten (ihre',
  '  zehn größten Werte und ihre Sektoren); fondsBeschriebenProzent: wie viel des Depots in so beschriebenen Fonds liegt.',
  '- grenzen: ab dieser Positions- bzw. Sektorgröße ist es ein Klumpen.',
  '',
  'Wie du vorgehst:',
  '- Jede Aktie im depot bekommt genau einen Schritt, auch „halten“ ist einer. Dazu höchstens fünf Käufe oder',
  '  Beobachtungen aus kaufenAnsehen und hochBewertetChartNicht.',
  '- Der Einstand ist versunken. Ein Verlust ist kein Grund zu halten („es dreht schon“), ein Gewinn allein kein Grund',
  '  zu verkaufen; entscheidend sind Score, Chart und Markt von heute. Sag offen, wenn Halten nur am Einstand hängt.',
  '- Gewinne mitnehmen: bei großem Gewinn, wenn der Chart heiß gelaufen ist (rsi über 70, weit über der 200-Tage-Linie,',
  '  über dem Kanal) oder der Score nachlässt — dann einen Teil, nicht alles.',
  '- Schutz für jede Aktie im Depot: „trailing“ für Gewinner, deren Trend noch läuft (sichert den Gewinn, ohne den',
  '  Trend abzuschneiden); „stop“ für Positionen im Abwärtstrend oder mit schwachem Score (die Marke, an der die Lesart',
  '  widerlegt ist); „keiner“, wo eine Marke nur das Rauschen träfe. Nenne den Abstand aus technik, erfinde keinen.',
  '  Ein Stop begrenzt Verluste, er bringt keine Rendite: Er lohnt, wo Trends laufen, und kostet, wo der Kurs nur pendelt.',
  '- Termine: Vor Quartalszahlen nicht ohne Grund nachkaufen; ein Stop schützt nicht vor einer Kurslücke am Tag danach.',
  '- Eine widerlegte Kaufthese wiegt schwer: Der Grund, aus dem gekauft wurde, gilt nicht mehr. Eine junge Position',
  '  (wenige Monate) nicht wegen kurzer Schwankungen aufgeben, eine alte nicht aus Gewohnheit halten.',
  '- Größen: Bei kaufen, aufstocken, reduzieren, gewinne mitnehmen und verkaufen nennst du targetPct, das Gewicht nach dem',
  '  Schritt in Prozent des heutigen Depotwerts (verkaufen: 0). Käufe zusammen nicht über liquiditaetProzent plus dem, was',
  '  Verkäufe freimachen; ohne Liquiditätsangabe nur aus Verkäufen. Keine Position über die Positionsgrenze.',
  '- Klumpen nach durchgerechnet beurteilen: eine Aktie, die die Fonds schon groß halten, ist doppelt im Depot.',
  '- Denk an das ganze Depot und an den Markt: Klumpen, Sektoren, ob der Markt den Sektoren der Positionen Rückenwind',
  '  oder Gegenwind gibt, welche Termine anstehen. Ein Kauf, der einen Sektor über die Grenze bringt, ist eher keiner.',
  '- Wenige, begründete Schritte statt Aktionismus. Lieber „beobachten“ als ein schwach begründeter Kauf oder Verkauf.',
  '- Schreibe Deutsch, knapp und konkret, ohne Floskeln. Nenne Aktien mit Namen. Zahlen mit Dezimalkomma (8,4; 12,3 %).',
  '',
  'Du antwortest ausschließlich mit einem JSON-Objekt nach diesem Schema:',
  '{',
  '  "summary": "drei bis fünf Sätze: was ein Depotmanager mit diesem Depot jetzt tun würde und warum, mit Blick auf den Markt",',
  `  "moves": [ { "action": ${MANAGER_ACTIONS.map((a) => `"${a}"`).join(' | ')}, "symbol": "Ticker wie in den Daten",`,
  `    "protect": ${PROTECTIONS.map((p) => `"${p}"`).join(' | ')} | null, "reason": "ein bis zwei Sätze Begründung aus den Daten" } ],`,
  '  "risks": [ "was er im Blick behält: Klumpen, Sektoren, Markt, was gegen die Schritte spricht" ]',
  '}',
  'moves: zuerst jede Aktie im Depot, die dringendsten zuerst, protect immer gesetzt; dann die Käufe mit protect null.',
].join('\n');

/** The message: the input as JSON, with the question. */
export function managerUser(input: ReturnType<typeof managerInput>): string {
  return [
    'Hier ist das Depot mit den Ergebnissen des Depot-Checks und der aktuellen Marktlage.',
    'Was würde ein Depotmanager jetzt tun? Gib eine kurze Einschätzung, je Aktie im Depot einen Schritt mit Schutz und',
    'Begründung, die Käufe, die er ansehen würde, und die Risiken, die er im Blick behält.',
    '',
    JSON.stringify(input, null, 1),
  ].join('\n');
}
