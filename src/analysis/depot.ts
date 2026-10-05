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

/** A position this large is a concentration whatever the model says of it. */
export const MAX_POSITION = 0.15;
/** A sector this large among the stocks is one bet, however many names it holds. */
export const MAX_SECTOR = 0.35;
/** Funds hold many stocks: a large weight in one is not a concentration. */
const DIVERSIFIED = new Set(['etf']);
/** Shares left after rounding are a closed position. */
const EPS = 1e-6;

export interface DepotFlag {
  /** `reduce`: a reason to look at holding less; `add`: at holding more; `ask`: something missing. */
  tone: 'reduce' | 'add' | 'ask';
  text: string;
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
  /** Rated BUY or better on the watchlist, and not held. */
  candidates: { symbol: string; name: string | null; score: number; verdict: string; sector: string | null }[];
  limits:     { maxPosition: number; maxSector: number };
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
const num = (x: number) => x.toFixed(1).replace('.', ',');

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
}): DepotView {
  const { held, prices, model, reasons, theses } = input;
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
    if (concentrated) flags.push({ tone: 'reduce', text: `Klumpen: ${pct(weight)} des Depots` });
    if (verdict && /SELL/.test(verdict)) {
      flags.push({ tone: 'reduce', text: `Modell-Urteil ${verdict}${m?.score != null ? ` (${num(m.score)})` : ''}` });
    }
    if (thesis && thesis.contradicted > 0) {
      flags.push({ tone: 'reduce', text: `Thesen-Check: ${thesis.contradicted} von ${thesis.total} widerlegt` });
    }
    if (verdict && /BUY/.test(verdict) && weight !== null && average !== null && weight < average) {
      flags.push({ tone: 'add', text: `Modell-Urteil ${verdict}, unter dem Durchschnittsgewicht von ${pct(average)}` });
    }
    // A savings plan runs by itself: what it buys was decided once, not each month.
    if (!reason && p.decided) flags.push({ tone: 'ask', text: 'keine Begründung im Journal' });
    if (!m && p.assetType === 'stock') flags.push({ tone: 'ask', text: 'nicht in der Watchlist — kein Score' });
    if (!price) flags.push({ tone: 'ask', text: 'kein Kurs aus umsatz' });
    return {
      isin: p.isin, symbol: p.symbol, name: m?.name ?? p.name, assetType: p.assetType, quantity: p.quantity,
      costEur: p.costEur, priceEur: price?.priceEur ?? null, priceDay: price?.day ?? null, valueEur: value, weight, concentrated,
      gain: value !== null && p.costEur ? value / p.costEur - 1 : null,
      openedAt: p.openedAt, lastTradeAt: p.lastTradeAt, tradeIds: p.tradeIds,
      tracked: !!m && m.score !== null, score: m?.score ?? null, verdict, sector: m?.sector ?? null,
      reason, thesis, flags,
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
  const decided = new Set(held.filter((p) => p.decided).map((p) => p.isin));
  const unexplained = positions.filter((p) => !p.reason && decided.has(p.isin));
  if (unexplained.length > 0) {
    findings.push(`${unexplained.length} von ${decided.size} gekauften Positionen haben keine Begründung im Journal.`);
  }

  const held_ = new Set(positions.map((p) => p.symbol).filter(Boolean));
  const candidates = [...model]
    .filter(([s, m]) => !held_.has(s) && m.score !== null && m.verdict && /BUY/.test(m.verdict))
    .map(([symbol, m]) => ({ symbol, name: m.name, score: m.score!, verdict: m.verdict!, sector: m.sector }))
    .sort((a, b) => b.score - a.score);

  return {
    totalEur, unvalued: positions.filter((p) => p.valueEur === null).length,
    positions, sectors, byType, findings, candidates,
    limits: { maxPosition: MAX_POSITION, maxSector: MAX_SECTOR },
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
