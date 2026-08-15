/**
 * Ticker-shape rules, shared by the server and the web app.
 *
 * Kept dependency-free on purpose — the web app imports this file directly
 * across the package boundary (through Vite), exactly like `src/models.ts`, so
 * it must not pull in a Node built-in or a NodeNext-style relative import.
 *
 * These rules have to agree in both places or the UI lies: the input badge says
 * "symbol" while the server decides it is a company name and searches for it.
 */

/**
 * Does this input look like a ticker rather than a company name?
 *
 * Tickers are 1–10 characters with no spaces, starting with a letter, and may
 * carry an exchange suffix or class marker (`AIR.PA`, `BRK-B`, `0QW9.IL`).
 * Anything with a space is a name — no ticker has one.
 */
export function looksLikeSymbol(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes(' ')) return false;
  return /^[A-Za-z][A-Za-z0-9.\-/:]{0,9}$/.test(trimmed);
}

/**
 * Stricter shape for a symbol arriving in a URL path, where it becomes part of
 * a filesystem path. Must start alphanumeric so `..` and `../` can never match;
 * `symbolDir()` confines to the cache root as defence in depth.
 */
export const SAFE_SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/;
