/**
 * What a company hands its shareholders: the dividend, and the shares it buys
 * back or issues beside it.
 *
 * The score reads the share count already (`netIssuance`, Pontiff and Woodgate
 * 2008). The dividend it reads only inside the dividend model's fair value —
 * no criterion asks whether the stocks paying the most went on to do better.
 * The literature is mixed: a high yield alone has predicted little once value
 * is controlled for, and the net payout including buybacks has done better
 * (Boudoukh, Michaely, Richardson and Roberts 2007). So the yields are measured
 * as candidates in the backtest before anyone proposes a weight for them.
 *
 * The rule a candidate must pass, fixed before the first run: the rank IC over
 * one month, within sectors — a utility's yield and a software company's are
 * not one scale — at |t| ≥ 2 over all months, and with the same sign in both
 * halves of them (`backtest/run.ts`, `candidateHalves`).
 *
 * Pure and dependency-free: the web app reads the titles.
 */

import type { StockFinancials } from '../types.js';

const finite = (v: number | null | undefined): number | null =>
  v !== null && v !== undefined && Number.isFinite(v) ? v : null;

/** Change in the share count over the last fiscal year: negative is buybacks, positive dilution. */
export function netIssuance(f: Pick<StockFinancials, 'sharesOutstandingAnnual' | 'prevYear'>): number | null {
  const now = finite(f.sharesOutstandingAnnual);
  const before = finite(f.prevYear?.sharesOutstanding);
  return now !== null && before !== null && before > 0 ? now / before - 1 : null;
}

/**
 * The signals the backtest measures. A firm without a dividend on record yields
 * nothing, so it ranks at 0 in the first and is left out of the second: the
 * first asks whether payers beat the rest, the second whether the higher
 * payers beat the lower.
 */
export const PAYOUT_CANDIDATES: readonly {
  key: string; title: string; read: (f: StockFinancials) => number | null;
}[] = [
  { key: 'payout.dividend-yield', title: 'Dividendenrendite (ohne Dividende = 0)', read: (f) => finite(f.dividendYield) ?? 0 },
  {
    key: 'payout.dividend-yield-payers', title: 'Dividendenrendite, nur Zahler',
    read: (f) => { const dy = finite(f.dividendYield); return dy !== null && dy > 0 ? dy : null; },
  },
  {
    key: 'payout.shareholder-yield', title: 'Ausschüttungsrendite (Dividende + Rückkäufe)',
    read: (f) => { const n = netIssuance(f); return n === null ? null : (finite(f.dividendYield) ?? 0) - n; },
  },
];
