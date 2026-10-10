/**
 * Was trägt welche Quelle? Die echte Narrative-Stufe liest distill, den Perplexity-Brief und die
 * Tiefenrecherche einzeln und in Kombination, je drei Lesungen, sonst nichts.
 *
 * Liest nur über die API der Produktion (das jüngste distill-Paket, den jüngsten sonar-pro-Brief, die
 * jüngste Tiefenrecherche) und schreibt nur nach `roh/`. Die Datenbank-URL zeigt ins Leere wie in
 * `../dossier-guidance/lauf.ts`, dessen Lesemechanik hier wiederkehrt.
 *
 *   npx tsx measurements/quellen/lauf.ts NU ARGX STR.VI ORCL NKE CRWV
 */

import { config as loadEnv } from 'dotenv';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
loadEnv({ path: process.env.STOCKCLI_ENV ?? resolve(REPO, '.env') });
loadEnv({ path: resolve(REPO, '../../../.env') });
process.env.DATABASE_URL = 'postgres://niemand@127.0.0.1:1/keine';

const { buildNarrativePrompt } = await import('../../src/output/prompt.js');
const { NARRATIVE_SAMPLES, combineNarrativeReads, narrativeScoreFrom } = await import('../../src/analysis/score.js');
const { NarrativeOutputSchema } = await import('../../src/types.js');
const { narrativeMaterial } = await import('../../src/score-service.js');
const { createProviderForModel } = await import('../../src/providers/factory.js');

const API = process.env.STOCKCLI_API ?? 'https://stockcli.troop.at';
const MODEL = 'gpt-5.4-mini';
const SYSTEM_SUMMARISER =
  'Du bist ein Aktienanalyst und fasst zusammen. Du bewertest nicht, du erklärst. '
  + 'Antworte ausschließlich mit gültigem JSON nach dem angegebenen Schema.';

{
  const src = readFileSync(join(REPO, 'src/score-service.ts'), 'utf8');
  const literal = src.match(/const SYSTEM_SUMMARISER =\s*([\s\S]*?);\n/)?.[1].match(/'([^']*)'/g)?.map((s) => s.slice(1, -1)).join('');
  if (literal !== SYSTEM_SUMMARISER) throw new Error('SYSTEM_SUMMARISER weicht von src/score-service.ts ab');
}

async function getJson(path: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    try { res = await fetch(`${API}${path}`); } catch (e) { if (attempt >= 6) throw e; }
    if (res?.ok) return res.json();
    if (res && (attempt >= 6 || res.status < 500)) throw new Error(`${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

async function readOnce(prompt: string): Promise<any> {
  const provider: any = createProviderForModel(MODEL, false);
  return provider.complete({ label: 'narrative', system: SYSTEM_SUMMARISER, user: prompt, schema: NarrativeOutputSchema, maxTokens: 4000 });
}

/** D = distill, P = Perplexity-Brief, R = Tiefenrecherche. */
const CONFIGS = ['D', 'P', 'R', 'DP', 'PR', 'DPR'] as const;

const out = join(HERE, 'roh/lesungen.jsonl');
// Ein späterer Lauf für dasselbe Symbol ersetzt in der Auswertung den früheren.
const LAUF = new Date().toISOString();
mkdirSync(join(HERE, 'roh'), { recursive: true });

for (const symbol of process.argv.slice(2)) {
  const sym = encodeURIComponent(symbol);
  const [stock, distillDocs, pplxDocs] = await Promise.all([
    getJson(`/api/stocks/${sym}`),
    getJson(`/api/stocks/${sym}/documents/distill?limit=1`),
    getJson(`/api/stocks/${sym}/documents/perplexity?limit=30`),
  ]);
  const f = stock.financials;
  const src = {
    D: distillDocs.documents[0] ?? null,
    P: (pplxDocs.documents as any[]).find((d) => d.variant === 'sonar-pro') ?? null,
    R: (pplxDocs.documents as any[]).find((d) => /deep/i.test(d.variant)) ?? null,
  };
  const configs = CONFIGS.filter((c) => [...c].every((k) => src[k as 'D' | 'P' | 'R']));
  const jobs = configs.flatMap((c) => Array.from({ length: NARRATIVE_SAMPLES }, (_, i) => ({ c, read: i + 1 })));
  const results = await Promise.all(jobs.map(async ({ c, read }) => {
    const distill = c.includes('D') ? src.D.data : undefined;
    const perplexity = c.includes('P') ? src.P.data : undefined;
    const deep = c.includes('R') ? src.R.data : undefined;
    const prompt = buildNarrativePrompt(f, distill, perplexity, deep);
    try {
      return { c, read, ok: true, output: await readOnce(prompt), promptChars: prompt.length };
    } catch (e) {
      return { c, read, ok: false, error: (e as Error).message.slice(0, 300), promptChars: prompt.length };
    }
  }));
  const docs = Object.fromEntries(Object.entries(src).map(([k, d]) => [k, d && { id: d.id, producedAt: d.producedAt, variant: d.variant }]));
  for (const r of results) appendFileSync(out, `${JSON.stringify({ kind: 'read', lauf: LAUF, symbol, docs, ...r })}\n`);
  for (const c of configs) {
    const reads = results.filter((r) => r.c === c && r.ok).map((r: any) => ({ ...r.output, score: narrativeScoreFrom(r.output.dimensions), read: r.read }));
    const combined = combineNarrativeReads(reads);
    const material = narrativeMaterial(c.includes('D') ? src.D.data : null, c.includes('P') ? src.P.data : null, undefined, c.includes('R') ? src.R.data : null);
    appendFileSync(out, `${JSON.stringify({
      kind: 'config', lauf: LAUF, symbol, c, docs, ok: reads.length,
      score: combined?.score ?? null, spread: combined?.spread ?? null,
      confidence: combined ? material.confidence * combined.confidenceFactor : null,
      material: { confidence: material.confidence, sources: material.sources },
      keptRead: combined ? (combined.read as any).read : null,
    })}\n`);
  }
  console.log(`${symbol}: ${configs.join(' ')}`);
}
