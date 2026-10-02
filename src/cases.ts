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

export type CaseSide = Record<CaseSection, string[]>;

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

export interface CaseView extends CaseSide {
  /** Points from before the split, which do not say which section they are. */
  unsorted: string[];
}

export interface CasesView {
  bull: CaseView;
  bear: CaseView;
  /** Legacy triggers that carried no direction — rare, but not to be guessed. */
  undirected: string[];
}

/** Best-effort split of a schema-v3 paragraph into its sentences. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).map((s) => s.trim()).filter((s) => s.length > 10);
}

function readSide(v: StoredCase | undefined): CaseView {
  const empty: CaseView = { theses: [], figures: [], triggers: [], unsorted: [] };
  if (v === undefined || v === null) return empty;
  if (typeof v === 'string') return { ...empty, unsorted: sentences(v) };
  if (Array.isArray(v)) return { ...empty, unsorted: v.map(String) };
  return {
    theses:   v.theses ?? [],
    figures:  v.figures ?? [],
    triggers: v.triggers ?? [],
    unsorted: [],
  };
}

const LEGACY_TRIGGER = /^\s*([↑↓])\s*(?:wenn\b\s*)?/i;

/** Every stored shape, read as the sections today's reader expects. */
export function readCases(a: StoredCases): CasesView {
  const bull = readSide(a.bullCase);
  const bear = readSide(a.bearCase);
  bear.unsorted.push(...(a.keyRisks ?? []));

  const undirected: string[] = [];
  for (const w of a.watch ?? []) {
    const m = w.match(LEGACY_TRIGGER);
    if (!m) { undirected.push(w); continue; }
    (m[1] === '↑' ? bull : bear).triggers.push(w.slice(m[0].length));
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
  const out = side.unsorted.map((p) => `${fmt.bullet}${p}`);
  for (const section of CASE_SECTIONS) {
    if (side[section].length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(fmt.heading(CASE_SECTION_LABEL[section][direction]));
    out.push(...side[section].map((p) => `${fmt.bullet}${p}`));
  }
  return out;
}
