/**
 * The kinds of research run by hand in a chat app's research mode: the brief
 * is copied out, the answer pasted back. One list, read by the server that
 * builds the prompts and parses the answers and by the page that offers them.
 *
 * Pure and dependency-free so the web app can import it.
 */

export const RESEARCH_KINDS = ['company', 'earnings', 'thesis', 'theme', 'review'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export const RESEARCH_KIND_META: Record<ResearchKind, {
  label: string;
  /** One line on what it is for, beside the choice. */
  hint:  string;
  /** About one stock, or a question across several. */
  scope: 'one' | 'many';
}> = {
  company: {
    label: 'Firmenbericht', scope: 'one',
    hint:  'Streitfragen, Ereignisse, Kennzahlen, Thesen beider Seiten — geht in jede Analyse ein',
  },
  earnings: {
    label: 'Vor den Zahlen', scope: 'one',
    hint:  'Was erwartet wird, wo die eigentliche Latte liegt und woran man das Ergebnis misst',
  },
  thesis: {
    label: 'Thesen-Check', scope: 'one',
    hint:  'Deine Journal-Einträge zur Aktie, gezielt gegen die Belege geprüft',
  },
  theme: {
    label: 'Themen-Recherche', scope: 'many',
    hint:  'Eine Frage über mehrere Aktien, z. B. wer das KI-Rennen gewinnt',
  },
  review: {
    label: 'Rückblick-Check', scope: 'one',
    hint:  'Ob die Begründung eines Kaufs oder Verkaufs gehalten hat — und ob das Ergebnis aus ihr kam',
  },
};

export const isResearchKind = (v: unknown): v is ResearchKind =>
  typeof v === 'string' && (RESEARCH_KINDS as readonly string[]).includes(v);

// ── What each kind's answer holds ────────────────────────────────────────────
// `company` is the brief's own `PerplexityFindings` and lives in the deep
// research slot; the others are stored as research reports.

export interface EarningsPreview {
  reportDate:  string | null;
  consensus:   { metric: string; value: string; source: string | null }[];
  /** Where the real bar sits: the buy-side number, what the price already assumes. */
  bar:         string | null;
  impliedMove: string | null;
  history:     { period: string; result: string; reaction: string | null }[];
  watch:       { item: string; why: string; bullIf: string | null; bearIf: string | null }[];
  risks:       { risk: string; source: string | null }[];
}

export const THESIS_VERDICTS = ['supported', 'mixed', 'contradicted', 'untestable'] as const;
export type ThesisVerdict = (typeof THESIS_VERDICTS)[number];
export const THESIS_VERDICT_LABEL: Record<ThesisVerdict, string> = {
  supported:    'gestützt',
  mixed:        'gemischt',
  contradicted: 'widerlegt',
  untestable:   'nicht prüfbar',
};

export interface ThesisCheck {
  theses: {
    thesis:      string;
    verdict:     ThesisVerdict;
    against:     string;
    for:         string;
    wouldChange: string | null;
    sources:     string[];
  }[];
  /** What the notes leave out that matters. */
  missed: { point: string; source: string | null }[];
}

export const THEME_POSITIONS = ['leader', 'contender', 'laggard', 'unclear'] as const;
export type ThemePosition = (typeof THEME_POSITIONS)[number];
export const THEME_POSITION_LABEL: Record<ThemePosition, string> = {
  leader:    'vorn',
  contender: 'im Rennen',
  laggard:   'hinten',
  unclear:   'unklar',
};

export interface ThemeResearch {
  answer:        string;
  companies:     { ticker: string; position: ThemePosition; strengths: string; weaknesses: string; evidence: string; source: string | null }[];
  uncertainties: { question: string; settles: string | null; when: string | null }[];
  watch:         { date: string | null; event: string; why: string }[];
}

export const REVIEW_VERDICTS = ['held', 'partly', 'failed', 'too_early'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  held:      'Begründung hat gehalten',
  partly:    'teilweise gehalten',
  failed:    'nicht gehalten',
  too_early: 'noch zu früh',
};

/** Whether the result came from the reason given, or from something it did not consider. */
export const REVIEW_CAUSES = ['reason', 'other', 'mixed', 'unclear'] as const;
export type ReviewCause = (typeof REVIEW_CAUSES)[number];
export const REVIEW_CAUSE_LABEL: Record<ReviewCause, string> = {
  reason:  'Ergebnis kam aus der Begründung',
  other:   'Ergebnis kam aus etwas anderem',
  mixed:   'teils, teils',
  unclear: 'unklar',
};

export interface DecisionCheck {
  verdict:      ReviewVerdict;
  cause:        ReviewCause;
  reasonCheck:  string;
  drivers:      string;
  lesson:       string;
  now:          string | null;
  whatHappened: { date: string | null; event: string; effect: string; source: string | null }[];
}

export interface ResearchDataByKind {
  earnings: EarningsPreview;
  thesis:   ThesisCheck;
  theme:    ThemeResearch;
  review:   DecisionCheck;
}

/** A report kept from a pasted answer — every kind but the company brief. */
export type ResearchReport = {
  [K in keyof ResearchDataByKind]: {
    id:        number;
    kind:      K;
    symbols:   string[];
    question:  string | null;
    /** For a review: the decision it looks back on (`Decision.key` in `analysis/review.ts`). */
    decision:  string | null;
    tool:      string;
    createdAt: string;
    /** The parsed answer; null when the tool wrote prose, which is then in `raw`. */
    data:      ResearchDataByKind[K] | null;
    raw:       string;
  };
}[keyof ResearchDataByKind];

/** What a pasted answer was read as, shown before it is kept. */
export interface ResearchPasteSummary {
  structured: boolean;
  /** "3 Streitfragen", "4 Thesen" — what was found, as counted phrases. */
  found:      string[];
  sources:    number;
}
