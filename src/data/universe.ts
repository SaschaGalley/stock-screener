/**
 * Who is in the reference universe: five indices, each read from a list kept
 * by other people.
 *
 *   S&P 500       — the community-maintained `datasets/s-and-p-500-companies`
 *                   file on GitHub
 *   S&P MidCap 400, S&P SmallCap 600
 *                 — the constituents tables of their English Wikipedia
 *                   articles, the ones the backtest reads: with the 500 they
 *                   are the S&P Composite 1500, so the live universe is the
 *                   population the backtest measures on
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
  return parseConstituents(await fetchSp500Csv());
}

async function fetchSp500Csv(): Promise<string> {
  const res = await fetch(SP500_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`constituents HTTP ${res.status}`);
  return res.text();
}

export interface Constituent {
  symbol:      string;
  name:        string;
  sector:      string;
  subIndustry: string;
  /** The day it joined the index, where the file says. */
  added:       string | null;
  cik:         string | null;
  /** Which of the S&P 1500's three indices it is in, where that was asked. */
  index?:      CompositeIndex;
}

/** The S&P 500 file with what the backtest needs beside the ticker: GICS, the day it joined, the SEC's CIK. */
export function parseConstituentRows(csv: string): Constituent[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = csvRecord(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [cSym, cName, cSector, cSub, cAdded, cCik] =
    ['symbol', 'security', 'gics sector', 'gics sub-industry', 'date added', 'cik'].map(col);
  if (cSym < 0) return [];
  const out: Constituent[] = [];
  for (const line of lines.slice(1)) {
    const r = csvRecord(line);
    const raw = r[cSym]?.trim();
    if (!raw || !/^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(raw)) continue;
    const added = r[cAdded]?.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    const cik = r[cCik]?.trim().replace(/\D/g, '') || null;
    out.push({
      symbol: yahooTicker(raw), name: r[cName]?.trim() ?? raw,
      sector: r[cSector]?.trim() ?? '', subIndustry: r[cSub]?.trim() ?? '', added, cik,
    });
  }
  return out;
}

export async function fetchSp500Constituents(): Promise<Constituent[]> {
  return parseConstituentRows(await fetchSp500Csv());
}

// ── Wikipedia tables ─────────────────────────────────────────────────────────

/**
 * A wiki link or template reduced to the text it shows: `[[Allianz SE|Allianz]]`
 * → `Allianz`, `{{NyseSymbol|AA}}` → `AA`. Every other template shows nothing
 * worth keeping (`{{Anchor|A}}`, a citation).
 */
function wikiText(raw: string): string {
  return raw
    .replace(/\{\{\s*(?:Nyse|Nasdaq|NYSE|NASDAQ)[A-Za-z ]*\|\s*([^}|]+?)\s*\}\}/gi, '$1')
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

// ── The S&P 1500: the 500 with the MidCap 400 and the SmallCap 600 ───────────

export type CompositeIndex = 'sp500' | 'sp400' | 'sp600';

/** The three indices of the S&P Composite 1500, largest first, with the articles their tables are in. */
export const COMPOSITE_INDEXES: readonly { key: CompositeIndex; label: string; members: string | null; changes: string }[] = [
  // The 500's members come from the CSV, which carries the day each joined.
  { key: 'sp500', label: 'S&P 500', members: null, changes: 'Historical_components_of_the_S&P_500' },
  { key: 'sp400', label: 'S&P MidCap 400', members: 'List_of_S&P_400_companies', changes: 'List_of_S&P_400_companies' },
  { key: 'sp600', label: 'S&P SmallCap 600', members: 'List_of_S&P_600_companies', changes: 'List_of_S&P_600_companies' },
];

export interface IndexChange {
  day:          string;
  added:        string | null;
  removed:      string | null;
  /** The company's name as the table gives it — what tells a reused ticker from its old owner. */
  removedName?: string | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "September 21, 2026" or "Jan 9, 2012" → 2026-09-21; null for anything else. */
export function wikiDate(raw: string): string | null {
  const m = raw.trim().match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return raw.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const tickerOf = (raw: string | undefined) => {
  const t = raw?.trim().toUpperCase();
  return t && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? yahooTicker(t) : null;
};

/** A constituents table with GICS columns: the 400's and the 600's articles. */
export function parseIndexMembers(wikitext: string, index: CompositeIndex): Constituent[] {
  const table = wikitable(wikitext, 'constituents');
  if (!table) return [];
  const col = (name: string) => table.header.findIndex((h) => h === name);
  const [cSym, cName, cSector, cSub, cFilings, cCik] =
    ['symbol', 'security', 'gics sector', 'gics sub-industry', 'sec filings', 'cik'].map(col);
  if (cSym < 0) return [];
  return table.rows.flatMap((r) => {
    const symbol = tickerOf(r[cSym]);
    if (!symbol) return [];
    // The CIK column where there is one, else the number in the filings link —
    // which some rows give as the ticker instead, and then there is none.
    const cik = (cCik >= 0 ? r[cCik]?.replace(/\D/g, '') : '') || r[cFilings]?.match(/CIK=0*(\d+)/i)?.[1] || null;
    return [{
      symbol, name: r[cName]?.trim() || symbol, sector: r[cSector]?.trim() ?? '', subIndustry: r[cSub]?.trim() ?? '',
      added: null, cik, index,
    }];
  });
}

/** The table of additions and removals: date, added ticker and name, removed ticker and name, reason. */
export function parseIndexChanges(wikitext: string): IndexChange[] {
  const table = wikitable(wikitext, 'changes');
  if (!table) return [];
  return table.rows.flatMap((r) => {
    const day = wikiDate(r[0] ?? '');
    if (!day) return [];
    return [{ day, added: tickerOf(r[1]), removed: tickerOf(r[3]), removedName: r[4]?.trim() || null }];
  });
}

const DAY_MS = 86_400_000;
/** A removal from one index this close to an addition to another is one move, not two events. */
const MOVE_DAYS = 10;

/**
 * The day each member joined the composite, as far as the tables reach.
 *
 * A company's day in its own index is the latest addition there — or, for the
 * 500, the day the CSV gives. If it left another of the three around then, it
 * moved rather than joined, and its day is the one it joined that index, and
 * so on back. A company the table never lists as added has been a member at
 * least since the table begins, and counts from then: the 600's table starts
 * in December 2019, and counting today's small caps from 2013 would count
 * the years before some of them were small caps at all — the survivors' years.
 */
export function compositeJoinDates(
  members: readonly Constituent[], changes: ReadonlyMap<CompositeIndex, readonly IndexChange[]>,
): Map<string, string | null> {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= MOVE_DAYS * DAY_MS;
  const since = (index: CompositeIndex) => (changes.get(index) ?? []).map((c) => c.day).sort()[0] ?? null;
  const addedTo = (index: CompositeIndex, symbol: string, until?: string) =>
    (changes.get(index) ?? []).filter((c) => c.added === symbol && (!until || c.day <= until)).map((c) => c.day).sort().at(-1) ?? null;
  const joined = (symbol: string, index: CompositeIndex, day: string, depth: number): string | null => {
    if (depth > 3) return day;
    for (const [other, list] of changes) {
      if (other === index || !list.some((c) => c.removed === symbol && near(c.day, day))) continue;
      const before = addedTo(other, symbol, day) ?? since(other);
      return before ? joined(symbol, other, before, depth + 1) : null;
    }
    return day;
  };
  return new Map(members.map((m) => {
    // The 500's CSV gives the day; where it does not, its table does, back to 1976.
    const own = (m.index === 'sp500' ? m.added : null) ?? addedTo(m.index!, m.symbol) ?? since(m.index!);
    return [m.symbol, own ? joined(m.symbol, m.index!, own, 0) : null];
  }));
}

/** A company that left the composite: the index it left, when, and under what name. */
export interface Departed extends Constituent {
  removed: string;
}

/**
 * The companies that left all three indices since `since`: for each ticker
 * the last time it was removed, unless it is a member again today. Its day
 * in is found the way a member's is, from the index it left.
 */
export function departedMembers(
  current: ReadonlySet<string>, changes: ReadonlyMap<CompositeIndex, readonly IndexChange[]>, since: string,
): Departed[] {
  const last = new Map<string, { index: CompositeIndex; change: IndexChange }>();
  for (const [index, list] of changes) {
    for (const c of list) {
      if (!c.removed || c.day < since || current.has(c.removed)) continue;
      const seen = last.get(c.removed);
      if (!seen || c.day > seen.change.day) last.set(c.removed, { index, change: c });
    }
  }
  const out: Departed[] = [];
  for (const [symbol, { index, change }] of last) {
    // A ticker added back after its last removal is a member under another
    // listing or a different company; either way not this one's exit.
    const back = [...changes.values()].some((list) => list.some((c) => c.added === symbol && c.day > change.day));
    if (back) continue;
    const name = change.removedName ?? symbol;
    // Joined as a member would have, looked up as of the day it left.
    const days = compositeJoinDates([{ symbol, name, sector: '', subIndustry: '', added: null, cik: null, index }], new Map(
      [...changes].map(([k, list]) => [k, list.filter((c) => c.day <= change.day && !(k === index && c.removed === symbol && c.day === change.day))]),
    ));
    out.push({ symbol, name, sector: '', subIndustry: '', added: days.get(symbol) ?? null, cik: null, index, removed: change.day });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** The S&P 1500's members today and, with `departedSince`, the companies that left it since then. */
export async function fetchSp1500Constituents(departedSince?: string): Promise<{ members: Constituent[]; departed: Departed[] }> {
  const members: Constituent[] = (await fetchSp500Constituents()).map((c) => ({ ...c, index: 'sp500' as const }));
  const changes = new Map<CompositeIndex, IndexChange[]>();
  for (const ix of COMPOSITE_INDEXES) {
    if (ix.members) members.push(...parseIndexMembers(await fetchWikitext('en', ix.members), ix.key));
    changes.set(ix.key, parseIndexChanges(await fetchWikitext('en', ix.changes)));
  }
  // A company the file lists twice — a move half done — counts once, in the larger index.
  const seen = new Set<string>();
  const unique = members.filter((m) => !seen.has(m.symbol) && seen.add(m.symbol));
  const days = compositeJoinDates(unique, changes);
  return {
    members: unique.map((m) => ({ ...m, added: days.get(m.symbol) ?? null })),
    departed: departedSince ? departedMembers(seen, changes, departedSince) : [],
  };
}

const NAME_NOISE = /\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|l\.?p|trust|bancorp)\b/g;

/**
 * Whether two spellings name the same company: their first significant word
 * agrees. Enough to tell Anadarko from ARKO, which took over its ticker.
 */
export function sameCompany(a: string, b: string): boolean {
  const first = (s: string) => s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(NAME_NOISE, ' ').trim().split(/\s+/)[0] ?? '';
  const x = first(a), y = first(b);
  return x.length > 1 && x === y;
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
  // The MidCap 400 and SmallCap 600 as the backtest reads them; a quarter short
  // of their size and the table is broken, not the index smaller.
  ...COMPOSITE_INDEXES.flatMap((ix) => (ix.members === null ? [] : [{
    key: ix.key, label: ix.label, minSize: ix.key === 'sp400' ? 300 : 450,
    fetch: async () => parseIndexMembers(await fetchWikitext('en', ix.members!), ix.key).map((c) => c.symbol),
  }])),
  {
    key: 'eurostoxx50', label: 'EURO STOXX 50', minSize: 40,
    fetch: async () => parseWikiTickers(await fetchWikitext('en', 'EURO_STOXX_50'), { tableId: 'constituents', column: 'ticker' }),
  },
  {
    key: 'dax', label: 'DAX', minSize: 30,
    fetch: async () => parseWikiTickers(await fetchWikitext('de', 'DAX'), { tableId: 'Zusammensetzung', column: 'symbol', suffix: '.DE' }),
  },
];

/** The universe's indices as a sentence names them: „S&P 500, … und DAX“. */
export function universeIndices(): string {
  const labels = UNIVERSE_SOURCES.map((s) => s.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} und ${labels[labels.length - 1]}` : labels.join('');
}
