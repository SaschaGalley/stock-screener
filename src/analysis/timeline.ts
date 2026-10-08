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

import { ratingBucket } from './analyst-history.js';

export const TIMELINE_KINDS = ['journal', 'analyst', 'insider', 'earnings', 'dividend', 'verdict', 'event', 'news', 'move'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_LABEL: Record<TimelineKind, string> = {
  journal:  'Mein Journal',
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
  const b = ratingBucket(grade);
  return b === 'strongBuy' || b === 'buy' ? 'positive' : b === 'sell' || b === 'strongSell' ? 'negative' : 'neutral';
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
      title: `Kurs ${x.r > 0 ? '+' : '−'}${(Math.abs(x.r) * 100).toFixed(1).replace('.', ',')} % an einem Tag`,
      detail: `Mehr als das ${Math.round(Math.abs(x.r) / sd)}-Fache der üblichen Tagesbewegung`,
    }));
}

/** A catalyst's words that say it is the quarter's report, which the calendar already dates. */
const REPORT_WORDS = /\b(earnings|results|quarter|q[1-4]|quartal|zahlen|report)/i;

/**
 * What is scheduled: the next report, the next ex-dividend and payment day,
 * and the dated catalysts the newest research brief named — each from today
 * on. A catalyst that is the report itself, within a day of the calendar's
 * date, lends the report what to watch instead of standing twice. `money`
 * writes an amount in the stock's currency.
 */
export function upcomingOf(
  f: { nextEarningsDate: string | null; exDividendDate: string | null; dividendPayDate: string | null; nextDividendAmount: number | null } | null,
  catalysts: readonly { date: string | null; event: string; watch: string }[],
  today: string,
  money: (n: number) => string,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 86_400_000;
  const report = f?.nextEarningsDate && f.nextEarningsDate >= today ? f.nextEarningsDate : null;
  let reportWatch: string | null = null;
  for (const c of catalysts) {
    if (!c.date || !/^\d{4}-\d{2}-\d{2}$/.test(c.date) || c.date < today) continue;
    if (report && near(c.date, report) && REPORT_WORDS.test(c.event)) { reportWatch ??= c.watch || null; continue; }
    out.push({ day: c.date, kind: 'event', tone: 'neutral', title: c.event, detail: c.watch || null });
  }
  if (report) out.push({ day: report, kind: 'earnings', tone: 'neutral', title: 'Quartalszahlen', detail: reportWatch });
  if (f?.exDividendDate && f.exDividendDate >= today) {
    out.push({
      day: f.exDividendDate, kind: 'dividend', tone: 'neutral', title: 'Ex-Dividende',
      detail: f.nextDividendAmount ? `${money(f.nextDividendAmount)} je Aktie` : null,
    });
  }
  if (f?.dividendPayDate && f.dividendPayDate >= today && f.dividendPayDate !== f.exDividendDate) {
    out.push({ day: f.dividendPayDate, kind: 'dividend', tone: 'neutral', title: 'Dividendenzahlung', detail: null });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}
