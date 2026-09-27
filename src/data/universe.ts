/**
 * Who is in the reference universe: three indices, each read from a list kept
 * by other people.
 *
 *   S&P 500       — the community-maintained `datasets/s-and-p-500-companies`
 *                   file on GitHub
 *   EURO STOXX 50 — the constituents table of the English Wikipedia article,
 *                   whose tickers already carry the main listing's suffix
 *   DAX           — the constituents table of the German article, Xetra
 *                   symbols to which `.DE` is added
 *
 * Indices rather than a hand-picked list, because the universe exists to be
 * nobody's choice. The calibration asks where the typical stock sits and the
 * evaluation asks whether the score ranked the ones that did better, and a
 * list picked by someone looking at the watchlist would answer both questions
 * about that person's taste. The indices decide by rule, and their membership
 * changes without anyone here editing anything. Europe is in it because the
 * watchlist is: a euro listing read only against American ones is read
 * against a market it does not trade in.
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

// ── Wikipedia tables ─────────────────────────────────────────────────────────

/** A wiki link or template reduced to the text it shows: `[[Allianz SE|Allianz]]` → `Allianz`. */
function wikiText(raw: string): string {
  return raw
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,}/g, '')
    .trim();
}

/**
 * A cell's content without its attributes: `style="text-align:center" | 2,500`
 * is `2,500`. The attribute separator is a single pipe outside links and
 * templates, which have pipes of their own.
 */
function cellContent(raw: string): string {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const two = raw.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; i++; continue; }
    if (two === ']]' || two === '}}') { depth--; i++; continue; }
    if (raw[i] === '|' && depth === 0) return raw.slice(i + 1);
  }
  return raw;
}

/**
 * The header and rows of the wiki table with the given `id`. Cells may sit on
 * one line (`| a || b`) or one per line (`| a` newline `| b`), and a row may
 * mix the two; both flatten to the same list.
 */
export function wikitable(wikitext: string, id: string): { header: string[]; rows: string[][] } | null {
  const start = wikitext.search(new RegExp(`\\{\\|[^\\n]*id="${id}"`));
  if (start < 0) return null;
  const end = wikitext.indexOf('\n|}', start);
  const body = wikitext.slice(start, end < 0 ? undefined : end).split('\n').slice(1);

  const header: string[] = [];
  const rows: string[][] = [];
  let row: string[] | null = null;
  for (const line of body) {
    if (line.startsWith('|-')) {
      if (row?.length) rows.push(row);
      row = [];
      continue;
    }
    if (line.startsWith('!')) {
      header.push(...line.slice(1).split('!!').map((c) => wikiText(cellContent(c)).toLowerCase()));
      continue;
    }
    if (line.startsWith('|') && !line.startsWith('|+') && !line.startsWith('|}')) {
      (row ??= []).push(...line.slice(1).split('||').map((c) => wikiText(cellContent(c))));
    }
  }
  if (row?.length) rows.push(row);
  return { header, rows };
}

/** The tickers in one column of a wiki table, with a suffix added where the table leaves the exchange out. */
export function parseWikiTickers(
  wikitext: string, opts: { tableId: string; column: string; suffix?: string },
): string[] {
  const table = wikitable(wikitext, opts.tableId);
  if (!table) return [];
  const col = table.header.indexOf(opts.column.toLowerCase());
  if (col < 0) return [];
  const out = new Set<string>();
  for (const row of table.rows) {
    const raw = row[col]?.trim().toUpperCase();
    if (!raw || !/^[A-Z0-9][A-Z0-9-]{0,9}(\.[A-Z]{1,2})?$/.test(raw)) continue;
    out.add(opts.suffix && !raw.includes('.') ? `${raw}${opts.suffix}` : raw);
  }
  return [...out].sort();
}

async function fetchWikitext(lang: 'en' | 'de', title: string): Promise<string> {
  const url = `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'stock-cli (reference universe)' },
  });
  if (!res.ok) throw new Error(`${lang}.wikipedia ${title} HTTP ${res.status}`);
  return res.text();
}

export interface UniverseSource {
  key:     string;
  label:   string;
  /** Fewer members than this and the list is broken, not the index smaller. */
  minSize: number;
  fetch:   () => Promise<string[]>;
}

/**
 * The indices the universe is made of, in the order they claim a company
 * listed twice: the DAX lists Airbus on Xetra, the EURO STOXX 50 in Paris.
 */
export const UNIVERSE_SOURCES: readonly UniverseSource[] = [
  { key: 'sp500', label: 'S&P 500', minSize: 400, fetch: fetchSp500 },
  {
    key: 'eurostoxx50', label: 'EURO STOXX 50', minSize: 40,
    fetch: async () => parseWikiTickers(await fetchWikitext('en', 'EURO_STOXX_50'), { tableId: 'constituents', column: 'ticker' }),
  },
  {
    key: 'dax', label: 'DAX', minSize: 30,
    fetch: async () => parseWikiTickers(await fetchWikitext('de', 'DAX'), { tableId: 'Zusammensetzung', column: 'symbol', suffix: '.DE' }),
  },
];
