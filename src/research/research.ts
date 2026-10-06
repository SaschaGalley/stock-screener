/**
 * Research run by hand: the prompt for each kind, the parser for its answer,
 * and where the answer is kept.
 *
 * The company brief is the API's own brief and goes where the API's report
 * would — the deep research slot every analysis reads. The other kinds are
 * for reading, not for the score: a preview of the next report, the check of
 * my own theses, a question across several stocks. They are kept as research
 * reports, with the prompt that produced them.
 */

import {
  extractJson, MANUAL_ANSWER_RULE, manualResearchPrompt, optText, pastedResearch, SYSTEM_PROMPT, text,
  type PastedResearchSummary,
} from '../data/perplexity.js';
import { query, queryOne } from '../db/client.js';
import { listJournal } from '../db/journal-store.js';
import { readFinancialsLax, writePerplexity } from '../db/store.js';
import type { ManualResearchTool } from '../models.js';
import {
  RESEARCH_KIND_META, REVIEW_CAUSES, REVIEW_VERDICTS, THEME_POSITIONS, THESIS_VERDICTS,
  type DecisionCheck, type EarningsPreview, type ResearchDataByKind, type ResearchKind, type ResearchPasteSummary,
  type ResearchReport, type ReviewCause, type ReviewVerdict, type ThemePosition, type ThemeResearch, type ThesisCheck,
  type ThesisVerdict,
} from './kinds.js';
import { RECORD_HORIZONS } from '../analysis/verdict-record.js';
import { readReview } from '../review-service.js';

export class ResearchInputError extends Error {}

// ── Prompts ──────────────────────────────────────────────────────────────────

/**
 * The company brief carries the same rule inline; it is not shared because
 * the brief's text is hashed, and a reworded brief invalidates every cached one.
 */
const SOURCE_RULE = `Source rule: "independent" means the information does not originate from the company.
The company's press releases, earnings calls, executives' remarks and investor presentations
are NOT independent, even when a newspaper reports them. Name the firm or author whenever you
can ("Morgan Stanley", "The Information"); never "an analyst" or "a published analysis".
Every factual claim carries a date and a source. An empty list is a valid answer.`;

const today = () => new Date().toISOString().slice(0, 10);
/** Yahoo's exchange suffix means nothing to a web search: ENR.DE is ENR. */
const searchTicker = (t: string) => (t.includes('.') ? t.split('.')[0] : t);
const named = async (symbol: string) => {
  const f = await readFinancialsLax(symbol);
  return { name: f?.companyName ?? symbol, ticker: searchTicker(symbol), nextReport: f?.nextEarningsDate ?? null };
};
const wrap = (body: string) => `${SYSTEM_PROMPT}\n\n${body}\n\n${SOURCE_RULE}\n\n${MANUAL_ANSWER_RULE}`;

/** How many of my own entries go into a thesis check, newest first, and how much of each. */
const THESIS_ENTRIES = 15;
const THESIS_CHARS = 1500;
const JOURNAL_KIND_EN = { note: 'note', buy: 'purchase', sell: 'sale' } as const;

const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/**
 * The prompt for looking back on one decision: what was done, the reason as
 * written, the situation that day and what the stock did against the index
 * since. Shares and amounts stay out — the judgement needs none of them.
 */
async function reviewPrompt(symbol: string, decisionKey: string | null | undefined): Promise<string> {
  if (!decisionKey) throw new ResearchInputError('Welche Entscheidung?');
  const review = await readReview();
  const d = review.decisions.find((x) => x.key === decisionKey);
  if (!d || d.symbol !== symbol) throw new ResearchInputError('Diese Entscheidung gibt es nicht mehr.');
  const c = await named(symbol);
  const body = d.entryId !== null ? (await listJournal()).find((e) => e.id === d.entryId)?.body ?? null : null;
  const s = d.situation;
  const legs = d.outcome
    ? [
      ...RECORD_HORIZONS.flatMap((h) => {
        const l = d.outcome!.horizons[h];
        return l && l.index !== null ? [`${h} month${h === 1 ? '' : 's'}: stock ${signed(l.stock)}, S&P 500 ${signed(l.index)}`] : [];
      }),
      ...(d.outcome.since && d.outcome.since.index !== null
        ? [`to today: stock ${signed(d.outcome.since.stock)}, S&P 500 ${signed(d.outcome.since.index)}`] : []),
    ]
    : [];
  const action = d.side === 'buy' ? 'bought' : 'sold';
  return wrap(`An investor ${action} ${c.name} (${c.ticker}) on ${d.day}.

Their reason, written at the time (often German):
${body ? `"""\n${body}\n"""` : 'No reason was written down.'}

That day: ${s?.flags.length ? s.flags.join('; ') : 'nothing unusual in price, volume or the year\'s range'}${
  s?.verdict ? `; the investor's own model rated the stock ${s.verdict}` : ''}.

Since then, total return in US dollars against the S&P 500:
${legs.length ? legs.map((l) => `- ${l}`).join('\n') : '- not measurable from the prices on file'}

Judge the decision in hindsight, as of ${today()}, from evidence rather than from the price alone:

1. "what_happened": the dated events since ${d.day} that moved the stock against the index, and the
   effect of each.
2. "reason_check": for each part of the stated reason, whether it played out — with figures. Without
   a written reason, what most likely prompted the ${d.side === 'buy' ? 'purchase' : 'sale'}, given the situation that day.
3. "verdict": did the reason hold? "held" | "partly" | "failed" | "too_early".
4. "cause": did the result — good or bad — come from the stated reason ("reason"), from something the
   reason did not consider ("other"), "mixed", or "unclear". Being right for the wrong reason is "other".
5. "drivers": what actually drove the stock against the index since the decision.
6. "lesson": one or two sentences the investor can apply to the next decision — specific to what
   happened here, not generic advice.
7. "now": whether the original reason still applies today, and what would show that it no longer does.

Return ONLY this JSON:
{
  "what_happened": [{"date": "YYYY-MM-DD", "event": "...", "effect": "...", "source": "url"}],
  "reason_check":  "...",
  "verdict":       "partly",
  "cause":         "mixed",
  "drivers":       "...",
  "lesson":        "...",
  "now":           "..."
}`);
}

/** The prompt to copy for `kind`. Throws a ResearchInputError when it cannot be built. */
export async function researchPromptFor(
  kind: ResearchKind, symbols: string[], extra: { question?: string | null; decision?: string | null } = {},
): Promise<string> {
  const { question, decision } = extra;
  const scope = RESEARCH_KIND_META[kind].scope;
  if (symbols.length === 0) throw new ResearchInputError('Welche Aktie?');
  if (scope === 'one' && symbols.length > 1) throw new ResearchInputError(`${RESEARCH_KIND_META[kind].label} gilt einer Aktie.`);

  if (kind === 'company') {
    const c = await named(symbols[0]);
    return manualResearchPrompt(symbols[0], c.name);
  }

  if (kind === 'earnings') {
    const c = await named(symbols[0]);
    const expected = c.nextReport && c.nextReport >= today() ? ` The report is expected on ${c.nextReport}.` : '';
    return wrap(`Preview the next quarterly report of ${c.name} (${c.ticker}), as of ${today()}.${expected}

We already hold its reported financials, analyst ratings, price targets and estimate revisions.
What we need is the setup going into the report:

1. "consensus": the consensus figures for the quarter — revenue, EPS and the company-specific
   operating metrics the stock trades on — and the guidance the market expects, each with a source.
2. "bar": where the real bar sits. Buy-side expectations where reported, what management guided,
   and what the share price move into the report already assumes. Be specific: which number,
   above or below what, and why.
3. "implied_move": the options-implied move around the report, if available.
4. "history": the last two to four reports — the result against consensus and guidance, and the
   share price reaction the next day.
5. "watch": the three to five items that will decide the reaction. For each, why it matters and
   the threshold that would read bullish ("bull_if") or bearish ("bear_if").
6. "risks": what could go wrong in this report specifically.

Return ONLY this JSON:
{
  "report_date":  "YYYY-MM-DD",
  "consensus":    [{"metric": "...", "value": "...", "source": "url"}],
  "bar":          "...",
  "implied_move": "...",
  "history":      [{"period": "Q2 2026", "result": "...", "reaction": "..."}],
  "watch":        [{"item": "...", "why": "...", "bull_if": "...", "bear_if": "..."}],
  "risks":        [{"risk": "...", "source": "url"}]
}`);
  }

  if (kind === 'thesis') {
    const c = await named(symbols[0]);
    const entries = (await listJournal(symbols[0])).slice(0, THESIS_ENTRIES);
    if (entries.length === 0) {
      throw new ResearchInputError(`Keine Journal-Einträge zu ${symbols[0]} — schreib zuerst auf, was du denkst.`);
    }
    const views = entries.map((e, i) => {
      const body = e.body.length > THESIS_CHARS ? `${e.body.slice(0, THESIS_CHARS)} …` : e.body;
      return `${i + 1}. [${e.day}, ${JOURNAL_KIND_EN[e.kind]}]\n${body}`;
    }).join('\n\n');
    return wrap(`An investor holds these views on ${c.name} (${c.ticker}), written in a personal
journal — newest first, dated when written, in the investor's own words (often German):

${views}

Test every view against the evidence as of ${today()}. Start from the assumption that the
investor is wrong: look for the strongest disconfirming evidence first, then for support. Do not
soften a verdict to be polite. A view that public evidence cannot test is "untestable", not
"supported". Restate several entries that argue the same point as one thesis.

For each thesis:
- "thesis": the view, restated in one neutral English sentence,
- "verdict": "supported" | "mixed" | "contradicted" | "untestable",
- "against": the strongest evidence against it, with figures and dates,
- "for": the strongest evidence for it,
- "would_change": the figure or event that would change the verdict, and when,
- "sources": the URLs behind both.

Then "missed": up to three things that matter for this stock which the views do not consider.

Return ONLY this JSON:
{
  "theses": [{"thesis": "...", "verdict": "mixed", "against": "...", "for": "...", "would_change": "...", "sources": ["url"]}],
  "missed": [{"point": "...", "source": "url"}]
}`);
  }

  if (kind === 'review') return reviewPrompt(symbols[0], decision);

  // theme
  const q = question?.trim();
  if (!q) throw new ResearchInputError('Welche Frage?');
  const companies = await Promise.all(symbols.map(named));
  return wrap(`Question: ${q}

Companies: ${companies.map((c) => `${c.name} (${c.ticker})`).join(', ')}

Answer as of ${today()}, from evidence rather than narrative.

1. "answer": the short answer in two to four sentences, with the main reason — or that the
   evidence does not settle it yet, and why.
2. "companies": each company listed, and at most two others that clearly matter to the question.
   For each: "position" on this question ("leader" | "contender" | "laggard" | "unclear"),
   "strengths", "weaknesses", "evidence" — the strongest dated, sourced fact behind the position —
   and "source".
3. "uncertainties": the open questions that will decide it, what would settle each ("settles"),
   and when ("when").
4. "watch": dated events in the next six months that bear on the question, and why.

Return ONLY this JSON:
{
  "answer":        "...",
  "companies":     [{"ticker": "...", "position": "contender", "strengths": "...", "weaknesses": "...", "evidence": "...", "source": "url"}],
  "uncertainties": [{"question": "...", "settles": "...", "when": "YYYY-MM-DD"}],
  "watch":         [{"date": "YYYY-MM-DD", "event": "...", "why": "..."}]
}`);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const list = <T>(v: unknown, f: (x: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.flatMap((x) => (x && typeof x === 'object' ? [f(x as Record<string, unknown>)] : [])).filter((x): x is T => x !== null) : [];
const urls = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).map(text).filter((u) => /^https?:\/\//.test(u));
const oneOf = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T => {
  const t = text(v).toLowerCase();
  return (allowed as readonly string[]).includes(t) ? t as T : fallback;
};

export const RESEARCH_PARSERS: { [K in keyof ResearchDataByKind]: (o: Record<string, unknown>) => ResearchDataByKind[K] } = {
  earnings: (o): EarningsPreview => ({
    reportDate:  optText(o.report_date ?? o.reportDate),
    consensus:   list(o.consensus, (x) => (text(x.metric) ? { metric: text(x.metric), value: text(x.value), source: optText(x.source) } : null)),
    bar:         optText(o.bar),
    impliedMove: optText(o.implied_move ?? o.impliedMove),
    history:     list(o.history, (x) => (text(x.period) ? { period: text(x.period), result: text(x.result), reaction: optText(x.reaction) } : null)),
    watch:       list(o.watch, (x) => (text(x.item) ? {
      item: text(x.item), why: text(x.why), bullIf: optText(x.bull_if ?? x.bullIf), bearIf: optText(x.bear_if ?? x.bearIf),
    } : null)),
    risks:       list(o.risks, (x) => (text(x.risk) ? { risk: text(x.risk), source: optText(x.source) } : null)),
  }),
  thesis: (o): ThesisCheck => ({
    theses: list(o.theses, (x) => (text(x.thesis) ? {
      thesis:      text(x.thesis),
      // An unknown grade reads as untestable: a label the model invented never upgrades a view.
      verdict:     oneOf<ThesisVerdict>(THESIS_VERDICTS, x.verdict, 'untestable'),
      against:     text(x.against),
      for:         text(x.for),
      wouldChange: optText(x.would_change ?? x.wouldChange),
      sources:     urls(x.sources ?? x.source),
    } : null)),
    missed: list(o.missed, (x) => (text(x.point) ? { point: text(x.point), source: optText(x.source) } : null)),
  }),
  review: (o): DecisionCheck => ({
    // An unknown grade reads as the most cautious one: a label the model invented never passes a reason.
    verdict:      oneOf<ReviewVerdict>(REVIEW_VERDICTS, o.verdict, 'too_early'),
    cause:        oneOf<ReviewCause>(REVIEW_CAUSES, o.cause, 'unclear'),
    reasonCheck:  text(o.reason_check ?? o.reasonCheck),
    drivers:      text(o.drivers),
    lesson:       text(o.lesson),
    now:          optText(o.now),
    whatHappened: list(o.what_happened ?? o.whatHappened, (x) => (text(x.event) ? {
      date: optText(x.date), event: text(x.event), effect: text(x.effect), source: optText(x.source),
    } : null)),
  }),
  theme: (o): ThemeResearch => ({
    answer:        text(o.answer),
    companies:     list(o.companies, (x) => (text(x.ticker) ? {
      ticker:     text(x.ticker).toUpperCase(),
      position:   oneOf<ThemePosition>(THEME_POSITIONS, x.position, 'unclear'),
      strengths:  text(x.strengths),
      weaknesses: text(x.weaknesses),
      evidence:   text(x.evidence),
      source:     optText(x.source),
    } : null)),
    uncertainties: list(o.uncertainties, (x) => (text(x.question) ? { question: text(x.question), settles: optText(x.settles), when: optText(x.when) } : null)),
    watch:         list(o.watch, (x) => (text(x.event) ? { date: optText(x.date), event: text(x.event), why: text(x.why) } : null)),
  }),
};

/** Counted, in German: 1 Ereignis, 4 Ereignisse. Zeros are left out. */
const counted = (pairs: [number, string, string][]) =>
  pairs.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);

const COMPANY_PHRASES: [keyof PastedResearchSummary['counts'], string, string][] = [
  ['debate', 'Streitfrage', 'Streitfragen'], ['events', 'Ereignis', 'Ereignisse'], ['kpis', 'Kennzahl', 'Kennzahlen'],
  ['bearEvidence', 'Gegenbeleg', 'Gegenbelege'], ['bullClaims', 'Bullen-These', 'Bullen-Thesen'],
  ['bearClaims', 'Bären-These', 'Bären-Thesen'], ['catalysts', 'Termin', 'Termine'],
];

function foundIn<K extends keyof ResearchDataByKind>(kind: K, d: ResearchDataByKind[K]): { found: string[]; sources: string[] } {
  if (kind === 'earnings') {
    const e = d as EarningsPreview;
    return {
      found: counted([[e.consensus.length, 'Konsens-Zahl', 'Konsens-Zahlen'], [e.history.length, 'frühere Meldung', 'frühere Meldungen'],
        [e.watch.length, 'Prüfpunkt', 'Prüfpunkte'], [e.risks.length, 'Risiko', 'Risiken']]),
      sources: [...e.consensus.map((x) => x.source), ...e.risks.map((x) => x.source)].filter((x): x is string => !!x),
    };
  }
  if (kind === 'thesis') {
    const t = d as ThesisCheck;
    return {
      found: counted([[t.theses.length, 'These', 'Thesen'], [t.missed.length, 'übersehener Punkt', 'übersehene Punkte']]),
      sources: [...t.theses.flatMap((x) => x.sources), ...t.missed.map((x) => x.source)].filter((x): x is string => !!x),
    };
  }
  if (kind === 'review') {
    const r = d as DecisionCheck;
    return {
      found: counted([[r.reasonCheck ? 1 : 0, 'Prüfung der Begründung', 'Prüfungen'], [r.whatHappened.length, 'Ereignis', 'Ereignisse'],
        [r.lesson ? 1 : 0, 'Lehre', 'Lehren']]),
      sources: r.whatHappened.map((x) => x.source).filter((x): x is string => !!x),
    };
  }
  const m = d as ThemeResearch;
  return {
    found: counted([[m.answer ? 1 : 0, 'Antwort', 'Antworten'], [m.companies.length, 'Firma', 'Firmen'],
      [m.uncertainties.length, 'offene Frage', 'offene Fragen'], [m.watch.length, 'Termin', 'Termine']]),
    sources: m.companies.map((x) => x.source).filter((x): x is string => !!x),
  };
}

/** Prose without JSON is kept as it is — but a stray sentence is not a report. */
const MIN_PROSE = 400;

/**
 * Read a pasted answer and, with `save`, keep it. Throws a ResearchInputError
 * when there is nothing to keep.
 */
export async function pasteResearch(input: {
  kind: ResearchKind; symbols: string[]; question?: string | null; decision?: string | null;
  text: string; tool: ManualResearchTool; save: boolean;
}): Promise<{ saved: boolean; summary: ResearchPasteSummary }> {
  const { kind, symbols, tool, save } = input;
  if (symbols.length === 0) throw new ResearchInputError('Welche Aktie?');

  if (kind === 'company') {
    const pasted = pastedResearch(input.text, tool);
    if (!pasted) throw new ResearchInputError('Nichts Verwertbares erkannt — weder die JSON-Antwort noch ein Bericht in Textform.');
    if (save) await writePerplexity(symbols[0], pasted.context);
    const c = pasted.summary.counts;
    return {
      saved: save,
      summary: {
        structured: pasted.summary.structured,
        found: counted(COMPANY_PHRASES.map(([k, one, many]) => [c[k], one, many])),
        sources: pasted.summary.sources,
      },
    };
  }

  const obj = extractJson(input.text);
  const data = obj ? RESEARCH_PARSERS[kind](obj) : null;
  const { found, sources } = data ? foundIn(kind, data) : { found: [], sources: [] };
  const structured = found.length > 0;
  if (!structured && input.text.trim().length < MIN_PROSE) {
    throw new ResearchInputError('Nichts Verwertbares erkannt — weder die JSON-Antwort noch ein Bericht in Textform.');
  }
  if (save) {
    const prompt = await researchPromptFor(kind, symbols, { question: input.question, decision: input.decision }).catch(() => '');
    await query(
      `INSERT INTO research_reports (kind, symbols, question, decision, tool, prompt, raw, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [kind, symbols, input.question?.trim() || null, kind === 'review' ? input.decision ?? null : null,
        tool, prompt, input.text, structured ? JSON.stringify(data) : null],
    );
  }
  return { saved: save, summary: { structured, found, sources: new Set(sources).size } };
}

/** The reports naming `symbol`, or all of them, newest first. */
export async function listResearch(symbol?: string, kind?: ResearchReport['kind']): Promise<ResearchReport[]> {
  const res = await query<{
    id: number; kind: ResearchReport['kind']; symbols: string[]; question: string | null; decision: string | null; tool: string;
    created_at: Date; data: unknown; raw: string;
  }>(
    `SELECT id, kind, symbols, question, decision, tool, created_at, data, raw FROM research_reports
      WHERE deleted_at IS NULL AND ($1::text IS NULL OR symbols @> ARRAY[$1::text]) AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at DESC`,
    [symbol?.toUpperCase() ?? null, kind ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id, kind: r.kind, symbols: r.symbols, question: r.question, decision: r.decision, tool: r.tool,
    createdAt: r.created_at.toISOString(), data: r.data, raw: r.raw,
  }) as ResearchReport);
}

/** Marked, not removed. */
export async function deleteResearch(id: number): Promise<boolean> {
  const r = await queryOne<{ id: number }>(
    'UPDATE research_reports SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id],
  );
  return r !== null;
}
