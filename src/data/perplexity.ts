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
  'Be precise, cite specific facts, and avoid generic filler.';

// {date} is a placeholder for the hash — replaced at runtime, not part of cache key
const PROMPT_TEMPLATE =
  `Today is {date}. Provide an investment research summary for {company} ({ticker}) using independent financial ` +
  `news sources, analyst reports, and earnings call transcripts. Do not rely on the company's own press releases or website.\n\n` +
  `Rules: If you cannot find substantive, specific information for a section, omit that section completely — ` +
  `do not write the heading, do not write placeholder text like "no information available".\n\n` +
  `**Recent Developments** (last 90 days from today): significant business events, product launches, M&A, partnerships, ` +
  `strategic shifts and their likely revenue impact.\n\n` +
  `**Earnings Call Highlights**: key takeaways from the most recent earnings call — prioritize any call from the last 60 days. ` +
  `Cover management guidance, tone, metrics highlighted or downplayed, and notable changes versus prior quarters.\n\n` +
  `**Competitive Position**: top 2-3 competitors by name, how {company}'s market position has shifted ` +
  `in the last 12 months, most credible emerging threats.\n\n` +
  `**Business Risks**: operational, competitive, and macro risks most relevant to {company}'s business model right now.\n\n` +
  `**Regulatory & Legal Risks**: active investigations, material litigation, pending legislation. ` +
  `Omit entirely if nothing material.\n\n` +
  `**Analyst Targets**: most recent sell-side price targets and ratings available (firm, target, rating, date). ` +
  `Note any significant consensus shifts in the last 60 days — targets raised or cut. ` +
  `Include Morningstar or Simply Wall St fair value if available.\n\n` +
  `**Bull Case**: a paragraph on the strongest investment arguments for {company} right now.\n\n` +
  `**Bear Case**: a paragraph on the most credible reasons to avoid or underweight {company}. ` +
  `Use only substantive negative evidence — never infer risk from absence of positive news.\n\n` +
  `Be specific: names, figures, dates.`;

const API_PARAMS = { max_tokens: 2000, temperature: 0.2, search_recency_filter: 'month' };

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

  const today = new Date().toISOString().slice(0, 10);
  const prompt = PROMPT_TEMPLATE
    .replace('{date}', today)
    .replaceAll('{company}', companyName)
    .replaceAll('{ticker}', ticker);

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

  logger.success('Perplexity context fetched');
  return { model, synthesis, citations, fetchedAt: new Date().toISOString() };
}
