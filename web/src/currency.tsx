import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { currencyPrefix, fmtBig, fmtCount, fmtPrice } from '../../src/format';

/**
 * The trading currency of whatever is on screen.
 *
 * Every monetary figure in a stock's detail view is denominated in that one
 * currency — the data layer FX-converts the statements into it upstream, so
 * price, market cap, fair values and the 5y history are all comparable. What
 * was missing was a way to *say* so: the formatters have taken a currency
 * argument for a while, but two dozen call sites called them without one and
 * got the `$` default, which is how a Paris-listed stock (AI.PA) reported
 * "$166.78" for a price quoted in euros.
 *
 * Passing the code through every component would mean threading a prop through
 * charts, tables and section bodies that otherwise take none. One provider at
 * the top of the view and a hook at each call site instead — the call sites
 * keep reading `fmtPrice(x)`, and the currency comes from context.
 *
 * The multi-currency list views (overview table, sidebar) deliberately do NOT
 * use this: their rows each carry their own currency, so they pass it to the
 * plain formatters per row.
 */
const CurrencyContext = createContext<string | null>(null);

export function CurrencyProvider({
  code,
  children,
}: {
  /** ISO 4217 code, or null/undefined when unknown (renders as USD). */
  code: string | null | undefined;
  children: ReactNode;
}) {
  return <CurrencyContext.Provider value={code ?? null}>{children}</CurrencyContext.Provider>;
}

/** Money formatters bound to the currency in scope, plus the bare symbol. */
export function useMoney() {
  const code = useContext(CurrencyContext);
  return useMemo(
    () => ({
      code,
      /** Prefix only — for hand-built strings that can't call a formatter. */
      symbol: currencyPrefix(code),
      fmtPrice: (n: number | null | undefined) => fmtPrice(n, code),
      fmtBig:   (n: number | null | undefined) => fmtBig(n, code),
      /** Counts are currency-free; re-exported so components need one import. */
      fmtCount,
    }),
    [code],
  );
}
