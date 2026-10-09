/**
 * The depot check: which stocks off the depot are worth an analysis, and, once
 * analysed, which of them — and which held ones — a reader might act on; for
 * every stock held, where the chart would put a stop and a trailing stop; and
 * what a depot manager would make of it all, the market included.
 *
 * Two readings must agree before a stock is listed for acting on: the score,
 * which is the numbers and the analysis text, and the chart. Whether the chart
 * adds anything, the backtest says (`backtest/stops.ts`, S&P 1500 since 2013,
 * the computed trend standing in for the model's reading): among the buys, the
 * half whose chart rose did no better than the rest (t 0.6 at six months);
 * among the weak, the half whose chart fell did 1.5 % worse over six months, in
 * both halves of the years but at t −1.3. Neither holds by the rule, so the
 * lists are a place to start looking, the page and the manager are told so,
 * and the stops' own record goes with them. What comes out are possibilities
 * to look at, not orders.
 *
 * The depot manager's text is the one place holdings reach a model, and
 * `managerInput` is the one place that decides what of them does: names,
 * sectors, weights — the funds' too, read as what they hold — and, for single
 * stocks, the gain since purchase in per cent, the months held, the thesis
 * check's counts, the purchases and sales of the position (day, price, size
 * against the position) and the reasons the owner wrote for them; the money
 * ready to invest as a share of the depot; never quantities, values, amounts
 * or fees (CLAUDE.md).
 *
 * Pure and dependency-free: the web app imports the types.
 */

import { SCORE_BANDS } from '../verdict.js';
import type { LookThrough } from './look-through.js';
import type { MarketBrief } from './market-brief.js';
import type { ListRuleRow, StopRow } from './stop-study.js';
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
  /** What the model read in the chart: its trend, the phase, the summary and the levels it names. */
  chart:       {
    trend: ChartTrend; phase?: string; summary: string; asOf: string;
    /** Absent before 9.10.2026. */
    levels?: { price: number; kind: 'support' | 'resistance'; strength: 'strong' | 'medium' | 'weak' }[];
  } | null;
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
  /** A stop level of its own — one the owner's note gave and the data bear out — in the stock's currency. */
  stopPrice?: number | null;
  reason:   string;
  /** Its answer to the owner's note on the stock, where there is one. */
  noteReply?: string | null;
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
  /** When the manager last answered: later than `generatedAt` once it was asked again. */
  managerAt?:   string;
  /** The owner's notes the manager answered, by ticker. */
  notes?:       Record<string, string>;
}

/** What the newest backtest found the stops and the lists to do (`backtest/stops.ts`). */
export interface StopEvidence {
  generatedAt: string;
  from:        string;
  to:          string;
  rows:        StopRow[];
  lists:       ListRuleRow[];
}

/** The owner's note on a stock, for the depot manager (CLAUDE.md). */
export interface DepotNote { text: string; at: string }

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

// ── A step's size ────────────────────────────────────────────────────────────

/**
 * What a target weight means for a position today. The manager names the
 * weight after the step, as a share of the depot on the check's day; a sale
 * is the share of the position that takes off — applied to the shares held
 * today — and a purchase the euros the weight adds at today's depot value.
 * Counted here, on the page, because the model never sees a quantity or an
 * amount.
 */
export type StepSize =
  | { kind: 'sell'; fraction: number; shares: number | null; euros: number | null }
  | { kind: 'buy'; euros: number; shares: number | null };

export function stepSize(
  targetPct: number | null | undefined, weightAtCheck: number | null,
  now: { quantity: number; valueEur: number | null } | null, totalEur: number,
): StepSize | null {
  if (targetPct == null) return null;
  const target = targetPct / 100;
  const before = weightAtCheck ?? 0;
  if (target < before - 1e-9) {
    const fraction = Math.min(1, 1 - target / before);
    return { kind: 'sell', fraction, shares: now ? now.quantity * fraction : null, euros: now?.valueEur != null ? now.valueEur * fraction : null };
  }
  if (target > before + 1e-9) {
    const euros = (target - before) * totalEur;
    const price = now && now.valueEur != null && now.quantity > 0 ? now.valueEur / now.quantity : null;
    return { kind: 'buy', euros, shares: price ? euros / price : null };
  }
  return null;
}

/** A share of a position in words: „die Hälfte“, „gut ein Drittel“, „alles“; else in per cent. */
export function shareWords(f: number): string {
  if (f >= 0.97) return 'alles';
  const words: [number, string][] = [[1 / 4, 'ein Viertel'], [1 / 3, 'ein Drittel'], [1 / 2, 'die Hälfte'], [2 / 3, 'zwei Drittel'], [3 / 4, 'drei Viertel']];
  const [x, w] = words.reduce((a, b) => (Math.abs(b[0] - f) < Math.abs(a[0] - f) ? b : a));
  if (Math.abs(x - f) <= 0.015) return w;
  if (Math.abs(x - f) <= 0.05) return `${f > x ? 'gut' : 'knapp'} ${w}`;
  return `${Math.round(f * 100)} %`;
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
  /** Today's euro price, to say how far a trade in euros has moved since; it does not go out. */
  priceEur?:    number | null;
}

/** A purchase or sale of a stock held, as the service hands it over: the quantity only sizes it against the position. */
export interface TradeForManager { id: number; day: string; kind: string; quantity: number; price: number; currency: string }

/** A journal entry giving the reason for a purchase or a sale: its words go out as he wrote them. */
export interface ReasonForManager { day: string; kind: 'buy' | 'sell'; body: string }

/** The newest trades of a position the manager reads; the rest only counted. */
const MAX_TRADES = 12;
const MAX_REASONS = 5;
const MAX_REASON_CHARS = 1500;
const TRADE_KIND_DE: Record<string, string> = { buy: 'Kauf', sell: 'Verkauf', 'savings-plan': 'Sparplan', 'spin-off': 'Abspaltung' };

/**
 * A position's trades, newest first: the day, the kind, the price, the size
 * against the position before it — never the quantity — and how far the price
 * has moved since, where today's price is in the trade's currency.
 */
function tradeLines(trades: readonly TradeForManager[], now: { priceEur: number | null; close: number | null; currency: string | null },
  days: (from: string) => number) {
  let held = 0;
  const lines = [...trades].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id).map((t) => {
    const before = held;
    let umfang: string | null;
    if (t.kind === 'sell') {
      const sold = Math.min(t.quantity, before);
      held -= sold;
      umfang = before > 0 ? `${Math.round((sold / before) * 100)} % der Position verkauft` : null;
    } else {
      held += t.quantity;
      umfang = before > 1e-9 ? `Position um ${Math.round((t.quantity / before) * 100)} % aufgestockt` : 'Position eröffnet';
    }
    const today = t.currency === 'EUR' && now.priceEur ? now.priceEur : now.currency === t.currency ? now.close : null;
    return {
      datum: t.day, vorTagen: days(t.day), art: TRADE_KIND_DE[t.kind] ?? t.kind,
      kurs: t.price > 0 ? Math.round(t.price * 100) / 100 : null, waehrung: t.currency, umfang,
      kursSeitdemProzent: t.price > 0 && today ? pct(today / t.price - 1) : null,
    };
  });
  return lines.reverse();
}

/** Single stocks are judged one by one; funds, coins and metals are the depot's mix. */
export const isSingleStock = (p: { assetType: string }) => p.assetType === 'stock';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10);
const trendDe: Record<ChartTrend, string> = { up: 'aufwärts', down: 'abwärts', sideways: 'seitwärts' };

/** The chart as the manager reads it: the model's trend and phase, and its summary. */
function chartLine(c: CheckedStock['chart']) {
  return c ? {
    trend: trendDe[c.trend], phase: c.phase || null, lesart: c.summary,
    marken: c.levels?.map((l) => ({ preis: l.price, art: l.kind === 'support' ? 'Unterstützung' : 'Widerstand', staerke: l.strength })) ?? [],
  } : null;
}

/** The levels and readings from the bars, as distances from the close: no price goes out. */
function technik(p: Protection | null | undefined) {
  if (!p) return null;
  return {
    kurs: Math.round(p.close * 100) / 100, waehrung: p.currency,
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
function candidateLine(c: CheckedStock, notes?: ReadonlyMap<string, string>) {
  return {
    symbol: c.symbol, name: c.name ?? c.symbol, sector: c.sector, score: c.score, urteil: c.verdict,
    chart: chartLine(c.chart), technik: technik(c.protection), notizDesAnlegers: notes?.get(c.symbol) ?? null,
  };
}

/**
 * Everything the model is told, and nothing more. Per position its name,
 * ticker, kind and weight in per cent; for a single stock also its sector, its
 * gain since purchase in per cent, the app's own score, verdict, chart reading
 * and levels, the owner's note, the position's purchases and sales (day, kind,
 * price, size against the position) and the reasons he gave for them in the
 * journal. Then the sectors' weights, the candidates, the market brief and the
 * sector funds. Quantities, values, amounts, fees, the journal's other notes
 * and the trades of funds, coins and metals stay here; so does their gain.
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
  /** The owner's notes, by ticker: his own words, sent as he wrote them for the manager. */
  notes?:       ReadonlyMap<string, string>;
  /** The trades of each stock's open position, by ticker. */
  trades?:      ReadonlyMap<string, readonly TradeForManager[]>;
  /** The journal's reasons for each stock's purchases and sales, by ticker, newest first. */
  reasons?:     ReadonlyMap<string, readonly ReasonForManager[]>;
  /** What the backtest found the stops and the lists to do; public research, nothing of the depot. */
  evidence?:    StopEvidence | null;
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
      const trades = (p.symbol && input.trades?.get(p.symbol)) || [];
      const lines = tradeLines(trades, { priceEur: p.priceEur ?? null, close: h?.protection?.close ?? null, currency: h?.protection?.currency ?? null }, days);
      const reasons = (p.symbol && input.reasons?.get(p.symbol)) || [];
      return {
        ...base, ueberFondsProzent: pct(p.viaFunds), sector: p.sector, seitKaufProzent: pct(p.gain),
        gehaltenMonate: p.openedAt ? months(p.openedAt) : null,
        thesenCheck: p.thesis ? { widerlegt: p.thesis.contradicted, gesamt: p.thesis.total, vorTagen: days(p.thesis.at) } : null,
        score: p.score, scoreVor4Wochen: p.scoreBefore?.score ?? null, urteil: p.verdict,
        chart: chartLine(h?.chart ?? null), technik: technik(h?.protection),
        termine: (p.upcoming ?? []).map((e) => ({ datum: e.day, was: e.detail ? `${e.title} — ${e.detail}` : e.title })),
        notizDesAnlegers: (p.symbol && input.notes?.get(p.symbol)) || null,
        transaktionen: lines.slice(0, MAX_TRADES),
        ...(lines.length > MAX_TRADES ? { aeltereTransaktionen: lines.length - MAX_TRADES } : {}),
        begruendungen: reasons.slice(0, MAX_REASONS).map((r) => ({
          datum: r.day, zu: r.kind === 'buy' ? 'Kauf' : 'Verkauf',
          text: r.body.length > MAX_REASON_CHARS ? `${r.body.slice(0, MAX_REASON_CHARS)} …` : r.body,
        })),
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
    kaufenAnsehen:          input.lists.buy.map((c) => candidateLine(c, input.notes)),
    hochBewertetChartNicht: input.lists.waitForChart.map((c) => candidateLine(c, input.notes)),
    markt: input.market ? {
      stand: input.market.fetchedAt.slice(0, 10),
      lage: input.market.state,
      rotation: input.market.rotation,
      sektoren: input.market.sectors.map((s) => ({ sector: s.sector, richtung: s.direction, warum: s.why })),
      treiber: input.market.drivers.map((d) => (d.impact ? `${d.what} — ${d.impact}` : d.what)),
      probleme: input.market.problems.map((x) => x.what),
      termine: input.market.calendar.map((c) => ({ datum: c.date, ereignis: c.event, worauf: c.watch })),
    } : null,
    belegeStops: input.evidence ? stopBelege(input.evidence) : null,
    belegeListen: input.evidence ? input.evidence.lists.map((x) => ({
      liste: x.rule === 'reduce' ? 'reduzierenAnsehen (Score unter 5, Chart abwärts)' : 'kaufenAnsehen (BUY, Chart aufwärts)',
      monate: x.horizon, unterschiedProzent: pct(x.diff.mean), t: x.diff.t === null ? null : Math.round(x.diff.t * 10) / 10, urteil: x.verdict,
    })) : null,
    sektorTrendUSA: input.sectorTrends.map((t) => ({
      sector: t.sector, phase: t.phase,
      gegenIndex1MProzent: pct(t.rel1m), gegenIndex3MProzent: pct(t.rel3m), gegenIndex6MProzent: pct(t.rel6m),
    })),
  };
}

/**
 * The stops' record, as the manager reads it: for the two exits it picks
 * from, over all stocks and the two groups its rules name, how often they
 * fired, what they cost against holding — with the proceeds in cash and in the
 * index — and what they did to the worst outcomes.
 */
function stopBelege(e: StopEvidence) {
  const groups: Record<string, string> = { all: 'alle Aktien', 'weak-falling': 'schwach, Chart abwärts', winners: 'Gewinner (+50 % in 12 Monaten)' };
  return {
    zeitraum: `S&P 1500, ${e.from.slice(0, 4)} bis ${e.to.slice(0, 4)}`,
    regeln: e.rows.filter((r) => r.rule !== 'chandelier' && groups[r.group]).map((r) => ({
      regel: r.rule, gruppe: groups[r.group], monate: r.horizon,
      ausgeloestProzent: pct(r.stopped),
      kostetGegenHaltenProzent: pct(r.diff.mean), t: r.diff.t === null ? null : Math.round(r.diff.t * 10) / 10,
      kostetMitGeldImIndexProzent: pct(r.diffIndex?.mean ?? null),
      schlechteste5ProzentHalten: pct(r.p05Hold), schlechteste5ProzentMitStop: pct(r.p05Rule),
      verlustAb20ProzentHalten: pct(r.deepHold), verlustAb20ProzentMitStop: pct(r.deepRule),
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
  '  transaktionen: die Käufe und Verkäufe der laufenden Position, neueste zuerst (aeltereTransaktionen zählt, was davor',
  '  liegt): datum, vorTagen, art, kurs je Aktie in waehrung, umfang gegen die Position davor, kursSeitdemProzent.',
  '  begruendungen: was der Anleger zu seinen Käufen und Verkäufen ins Journal schrieb, im Wortlaut.',
  '- liquiditaetProzent: Geld, das der Anleger bereitliegen hat, in Prozent des Depotwerts; null, wenn er keines angab.',
  '- notizDesAnlegers: was der Anleger selbst zu der Aktie schreibt — eine Marke, die er sieht, ein Plan, ein Zweifel.',
  `  score: 0 bis 10, aus Kennzahlen und Analysetext; urteil: ${bandsDe}. Im Backtest sagt der Score die Rendite des`,
  '  nächsten Monats nur schwach voraus (Rangkorrelation 0,014). Stütze dich nicht auf kleine Unterschiede.',
  '- chart: Trend und Phase laut Chart-Lesung, lesart ihre Zusammenfassung, marken die Unterstützungen und Widerstände,',
  '  die sie für wichtig hält (Preise in der Handelswährung).',
  '- technik, aus den Kursen gerechnet: kurs (letzter Schlusskurs in waehrung); rsi (über 70 heiß gelaufen, unter 30 ausverkauft); ueber200TageProzent (Abstand',
  '  zur 200-Tage-Linie); kanal3Monate (Lage im Kanal der letzten drei Monate); tagesschwankungProzent (typische',
  '  Tagesbewegung); stopProzent (wo ein Stop läge, vom Kurs aus: unter der nächsten tragenden Unterstützung, sonst drei',
  '  Tagesschwankungen tiefer); trailingProzent (Abstand eines Trailing-Stops vom Hoch der letzten 22 Handelstage);',
  '  widerstandProzent (nächster Widerstand darüber).',
  '- kaufenAnsehen: außerhalb des Depots, hoch bewertet, Chart aufwärts; hochBewertetChartNicht: hoch bewertet, Chart (noch) nicht.',
  '- markt: aktuelle Recherche zu Lage, Rotation, Sektoren, Treibern, Problemen und Terminen.',
  '  sektorTrendUSA: eigene Messung der US-Sektorfonds gegen den S&P 500 (führt, verliert Schwung, hinkt, holt auf).',
  '- durchgerechnet: Sektoren und größte Einzelwerte des ganzen Depots, die Fonds als das gelesen, was sie halten (ihre',
  '  Sektoren und alle ihre Werte, wo der Anbieter sie veröffentlicht, sonst ihre zehn größten); fondsBeschriebenProzent:',
  '  wie viel des Depots in so beschriebenen Fonds liegt.',
  '- grenzen: ab dieser Positions- bzw. Sektorgröße ist es ein Klumpen.',
  '',
  'Wie du vorgehst:',
  '- Jede Aktie im depot bekommt genau einen Schritt, auch „halten“ ist einer. Dazu höchstens fünf Käufe oder',
  '  Beobachtungen aus kaufenAnsehen und hochBewertetChartNicht.',
  '- Der Einstand ist versunken. Ein Verlust ist kein Grund zu halten („es dreht schon“), ein Gewinn allein kein Grund',
  '  zu verkaufen; entscheidend sind Score, Chart und Markt von heute. Sag offen, wenn Halten nur am Einstand hängt.',
  '- Gewinne mitnehmen: bei großem Gewinn, wenn der Chart heiß gelaufen ist (rsi über 70, weit über der 200-Tage-Linie,',
  '  über dem Kanal) oder der Score nachlässt — dann einen Teil, nicht alles.',
  '- Lies transaktionen, bevor du einen Schritt nennst. Hat der Anleger in den letzten Wochen schon einen Teil verkauft, hat',
  '  er Gewinne gerade mitgenommen: dann nicht noch einmal „gewinne mitnehmen“ oder „reduzieren“, es sei denn, seither hat',
  '  sich etwas geändert (Kurs seit dem Verkauf deutlich höher, Chart heiß gelaufen, Score gefallen, These widerlegt) —',
  '  dann sag, was. Hat er gerade gekauft oder aufgestockt, hat er sich eben dafür entschieden: dagegen nur mit einem',
  '  Grund, der neu ist oder den er übersehen hat. Prüfe begruendungen an den Daten von heute und sag im reason, wenn',
  '  der Grund nicht mehr trägt.',
  '- Schutz für jede Aktie im Depot: „trailing“ für Gewinner, deren Trend noch läuft (sichert den Gewinn, ohne den',
  '  Trend abzuschneiden); „stop“ für Positionen im Abwärtstrend oder mit schwachem Score (die Marke, an der die Lesart',
  '  widerlegt ist); „keiner“, wo eine Marke nur das Rauschen träfe oder der Schutz seinen Preis nicht wert ist.',
  '- belegeStops sagt, was diese Stops im Backtest taten: wie oft sie auslösten, was sie gegenüber Halten kosteten (das',
  '  Geld danach bar, und danach im Index) und wie sie die schlimmsten Verluste begrenzten. Ein Stop ist eine Versicherung',
  '  mit Prämie, kein Renditebringer. Die Prämie ist vor allem der Markt, den das Geld nach dem Stop verpasst:',
  '  kostetGegenHaltenProzent gilt, wenn es bar liegt, kostetMitGeldImIndexProzent, wenn es gleich wieder angelegt wird.',
  '  Empfiehl einen Stop, wo ein großer Verlust nicht tragbar wäre — großes Gewicht, widerlegte oder schwache These, starke',
  '  Schwankung, ein Verlust, den der Anleger nicht weiter laufen lassen will —, nicht für jede Aktie, und sag dazu, dass',
  '  das Geld nach einem Stop wieder angelegt werden sollte. Bei Gewinnern kostet er laut belegeStops auch dann.',
  '- belegeListen sagt, ob die Chart-Bedingung der beiden Listen im Backtest trug; „nicht belegt“ heißt: Der Chart allein',
  '  trennt dort nicht, stütze dich nicht auf ihn.',
  '- Termine: Vor Quartalszahlen nicht ohne Grund nachkaufen; ein Stop schützt nicht vor einer Kurslücke am Tag danach.',
  '- Eine widerlegte Kaufthese wiegt schwer: Der Grund, aus dem gekauft wurde, gilt nicht mehr. Eine junge Position',
  '  (wenige Monate) nicht wegen kurzer Schwankungen aufgeben, eine alte nicht aus Gewohnheit halten.',
  '- Bei verkaufen ist protect der Schutz bis zum Verkauf.',
  '- Gibt es notizDesAnlegers, prüfe sie an den Daten (Kurs, Marken, technik) und antworte in noteReply: was dafür spricht,',
  '  was dagegen, ob du deinen Schritt deshalb änderst. Nennt er eine Stop-Marke, die die Daten tragen, übernimm sie als',
  '  stopPrice (protect "stop"); trägt sie nicht, sag warum und lass stopPrice null. Ohne Notiz ist noteReply null.',
  '- reason ist nur das Warum, aus den Daten. Zielgewicht, Stückzahlen, Beträge, Stop-Marke und Trailing-Abstand rechnet',
  '  und zeigt die Seite selbst neben deinem Text: Nenne sie im reason nicht.',
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
  `    "protect": ${PROTECTIONS.map((p) => `"${p}"`).join(' | ')} | null, "targetPct": Zahl | null, "stopPrice": Zahl | null,`,
  '    "reason": "ein bis zwei Sätze: warum, aus den Daten", "noteReply": "Antwort auf notizDesAnlegers" | null } ],',
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
