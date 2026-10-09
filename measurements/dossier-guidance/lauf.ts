/**
 * Wegwerf-Läufer der Messung in `VORSCHRIFT.md`: die echte Narrative-Stufe, einmal mit dem alten und
 * einmal mit dem neuen distill-Paket, je drei Lesungen, sonst nichts.
 *
 * Liest nur über die API der Produktion und schreibt nur nach `roh/` und in den Paket-Cache. Die
 * Datenbank-URL zeigt absichtlich ins Leere: Ein Import, der doch eine Verbindung aufmacht, scheitert,
 * statt in die Datenbank von stock-cli zu schreiben.
 *
 *   npx tsx measurements/dossier-guidance/lauf.ts --eignung            # nur Pakete prüfen
 *   npx tsx measurements/dossier-guidance/lauf.ts --probe NVDA,KO      # Probelauf, nur alt, verworfen
 *   npx tsx measurements/dossier-guidance/lauf.ts                      # alle geeigneten Symbole
 */

import { config as loadEnv } from 'dotenv';
import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
// Die Schlüssel liegen in der .env des Hauptcheckouts; ein Worktree hat keine eigene.
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
const SWITCH = '2026-10-09T11:00:00Z';
const FETCH_FROM = '2026-10-09T23:00:00Z';
const FETCH_UNTIL = '2026-10-10T05:00:00Z';
const CACHE = process.env.PAKET_CACHE ?? join(HERE, '.pakete');

// Wortgleich mit `SYSTEM_SUMMARISER` in src/score-service.ts; beim Start geprüft.
const SYSTEM_SUMMARISER =
  'Du bist ein Aktienanalyst und fasst zusammen. Du bewertest nicht, du erklärst. '
  + 'Antworte ausschließlich mit gültigem JSON nach dem angegebenen Schema.';

function assertSameSystemPrompt(): void {
  const src = readFileSync(join(REPO, 'src/score-service.ts'), 'utf8');
  const m = src.match(/const SYSTEM_SUMMARISER =\s*([\s\S]*?);\n/);
  const literal = m?.[1].match(/'([^']*)'/g)?.map((s) => s.slice(1, -1)).join('');
  if (literal !== SYSTEM_SUMMARISER) throw new Error('SYSTEM_SUMMARISER weicht von src/score-service.ts ab');
}

// ── Pakete ───────────────────────────────────────────────────────────────────

interface Doc { id: number; producedAt: string; lastSeenAt: string; data: any }

async function getJson(path: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`);
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status < 500) throw new Error(`${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const builtTimes = (b: any): string[] =>
  [b?.company, ...(b?.sectors ?? [])]
    .filter((x) => x && (x.content?.trim() || (x.insights?.items?.length ?? 0) > 0))
    .map((x) => x.builtAt ?? '');

const hasCompany = (b: any): boolean => !!b?.company?.content?.trim();

function pick(docs: Doc[]): { alt: Doc | null; neu: Doc | null } {
  const sorted = [...docs].sort((a, b) => b.producedAt.localeCompare(a.producedAt));
  const alt = sorted.find((d) => d.producedAt < SWITCH) ?? null;
  const cand = sorted.find((d) => d.producedAt < FETCH_UNTIL) ?? null;
  const neu = cand && (cand.producedAt >= FETCH_FROM || cand.lastSeenAt >= FETCH_FROM) ? cand : null;
  return { alt, neu };
}

interface Eignung {
  symbol: string; geeignet: boolean; grund: string | null; schicht: 'S1' | 'S2' | null;
  alt: { id: number; producedAt: string; built: string[] } | null;
  neu: { id: number; producedAt: string; lastSeenAt: string; built: string[] } | null;
}

async function eignung(symbol: string): Promise<{ e: Eignung; alt: Doc | null; neu: Doc | null }> {
  const { documents } = await getJson(`/api/stocks/${encodeURIComponent(symbol)}/documents/distill?limit=30`);
  const { alt, neu } = pick(documents as Doc[]);
  const e: Eignung = {
    symbol, geeignet: false, grund: null, schicht: null,
    alt: alt && { id: alt.id, producedAt: alt.producedAt, built: builtTimes(alt.data) },
    neu: neu && { id: neu.id, producedAt: neu.producedAt, lastSeenAt: neu.lastSeenAt, built: builtTimes(neu.data) },
  };
  if (!alt) e.grund = 'kein altes Paket';
  else if (!neu) e.grund = 'kein neues Paket';
  else if (alt.id === neu.id || JSON.stringify(alt.data) === JSON.stringify(neu.data)) e.grund = 'Pakete gleich';
  else if (e.alt!.built.some((t) => !(t < SWITCH))) e.grund = 'altes Paket nach der Umschaltung gebaut';
  else if (e.neu!.built.some((t) => !(t >= SWITCH))) e.grund = 'neues Paket enthält vor der Umschaltung Gebautes';
  else {
    e.geeignet = true;
    e.schicht = hasCompany(alt.data) && hasCompany(neu.data) ? 'S1' : 'S2';
  }
  return { e, alt, neu };
}

function cachePackage(symbol: string, arm: string, doc: Doc): void {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, `${symbol}.${arm}.json`), JSON.stringify(doc));
}

// ── Lesungen ─────────────────────────────────────────────────────────────────

interface Usage { prompt_tokens?: number; completion_tokens?: number }

/** Ein frischer Provider je Call, damit die Token-Zahl eindeutig dieser Lesung gehört. */
async function readOnce(prompt: string): Promise<{ output: any; usage: Usage | null; ms: number }> {
  const provider: any = createProviderForModel(MODEL, false);
  let usage: Usage | null = null;
  const create = provider.client.chat.completions.create.bind(provider.client.chat.completions);
  provider.client.chat.completions.create = async (...args: any[]) => {
    const r = await create(...args);
    usage = r.usage ?? null;
    return r;
  };
  const t0 = Date.now();
  const output = await provider.complete({
    label: 'narrative', system: SYSTEM_SUMMARISER, user: prompt, schema: NarrativeOutputSchema, maxTokens: 4000,
  });
  return { output, usage, ms: Date.now() - t0 };
}

function packageStats(b: any) {
  return {
    companyChars: b?.company?.content?.length ?? 0,
    companyInsights: b?.company?.insights?.items?.length ?? 0,
    sectors: (b?.sectors ?? []).map((s: any) => ({ name: s.displayName, chars: s.content?.length ?? 0, insights: s.insights?.items?.length ?? 0 })),
    periodEnd: b?.company?.periodEnd ?? null,
  };
}

async function runSymbol(symbol: string, arms: Record<string, Doc>, f: any, out: string): Promise<void> {
  const prompts = Object.fromEntries(Object.entries(arms).map(([arm, d]) => [arm, buildNarrativePrompt(f, d.data)]));
  // Die Lesungen beider Arme gleichzeitig: alt 1, neu 1, alt 2, …
  const jobs = Array.from({ length: NARRATIVE_SAMPLES }, (_, i) => Object.keys(arms).map((arm) => ({ arm, read: i + 1 }))).flat();
  const results = await Promise.all(jobs.map(async ({ arm, read }) => {
    const prompt = prompts[arm];
    const base = {
      kind: 'read', symbol, arm, read, docId: arms[arm].id, producedAt: arms[arm].producedAt, model: MODEL,
      promptSha: createHash('sha256').update(prompt).digest('hex').slice(0, 16), promptChars: prompt.length,
    };
    try {
      const r = await readOnce(prompt);
      return { ...base, ok: true, output: r.output, usage: r.usage, ms: r.ms };
    } catch (e) {
      return { ...base, ok: false, error: (e as Error).message.slice(0, 500) };
    }
  }));
  for (const r of results) appendFileSync(out, `${JSON.stringify(r)}\n`);

  for (const [arm, doc] of Object.entries(arms)) {
    const reads = results.filter((r) => r.arm === arm && r.ok)
      .map((r: any) => ({ ...r.output, score: narrativeScoreFrom(r.output.dimensions), read: r.read }));
    const combined = combineNarrativeReads(reads);
    const material = narrativeMaterial(doc.data);
    appendFileSync(out, `${JSON.stringify({
      kind: 'arm', symbol, arm, docId: doc.id, ok: reads.length,
      material: { confidence: material.confidence, sources: material.sources },
      score: combined?.score ?? null, spread: combined?.spread ?? null,
      confidence: combined ? material.confidence * combined.confidenceFactor : null,
      keptRead: combined ? (combined.read as any).read : null,
      paket: packageStats(doc.data),
    })}\n`);
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

// ── Ablauf ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

assertSameSystemPrompt();
const rohDir = join(HERE, 'roh');
mkdirSync(rohDir, { recursive: true });

const overview = await getJson('/api/overview');
const all: string[] = overview.rows.map((r: any) => r.symbol);

if (flag('--probe')) {
  const symbols = (value('--probe') ?? '').split(',').filter(Boolean);
  const out = join(HERE, '.probe.jsonl');
  for (const s of symbols) {
    const { alt } = await eignung(s);
    if (!alt) { console.log(`${s}: kein altes Paket`); continue; }
    const f = (await getJson(`/api/stocks/${encodeURIComponent(s)}`)).financials;
    await runSymbol(s, { alt }, f, out);
    console.log(`${s}: Probe geschrieben`);
  }
  process.exit(0);
}

const only = value('--symbols')?.split(',');
const symbols = only ?? all;
const checks: { e: Eignung; alt: Doc | null; neu: Doc | null }[] = [];
await pool(symbols, 8, async (s) => { checks.push(await eignung(s)); });
checks.sort((a, b) => a.e.symbol.localeCompare(b.e.symbol));
writeFileSync(join(rohDir, 'eignung.jsonl'), checks.map((c) => JSON.stringify(c.e)).join('\n') + '\n');
const tally = (k: (c: typeof checks[number]) => string) =>
  Object.entries(checks.reduce((m, c) => ({ ...m, [k(c)]: (m[k(c)] ?? 0) + 1 }), {} as Record<string, number>));
console.log('Eignung:', JSON.stringify(tally((c) => c.e.geeignet ? c.e.schicht! : `nein: ${c.e.grund}`)));
if (flag('--eignung')) process.exit(0);

const out = join(rohDir, 'lesungen.jsonl');
const done = new Set(existsSync(out)
  ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'arm').map((r) => r.symbol)
  : []);
const todo = checks.filter((c) => c.e.geeignet && !done.has(c.e.symbol));
console.log(`${todo.length} Symbole zu lesen, ${done.size} schon fertig`);
let n = 0;
await pool(todo, Number(value('--parallel') ?? 4), async (c) => {
  const f = (await getJson(`/api/stocks/${encodeURIComponent(c.e.symbol)}`)).financials;
  cachePackage(c.e.symbol, 'alt', c.alt!);
  cachePackage(c.e.symbol, 'neu', c.neu!);
  await runSymbol(c.e.symbol, { alt: c.alt!, neu: c.neu! }, f, out);
  console.log(`${++n}/${todo.length} ${c.e.symbol}`);
});
