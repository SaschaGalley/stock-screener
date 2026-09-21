import { createHash } from 'crypto';
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
  source:      string | null;
  independent: boolean;
}

export type BullClaimEvidence = 'independent' | 'management-only' | 'contradicted';

/** A bullish claim in circulation, checked against the evidence. */
export interface PerplexityBullClaim {
  claim:    string;
  evidence: BullClaimEvidence;
  detail:   string;
  source:   string | null;
}

export interface PerplexityFindings {
  events:       PerplexityFinding[];
  bearEvidence: PerplexityFinding[];
  bullClaims:   PerplexityBullClaim[];
}

export interface PerplexityContext {
  model: 'sonar' | 'sonar-pro';
  /** Rendered markdown — what the UI shows and older readers expect. */
  synthesis: string;
  citations: string[];
  fetchedAt: string;
  /** The structured answer, when the model returned one. Absent on old rows. */
  findings?: PerplexityFindings;
  /** Which prompt produced this. A row from another prompt is not a cache hit. */
  promptHash?: string;
}

const PPLX_API_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * The research brief — rewritten around what the rest of the pipeline cannot see.
 *
 * The previous prompt asked for recent developments, earnings highlights, the
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
 * bull case, and has the bull claims in circulation graded against the evidence.
 * On the same stock that produced: a guide raised by $15M on a 150bp beat,
 * federal revenue pulled forward from Q3, a margin beat from deferred marketing
 * spend, and AI usage acknowledged as a gross-margin headwind — each dated and
 * sourced, and two popular bull claims marked contradicted.
 */
const SYSTEM_PROMPT =
  'You are a forensic equity researcher. You report evidence, not opinions, and you are ' +
  'paid to find what the bulls are missing. Every claim carries a date and a source. You ' +
  'never pad a section: an empty list is a valid, useful answer. Never refuse, and never ' +
  'add commentary about your search.';

// {date} is replaced at runtime and is deliberately outside the hash.
const PROMPT_TEMPLATE =
  `Research {company} ({ticker}) as of {date}.

We already hold its price, valuation multiples, financial statements, analyst ratings,
price targets, estimate revisions and insider transactions. Do NOT repeat any of those.
Report only what that data cannot show, from roughly the last 90 days.

1. "events": concrete, dated developments that change the business outlook. Always
   include the most recent earnings call: did guidance go up, down or hold versus the
   prior quarter, and what did management emphasise or avoid? Also: M&A with disclosed
   terms, C-suite departures, regulatory or legal decisions, major customer wins or
   losses, shifts in the product cycle. Product launches, partnership press releases and
   routine insider sales do NOT qualify.

2. "bear_evidence": the strongest SPECIFIC evidence against the bull case — short-seller
   reports, accounting or audit concerns, guidance cuts or misses, customer churn or
   seat/licence reductions, share lost to a named competitor, and above all any structural
   threat to the business model that analysts or industry data have documented (for
   example: AI reducing demand for the product, pricing pressure, a key market saturating).
   Evidence only: never "risks could include", never speculation.

3. "bull_claims": what bulls currently say is driving the stock. For each claim, state
   whether independent evidence supports it, whether it rests on management's own
   statements, or whether the evidence contradicts it.

Prefer independent sources — published analyst research, reputable financial press,
regulatory filings — over the company's own press releases, and label each item.

At most 6 events, 6 bear_evidence items and 5 bull_claims: the strongest, not all of
them. Keep every "what" and "detail" to two sentences.

Return ONLY this JSON:
{
  "events":        [{"date": "YYYY-MM-DD", "what": "...", "source": "url", "independent": true}],
  "bear_evidence": [{"date": "YYYY-MM-DD", "what": "...", "source": "url", "independent": true}],
  "bull_claims":   [{"claim": "...", "evidence": "independent" | "management-only" | "contradicted", "detail": "...", "source": "url"}]
}`;

// High search context: at "low" the same brief found four insider filings and
// nothing else. The request fee rises from $0.006 to $0.014 and the answer
// stops being thin — about five cents a call in all.
const API_PARAMS = {
  // The item caps above keep a typical answer near 2,500 tokens; this is the
  // margin. The first live run without caps ran to 14k characters and was cut
  // off mid-sentence at 3,500.
  max_tokens: 5000,
  temperature: 0.1,
  web_search_options: { search_context_size: 'high' },
};

export const PERPLEXITY_PROMPT_HASH = createHash('md5')
  .update(SYSTEM_PROMPT + PROMPT_TEMPLATE + JSON.stringify(API_PARAMS))
  .digest('hex')
  .slice(0, 8);

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
    source:      optText(o.source),
    independent: o.independent === true || o.independent === 'true',
  };
}

function bullClaim(v: unknown): PerplexityBullClaim | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const claim = text(o.claim);
  if (!claim) return null;
  const raw = text(o.evidence).toLowerCase();
  const evidence: BullClaimEvidence =
    raw.startsWith('contra') ? 'contradicted'
    : raw.startsWith('indep') ? 'independent'
    : 'management-only';
  return { claim, evidence, detail: text(o.detail), source: optText(o.source) };
}

/**
 * The structured answer, or null when there is none to be had.
 *
 * Lenient on shape and strict on substance: a missing list is an empty one, an
 * unknown evidence label reads as the weakest, and an item with no text is
 * dropped. What is never done is inventing a finding the model did not return.
 */
export function parseFindings(raw: string): PerplexityFindings | null {
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
    events:       list(obj.events, finding),
    bearEvidence: list(obj.bear_evidence ?? obj.bearEvidence, finding),
    bullClaims:   list(obj.bull_claims ?? obj.bullClaims, bullClaim),
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

const EVIDENCE_LABEL: Record<BullClaimEvidence, string> = {
  'independent':     'unabhängig belegt',
  'management-only': 'nur Management-Aussage',
  'contradicted':    'widerlegt',
};

function findingLine(f: PerplexityFinding): string {
  return `- ${f.date ?? 'undatiert'} · ${f.independent ? 'unabhängig' : 'Unternehmensquelle'} — ${f.what}`;
}

/** The findings as the markdown the UI renders and the narrative stage reads. */
export function renderFindings(f: PerplexityFindings): string {
  const section = (title: string, lines: string[], empty: string) =>
    `**${title}**\n\n${lines.length ? lines.join('\n') : `_${empty}_`}`;
  return [
    section('Ereignisse', f.events.map(findingLine), 'Keine Ereignisse, die den Ausblick verändern.'),
    section('Belege gegen die Bullen-These', f.bearEvidence.map(findingLine),
      'Keine spezifischen Gegenbelege gefunden — das ist eine Aussage, keine Lücke.'),
    section('Bullen-Thesen, geprüft',
      f.bullClaims.map((c) => `- **${c.claim}** — ${EVIDENCE_LABEL[c.evidence]}${c.detail ? `: ${c.detail}` : ''}`),
      'Keine Bullen-Thesen im Umlauf gefunden.'),
  ].join('\n\n');
}

export async function fetchPerplexity(
  ticker: string,
  companyName: string,
  apiKey: string,
  model: 'sonar' | 'sonar-pro' = 'sonar-pro',
): Promise<PerplexityContext> {
  logger.step(`Fetching Perplexity AI context (${model})...`);

  // Strip Yahoo exchange suffix (ENR.DE → ENR, 0700.HK → 0700) — meaningless for web search
  const searchTicker = ticker.includes('.') ? ticker.split('.')[0] : ticker;
  const today = new Date().toISOString().slice(0, 10);
  const prompt = PROMPT_TEMPLATE
    .replace('{date}', today)
    .replaceAll('{company}', companyName)
    .replaceAll('{ticker}', searchTicker);

  const res = await fetch(PPLX_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
      ...API_PARAMS,
    }),
    // High search context takes around half a minute; 30s was cutting it off.
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Perplexity API error ${res.status}: ${body}`);
  }

  const json = await res.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    citations?: string[];
  } | null;
  const raw       = json?.choices?.[0]?.message?.content ?? '';
  if (json?.choices?.[0]?.finish_reason === 'length') {
    logger.warn(`Perplexity hit max_tokens (${API_PARAMS.max_tokens}) — keeping the items that finished`);
  }
  const citations = json?.citations ?? [];

  // A parsed answer is never a refusal, even with every list empty — "nothing
  // found" is the finding. Only free text falls back to the refusal heuristics.
  const findings = parseFindings(raw);
  let synthesis: string;
  if (findings) {
    synthesis = renderFindings(findings);
  } else {
    synthesis = raw.replace(/\[\d+\]/g, '').replace(/  +/g, ' ').trim();
    if (looksLikeRefusal(synthesis)) {
      throw new Error('Perplexity returned a meta-refusal (no usable research) — skipping section');
    }
  }

  logger.success(`Perplexity context fetched${findings
    ? ` — ${findings.events.length} events, ${findings.bearEvidence.length} bear items, ${findings.bullClaims.length} claims`
    : ' (unstructured)'}`);
  return {
    model, synthesis, citations, fetchedAt: new Date().toISOString(),
    ...(findings ? { findings } : {}),
    promptHash: PERPLEXITY_PROMPT_HASH,
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
