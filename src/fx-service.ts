/**
 * Euros per unit of a quote currency, from the newest rate archived with the
 * prices (`price_bars`, the night's refresh): the dollar through EURUSD=X,
 * another currency through its own dollar rate where one is kept. For a stop
 * set in Trade Republic, in euros, beside the level the chart gives in the
 * stock's currency.
 */

import { fxTicker, majorCurrency, MINOR_UNIT_CURRENCIES } from './currencies.js';
import { readPriceBarsMany } from './db/history-store.js';

/** A rate older than this is not today's. */
const MAX_AGE_DAYS = 10;

/** By quote currency, as Yahoo writes it (USD, GBp); a currency without a rate on file is left out. */
export async function euroRates(currencies: readonly (string | null | undefined)[]): Promise<Record<string, number>> {
  const codes = [...new Set(currencies.filter((c): c is string => !!c))];
  const majors = [...new Set(codes.map((c) => majorCurrency(c)!))].filter((c) => c !== 'EUR' && c !== 'USD');
  const eurUsd = fxTicker('EUR', 'USD');
  const from = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const bars = await readPriceBarsMany([eurUsd, ...majors.map((c) => fxTicker(c, 'USD'))], from);
  const last = (t: string) => bars.get(t.toUpperCase())?.at(-1)?.close ?? null;
  const perMajor: Record<string, number> = { EUR: 1 };
  const usd = last(eurUsd);
  if (usd) {
    perMajor.USD = 1 / usd;
    for (const c of majors) {
      const r = last(fxTicker(c, 'USD'));
      if (r) perMajor[c] = r / usd;
    }
  }
  const out: Record<string, number> = {};
  for (const code of codes) {
    const minor = MINOR_UNIT_CURRENCIES[code];
    const rate = perMajor[majorCurrency(code)!];
    if (rate) out[code] = minor ? rate / minor.perMajor : rate;
  }
  return out;
}
