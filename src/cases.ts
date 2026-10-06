/**
 * The bull and bear case, in sections — declared once.
 *
 * Each side used to be a single list, and a single list filled up with what the
 * synthesis model had most of: the pillar table. Apple's bull case read ROIC,
 * operating margin, Piotroski, momentum and the analyst count, five numbers and
 * not one sentence about why anyone owns the stock. The portals that do this
 * well (Alpha Spread's "Bull/Bear Thesen", Morningstar's "Bulls/Bears Say")
 * write the debate instead: a driver, what it does to the business, why that
 * matters for the price.
 *
 * So a side has three sections, and the separate slot is the fix rather than a
 * layout choice — a model cannot spend the theses on multiples when the
 * multiples have a section of their own:
 *
 *   theses    the argument as the market has it: business model, demand,
 *             competition, management, regulation
 *   figures   what the numbers say for this side
 *   triggers  what would move the verdict this way — the old "Was das Urteil
 *             ändern würde", split by direction and put where it belongs
 *
 * Dependency-free so the web app can import it across the package boundary,
 * like `src/verdict.ts`.
 */

export const CASE_SECTIONS = ['theses', 'figures', 'triggers'] as const;
export type CaseSection = (typeof CASE_SECTIONS)[number];

export const CASE_DIRECTIONS = ['bull', 'bear'] as const;
export type CaseDirection = (typeof CASE_DIRECTIONS)[number];

/**
 * One point of a side. From 7 October 2026 a thesis or a figure carries a
 * headline of its own — a wall of five sentences per side reads as a wall,
 * and the headline is what a reader scans first. Triggers, and every point
 * stored before that, are the text alone.
 */
export type CasePoint = string | { title: string; text: string };
export type CaseSide = Record<CaseSection, CasePoint[]>;

/** A point as every reader gets it: the headline, where there is one, and the text. */
export interface CasePointView { title: string | null; text: string }

export const CASE_TITLE: Record<CaseDirection, string> = {
  bull: 'Bull Case',
  bear: 'Bear Case',
};

export const CASE_SECTION_LABEL: Record<CaseSection, Record<CaseDirection, string>> = {
  theses:   { bull: 'Thesen',                bear: 'Thesen' },
  figures:  { bull: 'In den Zahlen',         bear: 'In den Zahlen' },
  triggers: { bull: 'Hebt das Urteil, wenn', bear: 'Senkt das Urteil, wenn' },
};

/**
 * One side as stored. Sections from 2 October 2026; a flat list before that;
 * a single paragraph in analysis schema v3. All three are history worth
 * showing, so every reader goes through `readCases`.
 */
export type StoredCase = CaseSide | string[] | string;

export interface StoredCases {
  bullCase:  StoredCase;
  bearCase:  StoredCase;
  /** Before 27 September risks were a third list; they read as bear points. */
  keyRisks?: string[];
  /** Before 2 October the triggers were one list, each marked ↑ or ↓. */
  watch?:    string[];
}

export interface CaseView extends Record<CaseSection, CasePointView[]> {
  /** Points from before the split, which do not say which section they are. */
  unsorted: CasePointView[];
}

export interface CasesView {
  bull: CaseView;
  bear: CaseView;
  /** Legacy triggers that carried no direction — rare, but not to be guessed. */
  undirected: string[];
}

/** A stored point in the reader's shape. A headline that is empty or the whole text is no headline. */
export function readPoint(p: CasePoint): CasePointView {
  if (typeof p === 'string') return { title: null, text: p };
  const title = p.title?.trim() || null;
  const text = p.text?.trim() ?? '';
  return title && text && title !== text ? { title, text } : { title: null, text: text || title || '' };
}

/** "Headline: text", or the text alone — for everything that is not the web page. */
export function pointText(p: CasePointView): string {
  return p.title ? `${p.title}: ${p.text}` : p.text;
}

/** Best-effort split of a schema-v3 paragraph into its sentences. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).map((s) => s.trim()).filter((s) => s.length > 10);
}

function readSide(v: StoredCase | undefined): CaseView {
  const empty: CaseView = { theses: [], figures: [], triggers: [], unsorted: [] };
  if (v === undefined || v === null) return empty;
  const text = (t: string): CasePointView => ({ title: null, text: t });
  if (typeof v === 'string') return { ...empty, unsorted: sentences(v).map(text) };
  if (Array.isArray(v)) return { ...empty, unsorted: v.map((p) => text(String(p))) };
  return {
    theses:   (v.theses ?? []).map(readPoint),
    figures:  (v.figures ?? []).map(readPoint),
    triggers: (v.triggers ?? []).map(readPoint),
    unsorted: [],
  };
}

const LEGACY_TRIGGER = /^\s*([↑↓])\s*(?:wenn\b\s*)?/i;

/** Every stored shape, read as the sections today's reader expects. */
export function readCases(a: StoredCases): CasesView {
  const bull = readSide(a.bullCase);
  const bear = readSide(a.bearCase);
  bear.unsorted.push(...(a.keyRisks ?? []).map((t) => ({ title: null, text: t })));

  const undirected: string[] = [];
  for (const w of a.watch ?? []) {
    const m = w.match(LEGACY_TRIGGER);
    if (!m) { undirected.push(w); continue; }
    (m[1] === '↑' ? bull : bear).triggers.push({ title: null, text: w.slice(m[0].length) });
  }
  return { bull, bear, undirected };
}

/**
 * A side as plain text lines — for the stored verdict text, the terminal and
 * anything else that is not the web page. `bullet` prefixes each point;
 * `heading` formats a section label.
 */
export function caseLines(
  side: CaseView, direction: CaseDirection,
  fmt: { bullet: string; heading: (label: string) => string },
): string[] {
  const out = side.unsorted.map((p) => `${fmt.bullet}${pointText(p)}`);
  for (const section of CASE_SECTIONS) {
    if (side[section].length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(fmt.heading(CASE_SECTION_LABEL[section][direction]));
    out.push(...side[section].map((p) => `${fmt.bullet}${pointText(p)}`));
  }
  return out;
}
