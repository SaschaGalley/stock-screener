/**
 * Who is in the reference universe: the S&P 500, as the community-maintained
 * `datasets/s-and-p-500-companies` list on GitHub has it.
 *
 * An index rather than a hand-picked list, because the universe exists to be
 * nobody's choice. The calibration asks where the typical stock sits and the
 * evaluation asks whether the score ranked the ones that did better, and a
 * list picked by someone looking at the watchlist would answer both questions
 * about that person's taste. The index decides by rule, and its membership
 * changes without anyone here editing anything.
 *
 * Pure HTTP and parsing; the fallback to the last good list lives in
 * `src/universe.ts`.
 */

export const SP500_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

/** One CSV record, with quoted fields ("Saint Paul, Minnesota") kept whole. */
export function csvRecord(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Yahoo's spelling of a US share-class ticker: `BRK.B` → `BRK-B`. */
export function yahooTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, '-');
}

/** The tickers of a constituents file, read by the header's name for the column. */
export function parseConstituents(csv: string): string[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const col = csvRecord(lines[0]).map((h) => h.trim().toLowerCase()).indexOf('symbol');
  if (col < 0) return [];
  const out = new Set<string>();
  for (const line of lines.slice(1)) {
    const raw = csvRecord(line)[col]?.trim();
    if (raw && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(raw)) out.add(yahooTicker(raw));
  }
  return [...out].sort();
}

export async function fetchSp500(): Promise<string[]> {
  const res = await fetch(SP500_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`constituents HTTP ${res.status}`);
  return parseConstituents(await res.text());
}
