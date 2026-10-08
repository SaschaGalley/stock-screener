/**
 * The depot weighed against the model.
 *
 * The positions are summed from the trades umsatz keeps, valued at its euro
 * prices, and set beside what this app knows of each stock: the score and
 * verdict, the sector, the reason in the journal, the last check of that
 * reason. What comes out is a list of things to look at — where the depot
 * leans on one stock or one sector, where it holds what the model rates a
 * sell, where it holds something nobody wrote a reason for — not a list of
 * orders.
 *
 * Deliberately no target weights. The backtest tried the score as a portfolio
 * rule and the rule failed the test fixed before the run; the verdicts are
 * a tenth of a per cent a month apart, and STRONG SELL did no worse than the
 * average stock. A weight drawn from the score would claim more than it has
 * shown. The verdicts' record is shown beside them instead.
 *
 * Pure and dependency-free so the web app can import the types.
 */

import type { Trade } from '../journal.js';
import type { WatchSignal } from './depot-watch.js';
import { lookThrough, OTHER, type FundHoldings, type LookThrough } from './look-through.js';
import type { TimelineKind } from './timeline.js';

/** A position this large is a concentration whatever the model says of it. */
export const MAX_POSITION = 0.15;
/** A sector this large among the stocks is one bet, however many names it holds. */
export const MAX_SECTOR = 0.35;
/** Funds hold many stocks: a large weight in one is not a concentration. */
const DIVERSIFIED = new Set(['etf']);
/** Shares left after rounding are a closed position. */
const EPS = 1e-6;

export interface DepotFlag {
  /** `reduce`: a reason to look at holding less; `add`: at holding more; `ask`: something missing; `note`: a date. */
  tone:  'reduce' | 'add' | 'ask' | 'note';
  /** What it is about, so a view can say it where it belongs — a missing reason under the reason. */
  key:   'concentrated' | 'sell' | 'thesis' | 'underweight' | 'reason' | 'unscored' | 'unpriced'
    | 'trailing' | 'stop' | 'reduce' | 'earnings';
  /** A word or two, for a chip. */
  label: string;
  /** The sentence. */
  text:  string;
}

export interface DepotPosition {
  isin:        string;
  symbol:      string | null;
  name:        string;
  assetType:   string;
  quantity:    number;
  /** Average cost of the shares still held, in euros; null when any was bought in another currency. */
  costEur:     number | null;
  priceEur:    number | null;
  priceDay:    string | null;
  valueEur:    number | null;
  /** Share of the depot's valued total. */
  weight:      number | null;
  /** Above `MAX_POSITION`, and not a fund. */
  concentrated: boolean;
  /** Value against cost, dividends not included. */
  gain:        number | null;
  /** When the current position was opened — after the last time it went to zero. */
  openedAt:    string;
  lastTradeAt: string;
  tradeIds:    number[];
  /** Scored by the model: on the watchlist, with a score. */
  tracked:     boolean;
  score:       number | null;
  verdict:     string | null;
  sector:      string | null;
  /** The newest journal entry giving a reason for it. */
  reason:      { entryId: number; day: string; headline: string } | null;
  /** The newest thesis check of it. */
  thesis:      { contradicted: number; total: number; at: string } | null;
  /** The newest model reading of its chart: the trend, the session it saw last, the summary. */
  chart:       { trend: 'up' | 'down' | 'sideways'; asOf: string; summary: string } | null;
  /** The share of the depot the funds add to it, where they hold it among their largest. */
  viaFunds:    number | null;
  /** The score about four weeks ago, against which today's is a trend. */
  scoreBefore: { score: number; at: string } | null;
  /** What is scheduled for it in the coming weeks. */
  upcoming:    { day: string; kind: TimelineKind; title: string; detail: string | null }[];
  /** The night watch's signals, as they stand tonight (`depot-watch.ts`). */
  signals:     WatchSignal[];
  flags:       DepotFlag[];
}

export interface DepotView {
  /** The valued total in euros. */
  totalEur:   number;
  /** Positions without a price are listed but not in the total. */
  unvalued:   number;
  positions:  DepotPosition[];
  /** Among the stocks, by value. */
  sectors:    { sector: string; weight: number }[];
  byType:     { assetType: string; weight: number }[];
  /** What stands out across the depot, as sentences. */
  findings:   string[];
  limits:     { maxPosition: number; maxSector: number };
  /** The depot with its funds read as what they hold. */
  lookThrough: LookThrough;
  /** The market's own dates in the coming weeks, from the newest market brief. */
  market:     { day: string; event: string; watch: string }[];
  /** Money ready to invest, as the owner entered it on the page; null when not entered. */
  cashEur:    number | null;
}

/** One open position, summed from its trades. */
export interface HeldPosition {
  isin: string; symbol: string | null; name: string; assetType: string;
  quantity: number; costEur: number | null; openedAt: string; lastTradeAt: string; tradeIds: number[];
  /** Bought or sold by decision at least once — not only by a savings plan or a spin-off. */
  decided: boolean;
}

/**
 * The positions still open, from every trade in order. Cost is the moving
 * average, as umsatz keeps it: a purchase adds its cost, a sale takes away
 * its share of the cost, and a position that goes to zero starts over.
 */
export function positionsFromTrades(trades: Trade[]): HeldPosition[] {
  const sorted = [...trades].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id);
  const open = new Map<string, HeldPosition & { euro: boolean; cost: number }>();
  for (const t of sorted) {
    let p = open.get(t.isin);
    if (!p || p.quantity <= EPS) {
      p = {
        isin: t.isin, symbol: t.symbol, name: t.name, assetType: t.assetType,
        quantity: 0, costEur: null, openedAt: t.day, lastTradeAt: t.day, tradeIds: [], decided: false, euro: true, cost: 0,
      };
      open.set(t.isin, p);
    }
    p.lastTradeAt = t.day;
    p.tradeIds.push(t.id);
    if (t.kind === 'buy' || t.kind === 'sell') p.decided = true;
    p.symbol = t.symbol ?? p.symbol;
    if (t.kind === 'sell') {
      const sold = Math.min(t.quantity, p.quantity);
      if (p.quantity > EPS) p.cost -= p.cost * (sold / p.quantity);
      p.quantity -= sold;
    } else {
      p.quantity += t.quantity;
      p.cost += t.quantity * t.price;
      if (t.currency !== 'EUR') p.euro = false;
    }
  }
  return [...open.values()]
    .filter((p) => p.quantity > EPS)
    .map(({ euro, cost, ...p }) => ({ ...p, costEur: euro ? cost : null }));
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const pct1 = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} %`;
const num = (x: number) => x.toFixed(1).replace('.', ',');
const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;

/**
 * The depot as the view shows it. `model` holds the watchlist's scores by
 * ticker, `reasons` and `theses` what the journal and the thesis checks say
 * of each position.
 */
export function depotView(input: {
  held:      HeldPosition[];
  prices:    Map<string, { day: string; priceEur: number }>;
  model:     Map<string, { score: number | null; verdict: string | null; sector: string | null; name: string | null }>;
  reasons:   (p: HeldPosition) => DepotPosition['reason'];
  theses:    Map<string, NonNullable<DepotPosition['thesis']>>;
  charts?:   Map<string, NonNullable<DepotPosition['chart']>>;
  funds?:    Map<string, FundHoldings>;
  /** Scores about four weeks ago, by ticker. */
  scoresBefore?: Map<string, NonNullable<DepotPosition['scoreBefore']>>;
  upcoming?: Map<string, DepotPosition['upcoming']>;
  signals?:  Map<string, WatchSignal[]>;
  market?:   DepotView['market'];
  /** Today, for the dates: a report within a week is flagged. */
  today?:    string;
  cashEur?:  number | null;
}): DepotView {
  const { held, prices, model, reasons, theses, charts } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const weekAhead = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const valued = held.map((p) => {
    const price = prices.get(p.isin) ?? null;
    return { p, price, value: price ? p.quantity * price.priceEur : null };
  });
  const totalEur = valued.reduce((s, x) => s + (x.value ?? 0), 0);
  const counted = valued.filter((x) => x.value !== null).length;
  const average = counted > 0 ? 1 / counted : null;

  const positions: DepotPosition[] = valued.map(({ p, price, value }) => {
    const m = p.symbol ? model.get(p.symbol) : undefined;
    const weight = value !== null && totalEur > 0 ? value / totalEur : null;
    const thesis = p.symbol ? theses.get(p.symbol) ?? null : null;
    const reason = reasons(p);
    const verdict = m?.verdict ?? null;
    const flags: DepotFlag[] = [];
    // A fund is many stocks; its weight is a choice of mix, not a concentration.
    const concentrated = weight !== null && weight > MAX_POSITION && !DIVERSIFIED.has(p.assetType);
    if (concentrated) flags.push({ tone: 'reduce', key: 'concentrated', label: 'Klumpen', text: `Klumpen: ${pct(weight)} des Depots` });
    if (verdict && /SELL/.test(verdict)) {
      flags.push({ tone: 'reduce', key: 'sell', label: verdict, text: `Modell-Urteil ${verdict}${m?.score != null ? ` (${num(m.score)})` : ''}` });
    }
    if (thesis && thesis.contradicted > 0) {
      flags.push({
        tone: 'reduce', key: 'thesis', label: `These ${thesis.contradicted}/${thesis.total} widerlegt`,
        text: `Thesen-Check: ${thesis.contradicted} von ${thesis.total} widerlegt`,
      });
    }
    if (verdict && /BUY/.test(verdict) && weight !== null && average !== null && weight < average) {
      flags.push({
        tone: 'add', key: 'underweight', label: 'untergewichtet',
        text: `Modell-Urteil ${verdict}, unter dem Durchschnittsgewicht von ${pct(average)}`,
      });
    }
    // A savings plan runs by itself: what it buys was decided once, not each month.
    if (!reason && p.decided) flags.push({ tone: 'ask', key: 'reason', label: 'ohne Begründung', text: 'keine Begründung im Journal' });
    if (!m && p.assetType === 'stock') flags.push({ tone: 'ask', key: 'unscored', label: 'kein Score', text: 'nicht in der Watchlist — kein Score' });
    if (!price) flags.push({ tone: 'ask', key: 'unpriced', label: 'kein Kurs', text: 'kein Kurs aus umsatz' });
    const signals = (p.symbol && input.signals?.get(p.symbol)) || [];
    for (const sig of signals) flags.push({ tone: 'reduce', key: sig.kind, label: sig.label, text: sig.text });
    const upcoming = (p.symbol && input.upcoming?.get(p.symbol)) || [];
    const report = upcoming.find((e) => e.kind === 'earnings' && e.day <= weekAhead);
    if (report) {
      flags.push({ tone: 'note', key: 'earnings', label: `Zahlen ${dayDe(report.day)}`, text: `Quartalszahlen am ${dayDe(report.day)}${report.detail ? ` — ${report.detail}` : ''}` });
    }
    return {
      isin: p.isin, symbol: p.symbol, name: m?.name ?? p.name, assetType: p.assetType, quantity: p.quantity,
      costEur: p.costEur, priceEur: price?.priceEur ?? null, priceDay: price?.day ?? null, valueEur: value, weight, concentrated,
      gain: value !== null && p.costEur ? value / p.costEur - 1 : null,
      openedAt: p.openedAt, lastTradeAt: p.lastTradeAt, tradeIds: p.tradeIds,
      tracked: !!m && m.score !== null, score: m?.score ?? null, verdict, sector: m?.sector ?? null,
      reason, thesis, chart: (p.symbol && charts?.get(p.symbol)) || null,
      viaFunds: null, scoreBefore: (p.symbol && input.scoresBefore?.get(p.symbol)) || null, upcoming, signals, flags,
    };
  }).sort((a, b) => (b.valueEur ?? -1) - (a.valueEur ?? -1));

  const share = <K extends string>(key: (p: DepotPosition) => K | null, among: DepotPosition[]) => {
    const total = among.reduce((s, p) => s + (p.valueEur ?? 0), 0);
    const by = new Map<K, number>();
    for (const p of among) {
      const k = key(p);
      if (k !== null && p.valueEur !== null) by.set(k, (by.get(k) ?? 0) + p.valueEur);
    }
    return total > 0 ? [...by].map(([k, v]) => ({ k, weight: v / total })).sort((a, b) => b.weight - a.weight) : [];
  };
  const stocks = positions.filter((p) => p.assetType === 'stock');
  const sectors = share((p) => p.sector ?? 'ohne Sektor', stocks).map(({ k, weight }) => ({ sector: k, weight }));
  const byType = share((p) => p.assetType, positions).map(({ k, weight }) => ({ assetType: k, weight }));

  // The funds read as what they hold; each stock held learns what they add to it.
  const lt = lookThrough(positions, input.funds ?? new Map());
  for (const p of positions) p.viaFunds = (p.symbol && lt.heldViaFunds[p.symbol]) || null;

  const findings: string[] = [];
  const top = positions[0];
  if (top?.weight != null) findings.push(`Größte Position: ${top.symbol ?? top.name} mit ${pct(top.weight)} des Depots.`);
  const heavySector = sectors.find((s) => s.sector !== 'ohne Sektor' && s.weight > MAX_SECTOR);
  if (heavySector) findings.push(`${pct(heavySector.weight)} der Aktien liegen in einem Sektor (${heavySector.sector}).`);
  const scored = positions.filter((p) => p.tracked && p.weight !== null).reduce((s, p) => s + p.weight!, 0);
  if (totalEur > 0) findings.push(`Das Modell bewertet ${pct(scored)} des Depots; der Rest sind ETFs, andere Anlagen oder Aktien außerhalb der Watchlist.`);
  const sells = positions.filter((p) => p.verdict && /SELL/.test(p.verdict));
  if (sells.length > 0) {
    findings.push(`${sells.length} ${sells.length === 1 ? 'Position hat' : 'Positionen haben'} das Modell-Urteil SELL oder schlechter (${pct(sells.reduce((s, p) => s + (p.weight ?? 0), 0))} des Depots).`);
  }
  const others = new Set<string>(Object.values(OTHER));
  const ltTop = lt.sectors.find((x) => !others.has(x.sector));
  if (ltTop && lt.funds.known > 0) {
    findings.push(`Mit den Fonds durchgerechnet liegen ${pct(ltTop.total)} des Depots in ${ltTop.sector}, ${pct(ltTop.viaFunds)} davon über Fonds.`);
  }
  const twice = positions.filter((p) => p.viaFunds !== null && p.weight !== null && p.viaFunds >= 0.005)
    .sort((a, b) => b.viaFunds! - a.viaFunds!);
  if (twice.length > 0) {
    findings.push(`Über die Fonds hältst du zusätzlich ${twice.slice(0, 3).map((p) => `${p.symbol ?? p.name} (+${pct1(p.viaFunds!)})`).join(', ')}.`);
  }
  const reports = positions.flatMap((p) => p.upcoming.filter((e) => e.kind === 'earnings' && e.day <= weekAhead).map((e) => ({ p, e })))
    .sort((a, b) => a.e.day.localeCompare(b.e.day));
  if (reports.length > 0) {
    findings.push(`Quartalszahlen in den nächsten sieben Tagen: ${reports.map(({ p, e }) => `${p.symbol ?? p.name} am ${dayDe(e.day)}`).join(', ')}.`);
  }
  const signalled = positions.filter((p) => p.signals.length > 0);
  if (signalled.length > 0) {
    findings.push(`Der Wächter meldet: ${signalled.map((p) => `${p.symbol ?? p.name} ${p.signals.map((x) => x.label).join(', ')}`).join('; ')}.`);
  }
  const decided = new Set(held.filter((p) => p.decided).map((p) => p.isin));
  const unexplained = positions.filter((p) => !p.reason && decided.has(p.isin));
  if (unexplained.length > 0) {
    findings.push(`${unexplained.length} von ${decided.size} gekauften Positionen haben keine Begründung im Journal.`);
  }

  return {
    totalEur, unvalued: positions.filter((p) => p.valueEur === null).length,
    positions, sectors, byType, findings,
    limits: { maxPosition: MAX_POSITION, maxSector: MAX_SECTOR },
    lookThrough: lt,
    market: input.market ?? [],
    cashEur: input.cashEur ?? null,
  };
}

/** What the backtest found a verdict to be worth: its return over the average stock. */
export interface VerdictRecord {
  verdict:    string;
  /** Months held. */
  horizon:    number;
  meanExcess: number | null;
  tStat:      number | null;
}

export interface DepotResponse {
  configured: boolean;
  syncedAt:   string | null;
  syncError:  string | null;
  /** Null while there are no trades to sum. */
  view:       DepotView | null;
  /** The verdicts' record at the longest horizon the newest backtest measured. */
  evidence:   VerdictRecord[] | null;
}
