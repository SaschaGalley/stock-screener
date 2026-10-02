/**
 * One stock's events on one axis.
 *
 * The page knew most of what happened to a stock and kept it in different
 * places: rating changes in the analyst archive, insider sales in another
 * table, the quarter's numbers in the fiscal table, dividends with the prices,
 * our own verdict changes in a list of their own, dated developments inside the
 * Perplexity brief, headlines in the news snapshots. Read together, in order,
 * they answer the question a price chart raises and cannot answer — what
 * happened then.
 *
 * Pure and dependency-free so the web app can import the types.
 */

export const TIMELINE_KINDS = ['analyst', 'insider', 'earnings', 'dividend', 'verdict', 'event', 'news', 'move'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_LABEL: Record<TimelineKind, string> = {
  analyst:  'Analysten',
  insider:  'Insider',
  earnings: 'Quartalszahlen',
  dividend: 'Dividenden & Splits',
  verdict:  'Urteil',
  event:    'Ereignisse',
  news:     'Nachrichten',
  move:     'Kurssprünge',
};

export type Tone = 'positive' | 'negative' | 'neutral';

export interface TimelineEvent {
  day:     string;
  kind:    TimelineKind;
  title:   string;
  detail?: string | null;
  url?:    string | null;
  tone:    Tone;
}

export interface Timeline {
  events:   TimelineEvent[];
  /** What is already scheduled — the next report — kept apart from what happened. */
  upcoming: TimelineEvent[];
  from:     string;
}

/** A rating action as an event, or null for one that changed nothing worth listing. */
export function analystEvent(a: {
  gradedAt: string; firm: string; action: string | null; fromGrade: string | null; toGrade: string | null;
  priceTargetAction: string | null; priceTarget: number | null; priorPriceTarget: number | null;
}, money: (n: number) => string): TimelineEvent | null {
  const day = a.gradedAt.slice(0, 10);
  const target = a.priceTarget && a.priceTarget > 0 ? a.priceTarget : null;
  const prior = a.priorPriceTarget && a.priorPriceTarget > 0 ? a.priorPriceTarget : null;
  const targetText = target ? (prior && prior !== target ? `Kursziel ${money(prior)} → ${money(target)}` : `Kursziel ${money(target)}`) : null;
  switch (a.action) {
    case 'up':
      return { day, kind: 'analyst', tone: 'positive', title: `${a.firm}: Hochstufung ${a.fromGrade ?? '?'} → ${a.toGrade ?? '?'}`, detail: targetText };
    case 'down':
      return { day, kind: 'analyst', tone: 'negative', title: `${a.firm}: Herabstufung ${a.fromGrade ?? '?'} → ${a.toGrade ?? '?'}`, detail: targetText };
    case 'init':
      return { day, kind: 'analyst', tone: gradeTone(a.toGrade), title: `${a.firm}: Erstbewertung ${a.toGrade ?? ''}`.trim(), detail: targetText };
    default: {
      // A reiteration only matters when the target moved.
      if (!target || !prior || target === prior) return null;
      const up = target > prior;
      return {
        day, kind: 'analyst', tone: up ? 'positive' : 'negative',
        title: `${a.firm}: Kursziel ${up ? 'erhöht' : 'gesenkt'} (${a.toGrade ?? 'unverändert'})`,
        detail: targetText,
      };
    }
  }
}

function gradeTone(grade: string | null): Tone {
  const g = (grade ?? '').toLowerCase();
  if (/buy|outperform|overweight|positive|accumulate/.test(g)) return 'positive';
  if (/sell|underperform|underweight|negative|reduce/.test(g)) return 'negative';
  return 'neutral';
}

/**
 * Days the stock moved further than it usually does: three of its own
 * standard deviations, and never less than five per cent — a utility's 3 % day
 * is news, a biotech's is Tuesday.
 */
export function bigMoves(bars: { day: string; close: number }[], from: string): TimelineEvent[] {
  const returns = bars.slice(1).map((b, k) => ({ day: b.day, r: b.close / bars[k].close - 1 }));
  const window = returns.filter((x) => x.day >= from);
  if (window.length < 20) return [];
  const mean = window.reduce((s, x) => s + x.r, 0) / window.length;
  const sd = Math.sqrt(window.reduce((s, x) => s + (x.r - mean) ** 2, 0) / window.length);
  const threshold = Math.max(0.05, 3 * sd);
  return window
    .filter((x) => Math.abs(x.r) >= threshold)
    .map((x) => ({
      day: x.day, kind: 'move' as const, tone: x.r > 0 ? 'positive' as const : 'negative' as const,
      title: `Kurs ${x.r > 0 ? '+' : '−'}${(Math.abs(x.r) * 100).toFixed(1)} % an einem Tag`,
      detail: `Mehr als das ${Math.round(Math.abs(x.r) / sd)}-Fache der üblichen Tagesbewegung`,
    }));
}
