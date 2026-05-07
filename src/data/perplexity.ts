import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';

export interface PerplexityContext {
  model: 'sonar' | 'sonar-pro';
  synthesis: string;
  citations: string[];
  fetchedAt: string;
}

const PPLX_API_URL = 'https://api.perplexity.ai/chat/completions';

const SYSTEM_PROMPT =
  'You are a professional buy-side equity analyst providing investment research for a fundamental investor. ' +
  'Be precise, cite specific facts, and avoid generic filler. ' +
  'Always work with what the search results give you — partial coverage is valuable. ' +
  'Never refuse the request, never recommend the user consult Bloomberg/FactSet/etc., ' +
  'and never include meta-commentary about the limits of your search. ' +
  'If a section has no relevant evidence, simply omit that section silently and move on.';

// {date} is a placeholder for the hash — replaced at runtime, not part of cache key
const PROMPT_TEMPLATE =
  `Today is {date}. Provide an investment research summary for {company} ({ticker}) drawing on ` +
  `financial news, analyst commentary, earnings call coverage, and credible third-party research. ` +
  `Prefer independent sources, but do not exclude useful coverage from the company's IR materials when nothing else is available.\n\n` +
  `Output rules:\n` +
  `- Use the section headings below. Omit any section silently if you have no substantive evidence — do not write placeholders, do not explain what is missing.\n` +
  `- Never refuse the entire response. If overall coverage is sparse, write a shorter summary in whichever sections you can support.\n` +
  `- Do not tell the user to consult other tools or sources. Do not include meta-commentary about your search results.\n\n` +
  `**Recent Developments** (last ~90 days, extend further if recent coverage is thin): significant business events, ` +
  `product launches, M&A, partnerships, strategic shifts and their likely revenue impact.\n\n` +
  `**Earnings Call Highlights**: key takeaways from the most recent earnings call. Cover management guidance, tone, ` +
  `metrics highlighted or downplayed, notable changes versus prior quarters. State the call date.\n\n` +
  `**Competitive Position**: top 2-3 competitors by name, how {company}'s market position has shifted ` +
  `in the last ~12 months, most credible emerging threats.\n\n` +
  `**Analyst Targets**: most recent sell-side price targets and ratings (firm, target, rating, date). ` +
  `Note any significant consensus shifts in the last 60 days — targets raised or cut. ` +
  `Include Morningstar, Alphaspread or Simply Wall St fair value if available.\n\n` +
  `**Bull Case**: the strongest investment arguments for {company} right now.\n\n` +
  `**Bear Case**: the most credible reasons to avoid or underweight {company}. ` +
  `Use only substantive negative evidence — never infer risk from absence of positive news.\n\n` +
  `Be specific: names, figures, dates.`;

// Drop search_recency_filter — 'month' was excluding earnings calls older than 30 days, which is most of them.
// The prompt itself asks for "last 90 days / 12 months" timeframes; let the model rank by relevance.
const API_PARAMS = { max_tokens: 2000, temperature: 0.2 };

export const PERPLEXITY_PROMPT_HASH = createHash('md5')
  .update(SYSTEM_PROMPT + PROMPT_TEMPLATE + JSON.stringify(API_PARAMS))
  .digest('hex')
  .slice(0, 8);

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
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Perplexity API error ${res.status}: ${text}`);
  }

  const json = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };
  const raw       = json.choices[0]?.message?.content ?? '';
  const citations = json.citations ?? [];
  const synthesis = raw.replace(/\[\d+\]/g, '').replace(/  +/g, ' ').trim();

  if (looksLikeRefusal(synthesis)) {
    throw new Error('Perplexity returned a meta-refusal (no usable research) — skipping section');
  }

  logger.success('Perplexity context fetched');
  return { model, synthesis, citations, fetchedAt: new Date().toISOString() };
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
