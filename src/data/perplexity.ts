import { createHash } from 'crypto';
import { DEFAULT_PERPLEXITY_MODEL, PerplexityModelId } from '../models.js';
import { logger } from '../utils/logger.js';

/**
 * One dated, sourced item of evidence.
 *
 * `independent` is the model's own label and is kept because it is the single
 * most useful thing to know about a claim here: a company press release and a
 * published short report are both "sources", and treating them alike is how the
 * previous synthesis ended up a third newsroom copy.
 */
export interface PerplexityFinding {
  date:        string | null;
  what:        string;
  /** What it changes for the outlook. Absent on rows before 3 October 2026. */
  impact?:     string | null;
  source:      string | null;
  independent: boolean;
}

/**
 * How a claim in circulation holds up against the evidence.
 *
 * Each side has its own way of being unsupported: a bull claim that only
 * management makes (`management-only`), a bear claim nobody has evidenced yet
 * (`opinion`). Both are that side's weakest grade.
 */
export type ClaimEvidence = 'independent' | 'management-only' | 'opinion' | 'contradicted';

/**
 * A claim in circulation — bullish or bearish — checked against the evidence.
 *
 * The fields after `claim` turn a slogan into an argument: how it works on the
 * business, what it is worth, who makes it, what speaks against it and what
 * would settle it. They are absent on rows before 3 October 2026, when a claim
 * was a sentence and a grade.
 */
export interface PerplexityClaim {
  claim:       string;
  mechanism?:  string | null;
  stake?:      string | null;
  proponents?: string | null;
  evidence:    ClaimEvidence;
  detail:      string;
  counter?:    string | null;
  settles?:    string | null;
  source:      string | null;
}

/** One of the few questions the stock hinges on, and how it gets answered. */
export interface PerplexityDebate {
  question: string;
  why:      string;
  settles:  string | null;
  when:     string | null;
}

/**
 * A company-specific operating figure over recent quarters — cRPO, net
 * retention, same-store sales, backlog. The statements we hold do not carry
 * them, and they are usually what the debate is about.
 */
export interface PerplexityKpi {
  name:   string;
  values: { period: string; value: string }[];
  read:   string;
  source: string | null;
}

/** A dated event ahead, and what to watch in it. */
export interface PerplexityCatalyst {
  date:  string | null;
  event: string;
  watch: string;
}

export interface PerplexityFindings {
  /** The open questions the stock hinges on. Absent before 3 October 2026. */
  debate?:      PerplexityDebate[];
  events:       PerplexityFinding[];
  /** Absent before 3 October 2026. */
  kpis?:        PerplexityKpi[];
  bearEvidence: PerplexityFinding[];
  bullClaims:   PerplexityClaim[];
  /**
   * What the bears argue, graded like the bull claims. Absent on rows from
   * before 2 October 2026, when the brief asked only for the bull side and the
   * bear side was evidence without the argument it supports.
   */
  bearClaims?:  PerplexityClaim[];
  /** Absent before 3 October 2026. */
  catalysts?:   PerplexityCatalyst[];
}

export interface PerplexityContext {
  model: PerplexityModelId;
  /** Rendered markdown — what the UI shows and older readers expect. */
  synthesis: string;
  citations: string[];
  fetchedAt: string;
  /** The structured answer, when the model returned one. Absent on old rows. */
  findings?: PerplexityFindings;
  /** Which prompt produced this. A row from another prompt is not a cache hit. */
  promptHash?: string;
  /** What the call cost, from the API's own usage figures. Absent on old rows. */
  costUsd?: number;
  /** The API's usage block as returned — tokens, searches, cost. */
  usage?: unknown;
  /** The answer as returned, thinking included. Kept so a parser fix can re-read it. */
  raw?: string;
  /** Why the answer ended — `stop`, or `length` when it ran into the ceiling. */
  finishReason?: string;
}

const PPLX_API_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * The research brief — rewritten around what the rest of the pipeline cannot see.
 *
 * The first prompt asked for recent developments, earnings highlights, the
 * competitive position, analyst targets and a bull and bear case, and it got
 * what it asked for. For ServiceNow that was a third of its sources from the
 * company's own newsroom (a partnership, a Brazil office), analyst targets we
 * already read from Yahoo, and a bull and bear case written a second time by a
 * model nobody audits — its bear case read "competitive pressure could
 * intensify". Meanwhile the one fact that mattered most in our own data, 71 net
 * estimate cuts, went unexplained.
 *
 * So the brief names what we already hold and forbids repeating it, asks for
 * dated events that move the outlook, demands *specific* evidence against the
 * bull case, and has the claims in circulation graded against the evidence.
 *
 * The third version (3 October 2026) is about depth. The second capped every
 * item at two sentences, and the answer read like it: "ServiceNow is gaining
 * share across workflows — management-only", a slogan and a grade. Three of five
 * bear theses rested on one anonymous "published bearish analysis", and a CFO's
 * remark came back labelled independent. Now a claim is an argument — how it
 * works on the business, what it is worth, who makes it, the strongest point
 * against it and the figure that would settle it — and three things a reader
 * needs were added: the one or two questions the stock hinges on, the
 * company's own operating KPIs over recent quarters (none of which the
 * statements carry), and the dates ahead. "Independent" is defined rather than
 * left to the model, and the proponents must be named.
 */
const SYSTEM_PROMPT =
  'You are a senior buy-side equity analyst preparing the research file for an investment ' +
  'committee. You separate evidence from opinion, you name who argues what, and you quantify ' +
  'whenever a figure exists. You are paid to find what consensus is missing, in either ' +
  'direction. Every factual claim carries a date and a source. You never pad a section: an ' +
  'empty list is a valid, useful answer. Never refuse, and never add commentary about your search.';

// {date} is replaced at runtime and is deliberately outside the hash.
const PROMPT_TEMPLATE =
  `Research {company} ({ticker}) as of {date}.

We already hold its price, valuation multiples, reported financial statements, analyst
ratings, price targets, estimate revisions and insider transactions. Do NOT repeat those.
Report what that data cannot show, mostly from the last 90 days.

Source rule: "independent" means the information does not originate from the company.
The company's press releases, earnings calls, executives' remarks and investor
presentations are NOT independent, even when a newspaper reports them. Analyst research,
short-seller reports, regulators, courts, customers, competitors and industry data are.
Name the firm or author whenever you can ("Morgan Stanley", "Hindenburg", "The
Information"); never "an analyst" or "a published analysis".

1. "debate": the one to three open questions the stock price hinges on right now — the
   points on which bulls and bears actually disagree. For each: why it matters for
   earnings or the multiple, which figure or event would settle it, and when that is due.

2. "events": concrete, dated developments of the last 90 days that change the business
   outlook. Always include the most recent earnings report: guidance raised, cut or held
   versus the prior quarter and versus consensus, and what management emphasised or
   avoided. Also M&A with terms, C-suite changes, regulatory or legal decisions, major
   customer wins or losses, pricing changes, shifts in the product cycle. Partnership press
   releases, minor product launches and routine insider sales do NOT qualify. For each,
   "impact": what it changes for revenue, margins or risk, quantified where possible.

3. "kpis": up to four company-specific operating figures that are not line items of the
   income statement, balance sheet or cash flow statement, with values for the last two
   to four reported periods — for example remaining performance obligations, net revenue
   retention, subscribers, same-store sales, backlog, book-to-bill, utilisation, churn.
   Pick the ones the debate is about. "read": what the trend says.

4. "bear_evidence": the strongest SPECIFIC evidence against the bull case — short-seller
   reports, accounting or audit concerns, guidance cuts or misses, churn or seat
   reductions, share lost to a named competitor, structural threats to the business model
   that analysts or industry data have documented. Evidence only, never "risks could
   include". For each, "impact" as above.

5. "bull_claims" and 6. "bear_claims": the theses in circulation, as the people who hold
   them argue them. For each:
   - "claim": the thesis in one sentence,
   - "mechanism": how it works through the business — the causal chain, in two to four
     sentences,
   - "stake": what it is worth if right — revenue, margin, earnings or multiple, with
     figures from the sources where they exist,
   - "proponents": who argues it, by name,
   - "evidence": bull claims "independent" | "management-only" | "contradicted";
     bear claims "independent" | "opinion" | "contradicted",
   - "detail": the strongest evidence for the grade,
   - "counter": the strongest point against the claim,
   - "settles": the figure or event that would prove or disprove it, and when.

7. "catalysts": dated events in the next six months that can move the stock — earnings
   dates, investor days, product launches, regulatory decisions, contract renewals — and
   what to watch in each.

At most 3 debate items, 6 events, 4 kpis, 6 bear_evidence items, 5 bull_claims,
5 bear_claims and 4 catalysts: the strongest, not all of them.

Return ONLY this JSON:
{
  "debate":        [{"question": "...", "why": "...", "settles": "...", "when": "YYYY-MM-DD"}],
  "events":        [{"date": "YYYY-MM-DD", "what": "...", "impact": "...", "source": "url", "independent": true}],
  "kpis":          [{"name": "...", "values": [{"period": "Q2 2026", "value": "..."}], "read": "...", "source": "url"}],
  "bear_evidence": [{"date": "YYYY-MM-DD", "what": "...", "impact": "...", "source": "url", "independent": true}],
  "bull_claims":   [{"claim": "...", "mechanism": "...", "stake": "...", "proponents": "...", "evidence": "independent", "detail": "...", "counter": "...", "settles": "...", "source": "url"}],
  "bear_claims":   [{"claim": "...", "mechanism": "...", "stake": "...", "proponents": "...", "evidence": "opinion", "detail": "...", "counter": "...", "settles": "...", "source": "url"}],
  "catalysts":     [{"date": "YYYY-MM-DD", "event": "...", "watch": "..."}]
}`;

/**
 * Per-model request settings.
 *
 * High search context throughout: at "low" the first brief found four insider
 * filings and nothing else. The ceiling for the two plain models is margin over
 * an answer of around 6,000 tokens. The reasoning models get none: their
 * thinking counts against `max_tokens` without showing up in the usage, and on
 * the first run both stopped with `length` after 2,000 to 6,000 visible tokens —
 * deep research after 1,265, mid-claim. Their cost is the thinking, not the
 * answer, so a ceiling saves nothing worth having. Deep research decides its
 * own number of searches and takes minutes, not seconds.
 */
const MODEL_PARAMS: Record<PerplexityModelId, {
  max_tokens?: number; timeoutMs: number; stream?: boolean; extra?: Record<string, unknown>;
}> = {
  'sonar':               { max_tokens: 10_000, timeoutMs: 120_000 },
  'sonar-pro':           { max_tokens: 10_000, timeoutMs: 180_000 },
  'sonar-reasoning-pro': { timeoutMs: 420_000, stream: true },
  'sonar-deep-research': { timeoutMs: 1_200_000, stream: true, extra: { reasoning_effort: 'high' } },
};

/**
 * Streamed, because Node's fetch gives up on a response whose headers have
 * not arrived after five minutes, and deep research without a token ceiling
 * thinks longer than that before it answers: both reports of the second run
 * failed with "fetch failed" after being billed. A stream sends its headers at
 * once and then a chunk whenever the model has something, so the connection
 * lives as long as the work does.
 *
 * Each chunk carries the delta of the answer; citations and usage come with
 * the later chunks, so the last one seen wins.
 */
async function readStream(res: Response): Promise<PplxResponse> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish: string | undefined;
  const out: PplxResponse = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: PplxResponse & { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> };
      try { chunk = JSON.parse(data); } catch { continue; }
      content += chunk.choices?.[0]?.delta?.content ?? '';
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
      if (chunk.citations) out.citations = chunk.citations;
      if (chunk.usage) out.usage = chunk.usage;
    }
  }
  out.choices = [{ message: { content }, finish_reason: finish }];
  return out;
}

const API_PARAMS = {
  temperature: 0.1,
  web_search_options: { search_context_size: 'high' },
};

export const PERPLEXITY_PROMPT_HASH = createHash('md5')
  .update(SYSTEM_PROMPT + PROMPT_TEMPLATE + JSON.stringify(API_PARAMS))
  .digest('hex')
  .slice(0, 8);

/** The brief for one company, as the API is sent it. */
export function researchPrompt(ticker: string, companyName: string): { system: string; user: string } {
  // Strip Yahoo exchange suffix (ENR.DE → ENR, 0700.HK → 0700) — meaningless for web search
  const searchTicker = ticker.includes('.') ? ticker.split('.')[0] : ticker;
  const today = new Date().toISOString().slice(0, 10);
  const user = PROMPT_TEMPLATE
    .replace('{date}', today)
    .replaceAll('{company}', companyName)
    .replaceAll('{ticker}', searchTicker);
  return { system: SYSTEM_PROMPT, user };
}

/**
 * The same brief for pasting into the Perplexity app by hand.
 *
 * The app has no system prompt, so it leads the text. And the app numbers its
 * sources as [1], [2] beside the answer rather than writing them into it — a
 * number would be stripped by the parser and leave the item without a source,
 * so the URL is asked for in so many words.
 */
export function manualResearchPrompt(ticker: string, companyName: string): string {
  const { system, user } = researchPrompt(ticker, companyName);
  return `${system}\n\n${user}\n\n`
    + 'Write the full URL into every "source" field, never a citation number. '
    + 'Put the JSON in a single ```json code block.';
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const text = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim() : '';
const optText = (v: unknown): string | null => text(v) || null;

function finding(v: unknown): PerplexityFinding | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const what = text(o.what);
  if (!what) return null;
  return {
    date:        optText(o.date),
    what,
    impact:      optText(o.impact),
    source:      optText(o.source),
    independent: o.independent === true || o.independent === 'true',
  };
}

function debate(v: unknown): PerplexityDebate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const question = text(o.question);
  if (!question) return null;
  return { question, why: text(o.why), settles: optText(o.settles), when: optText(o.when) };
}

const NOT_REPORTED = /\b(n\/a|not (available|disclosed|identified|reported|separately reported))\b/i;
const notReported = (v: string) => /^(n\/?a|none|unknown)$/i.test(v) || (NOT_REPORTED.test(v) && !/\d/.test(v));

function kpi(v: unknown): PerplexityKpi | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = text(o.name);
  const values = Array.isArray(o.values)
    ? o.values.flatMap((x) => {
        if (!x || typeof x !== 'object') return [];
        const r = x as Record<string, unknown>;
        const period = text(r.period);
        const value = text(typeof r.value === 'number' ? String(r.value) : r.value);
        // Asked for two to four periods, models fill the missing ones with
        // "Not available in the gathered sources" rather than leave them out.
        return period && value && !notReported(value) ? [{ period, value }] : [];
      })
    : [];
  // A KPI without a single value is a name, not a finding.
  if (!name || values.length === 0) return null;
  return { name, values, read: text(o.read), source: optText(o.source) };
}

function catalyst(v: unknown): PerplexityCatalyst | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const event = text(o.event);
  if (!event) return null;
  return { date: optText(o.date), event, watch: text(o.watch) };
}

/**
 * A claim, graded. Anything unrecognised reads as `weakest` — the side's own
 * unsupported grade — so a label the model invented never upgrades a claim.
 */
function claimOf(weakest: 'management-only' | 'opinion') {
  return (v: unknown): PerplexityClaim | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const claim = text(o.claim);
    if (!claim) return null;
    const raw = text(o.evidence).toLowerCase();
    const evidence: ClaimEvidence =
      raw.startsWith('contra') ? 'contradicted'
      : raw.startsWith('indep') ? 'independent'
      : weakest;
    return {
      claim,
      mechanism:  optText(o.mechanism),
      stake:      optText(o.stake),
      proponents: optText(o.proponents),
      evidence,
      detail:     text(o.detail),
      counter:    optText(o.counter),
      settles:    optText(o.settles),
      source:     optText(o.source),
    };
  };
}

/**
 * The structured answer, or null when there is none to be had.
 *
 * Lenient on shape and strict on substance: a missing list is an empty one, an
 * unknown evidence label reads as the weakest, and an item with no text is
 * dropped. What is never done is inventing a finding the model did not return.
 */
export function parseFindings(answer: string): PerplexityFindings | null {
  // The reasoning models think aloud before they answer, and the thinking may
  // hold braces and fences of its own. An unclosed block is a truncated one,
  // and then there is no answer after it.
  const raw = answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/)?.[1];
  const start = raw.indexOf('{');
  const body = (fenced ?? (start >= 0 ? raw.slice(start) : raw)).trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // A truncated answer still holds every item that finished. Keep those
    // rather than throw away a paid call over the one that did not.
    const salvaged = salvageTruncatedJson(body);
    if (salvaged === null) return null;
    try {
      obj = JSON.parse(salvaged) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
    Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [];
  return {
    debate:       list(obj.debate, debate),
    events:       list(obj.events, finding),
    kpis:         list(obj.kpis, kpi),
    bearEvidence: list(obj.bear_evidence ?? obj.bearEvidence, finding),
    bullClaims:   list(obj.bull_claims ?? obj.bullClaims, claimOf('management-only')),
    bearClaims:   list(obj.bear_claims ?? obj.bearClaims, claimOf('opinion')),
    catalysts:    list(obj.catalysts, catalyst),
  };
}

/**
 * Cut a truncated JSON document back to its last complete array element and
 * close what is still open.
 *
 * The brief's answer is `{ "events": [ {...}, ... ], "bear_evidence": [...], ... }`,
 * so an element finishes whenever an object closes back into an array. Tracking
 * the open containers at each such point gives both the place to cut and the
 * closers to append. Anything after the cut — the item that was being written —
 * is lost, and nothing is invented to replace it. Null when not even one
 * element completed.
 */
export function salvageTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let cut: { at: number; open: string[] } | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      // An object just closed and we are back inside an array: one finished item.
      if (ch === '}' && stack[stack.length - 1] === '[') cut = { at: i + 1, open: [...stack] };
    }
  }

  if (stack.length === 0) return text;   // not truncated after all
  if (cut === null) return null;
  const closers = cut.open.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  return text.slice(0, cut.at) + closers;
}

export const EVIDENCE_LABEL: Record<ClaimEvidence, string> = {
  'independent':     'unabhängig belegt',
  'management-only': 'nur Management-Aussage',
  'opinion':         'bisher nur Meinung',
  'contradicted':    'widerlegt',
};

/**
 * A claim with its argument indented beneath it. A row from before the
 * argument fields existed renders as the one line it always was.
 */
function claimLines(c: PerplexityClaim): string {
  const by = c.proponents ? ` (${c.proponents})` : '';
  const head = `- **${c.claim}**${by} — ${EVIDENCE_LABEL[c.evidence]}`;
  const parts: [string, string | null | undefined][] = [
    ['Wirkung', c.mechanism], ['Einsatz', c.stake], ['Beleg', c.detail],
    ['Dagegen', c.counter], ['Entscheidet', c.settles],
  ];
  if (!c.mechanism && !c.stake && !c.counter && !c.settles) return c.detail ? `${head}: ${c.detail}` : head;
  return [head, ...parts.filter(([, v]) => v).map(([k, v]) => `  - _${k}:_ ${v}`)].join('\n');
}

function findingLine(f: PerplexityFinding): string {
  const line = `- ${f.date ?? 'undatiert'} · ${f.independent ? 'unabhängig' : 'Unternehmensquelle'} — ${f.what}`;
  return f.impact ? `${line}\n  - _Folge:_ ${f.impact}` : line;
}

function debateLine(d: PerplexityDebate): string {
  const settles = d.settles ? `\n  - _Entscheidet:_ ${d.settles}${d.when ? ` (${d.when})` : ''}` : '';
  return `- **${d.question}** ${d.why}${settles}`;
}

function kpiLine(k: PerplexityKpi): string {
  const series = k.values.map((v) => `${v.period}: ${v.value}`).join(' → ');
  return `- **${k.name}** — ${series}${k.read ? `\n  - ${k.read}` : ''}`;
}

function catalystLine(c: PerplexityCatalyst): string {
  return `- ${c.date ?? 'ohne Datum'} — **${c.event}**${c.watch ? `: ${c.watch}` : ''}`;
}

/** The findings as the markdown the UI renders and the narrative stage reads. */
export function renderFindings(f: PerplexityFindings): string {
  const section = (title: string, lines: string[], empty: string) =>
    `**${title}**\n\n${lines.length ? lines.join('\n') : `_${empty}_`}`;
  // A list a row's brief never asked for is left out: saying "none found" for
  // it would be a false statement.
  const asked = <T>(list: T[] | undefined, render: () => string) => (list ? [render()] : []);
  return [
    ...asked(f.debate, () => section('Kerndebatte', f.debate!.map(debateLine), 'Keine offene Kernfrage gefunden.')),
    section('Ereignisse', f.events.map(findingLine), 'Keine Ereignisse, die den Ausblick verändern.'),
    ...asked(f.kpis, () => section('Operative Kennzahlen', f.kpis!.map(kpiLine), 'Keine berichteten Kennzahlen jenseits der Abschlüsse gefunden.')),
    section('Belege gegen die Bullen-These', f.bearEvidence.map(findingLine),
      'Keine spezifischen Gegenbelege gefunden — das ist eine Aussage, keine Lücke.'),
    section('Bullen-Thesen, geprüft', f.bullClaims.map(claimLines), 'Keine Bullen-Thesen im Umlauf gefunden.'),
    ...asked(f.bearClaims, () => section('Bären-Thesen, geprüft', f.bearClaims!.map(claimLines), 'Keine Bären-Thesen im Umlauf gefunden.')),
    ...asked(f.catalysts, () => section('Termine', f.catalysts!.map(catalystLine), 'Keine datierten Termine gefunden.')),
  ].join('\n\n');
}

interface PplxResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  citations?: string[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number;
    citation_tokens?: number; num_search_queries?: number;
    cost?: { total_cost?: number };
  };
}

export async function fetchPerplexity(
  ticker: string,
  companyName: string,
  apiKey: string,
  model: PerplexityModelId = DEFAULT_PERPLEXITY_MODEL,
): Promise<PerplexityContext> {
  logger.step(`Fetching Perplexity AI context (${model})...`);
  const params = MODEL_PARAMS[model];
  const { system, user } = researchPrompt(ticker, companyName);

  const request = () => fetch(PPLX_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ],
      ...API_PARAMS,
      ...(params.max_tokens ? { max_tokens: params.max_tokens } : {}),
      ...(params.stream ? { stream: true } : {}),
      ...params.extra,
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  // The rate limit is per minute and counts requests, so two briefs started
  // together can trip it. A 429 has not been billed; waiting it out is free.
  let res = await request();
  for (let attempt = 1; res.status === 429 && attempt <= 3; attempt++) {
    logger.warn(`Perplexity rate limit — retrying in ${attempt * 20}s`);
    await new Promise((r) => setTimeout(r, attempt * 20_000));
    res = await request();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Perplexity API error ${res.status}: ${body}`);
  }

  const json = params.stream
    ? await readStream(res)
    : await res.json().catch(() => null) as PplxResponse | null;
  const raw       = json?.choices?.[0]?.message?.content ?? '';
  if (json?.choices?.[0]?.finish_reason === 'length') {
    logger.warn(`Perplexity hit its token ceiling (${params.max_tokens ?? 'model default'}) — keeping the items that finished`);
  }
  const citations = json?.citations ?? [];
  const costUsd = json?.usage?.cost?.total_cost;

  // A parsed answer is never a refusal, even with every list empty — "nothing
  // found" is the finding. Only free text falls back to the refusal heuristics.
  const findings = parseFindings(raw);
  let synthesis: string;
  if (findings) {
    synthesis = renderFindings(findings);
  } else {
    synthesis = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/\[\d+\]/g, '').replace(/  +/g, ' ').trim();
    if (looksLikeRefusal(synthesis)) {
      throw new Error('Perplexity returned a meta-refusal (no usable research) — skipping section');
    }
  }

  logger.success(`Perplexity context fetched${findings
    ? ` — ${findings.events.length} events, ${findings.bearEvidence.length} bear items, `
      + `${findings.bullClaims.length} bull and ${findings.bearClaims?.length ?? 0} bear claims`
    : ' (unstructured)'}${costUsd !== undefined ? `, $${costUsd.toFixed(3)}` : ''}`);
  return {
    model, synthesis, citations, fetchedAt: new Date().toISOString(),
    ...(findings ? { findings } : {}),
    promptHash: PERPLEXITY_PROMPT_HASH,
    ...(costUsd !== undefined ? { costUsd } : {}),
    usage: json?.usage,
    finishReason: json?.choices?.[0]?.finish_reason,
    raw,
  };
}

/**
 * Detect responses where Perplexity refuses the task and returns meta-commentary
 * (e.g. "I cannot provide…", "consult Bloomberg Terminal…") instead of research.
 * These are useless in the report — better to drop the whole section.
 */
function looksLikeRefusal(text: string): boolean {
  if (text.length < 200) return true;
  const lower = text.toLowerCase();
  const refusalCues = [
    "i cannot provide",
    "i can't provide",
    "i'm unable to",
    "i am unable to",
    "cannot ethically",
    "insufficient data",
    "do not contain substantive",
    "consult bloomberg",
    "consult factset",
    "consult morningstar",
    "i suggest consulting",
    "unable to construct",
  ];
  let hits = 0;
  for (const cue of refusalCues) if (lower.includes(cue)) hits++;
  return hits >= 2;
}
