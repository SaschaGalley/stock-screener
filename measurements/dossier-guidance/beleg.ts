/**
 * Belegprüfung der Messung in `VORSCHRIFT.md`, Metrik 5: Steht jede These und jedes Ereignis der
 * Narrative-Stufe in dem Paket, das sie gelesen hat?
 *
 * Ein Call je Symbol und Arm, nur Schicht S1, auf einem Modell einer anderen Familie als die Stufe.
 * Das Material ist der distill-Abschnitt genau so, wie der Prompt ihn gerendert hat. Liest `roh/` und
 * den Paket-Cache, schreibt nur nach `beleg/`.
 *
 *   npx tsx measurements/dossier-guidance/beleg.ts [--parallel 4]
 */

import { config as loadEnv } from 'dotenv';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
loadEnv({ path: process.env.STOCKCLI_ENV ?? resolve(REPO, '.env') });
loadEnv({ path: resolve(REPO, '../../../.env') });
process.env.DATABASE_URL = 'postgres://niemand@127.0.0.1:1/keine';

const { distillDossierSection } = await import('../../src/output/prompt.js');
const { createProviderForModel } = await import('../../src/providers/factory.js');

const JUDGE = 'claude-sonnet-5-5';
const CACHE = process.env.PAKET_CACHE ?? join(HERE, '.pakete');
const API = process.env.STOCKCLI_API ?? 'https://stockcli.troop.at';

const SYSTEM = 'Du prüfst Zusammenfassungen gegen ihr Quellenmaterial. Du bist genau und streng, '
  + 'aber du verlangst keinen Wortlaut. Antworte ausschließlich mit gültigem JSON nach dem angegebenen Schema.';

const VerdictSchema = z.object({
  urteile: z.array(z.object({
    id:     z.string(),
    urteil: z.enum(['belegt', 'teilweise', 'nicht belegt']),
    fehlt:  z.string().default(''),
  })),
});

interface Item { id: string; kind: 'bull' | 'bear' | 'event'; read: number; text: string }

function prompt(material: string, items: { id: string; text: string }[]): string {
  return `## Material

Das hat der Zusammenfasser bekommen, und nichts sonst: ein distill-Paket mit dem Firmendossier, den
Dossiers der Sektoren und einzelnen rohen Aussagen.

${material}

---

## Aussagen, die er daraus gemacht hat

${items.map((i) => `[${i.id}] ${i.text}`).join('\n')}

---

**Deine Aufgabe:** Prüfe jede Aussage gegen das Material oben. Das Material ist meist englisch, die
Aussagen sind deutsch; Übersetzung, Kürzung und Umformulierung sind erlaubt.

- **belegt** — Kern und alle Einzelheiten (Zahlen, Daten, Namen, Urheber, Richtung) stehen im Material.
- **teilweise** — der Kern steht im Material, aber mindestens eine Einzelheit nicht oder anders: eine
  falsche Zahl, ein falsches Datum, ein falscher Urheber, eine Zuspitzung über das Material hinaus, oder
  eine Aussage aus einem Sektordossier, die als Aussage über das Unternehmen formuliert ist.
- **nicht belegt** — der Kern steht nicht im Material, oder das Material sagt das Gegenteil.

Eine Folgerung, die die Aussage aus dem Material zieht („spricht für …“, „belastet …“), ist keine
Einzelheit; geprüft wird, ob die Tatsachen und die wiedergegebenen Meinungen dastehen. In \`fehlt\`
nennst du bei *teilweise* und *nicht belegt* in einem Halbsatz, was nicht im Material steht.

Antworte als JSON, mit einem Urteil für jede id:
{ "urteile": [ { "id": "…", "urteil": "belegt" | "teilweise" | "nicht belegt", "fehlt": "…" } ] }`;
}

async function packageFor(symbol: string, arm: string, docId: number): Promise<any> {
  const file = join(CACHE, `${symbol}.${arm}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).data;
  const res = await fetch(`${API}/api/stocks/${encodeURIComponent(symbol)}/documents/distill?limit=50`);
  const doc = ((await res.json()).documents as any[]).find((d) => d.id === docId);
  if (!doc) throw new Error(`${symbol} ${arm}: Dokument ${docId} nicht gefunden`);
  return doc.data;
}

const args = process.argv.slice(2);
const parallel = Number(args[args.indexOf('--parallel') + 1] || 4);
const rows = readFileSync(join(HERE, 'roh/lesungen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const eignung = new Map(readFileSync(join(HERE, 'roh/eignung.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).map((e) => [e.symbol, e]));

mkdirSync(join(HERE, 'beleg'), { recursive: true });
const out = join(HERE, 'beleg/urteile.jsonl');
const done = new Set(existsSync(out)
  ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ok).map((r) => `${r.symbol}.${r.arm}`)
  : []);

const cells = rows.filter((r) => r.kind === 'arm' && eignung.get(r.symbol)?.schicht === 'S1' && !done.has(`${r.symbol}.${r.arm}`));
console.log(`${cells.length} Zellen zu prüfen`);

let n = 0;
const queue = [...cells];
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let cell = queue.shift(); cell; cell = queue.shift()) {
    const reads = rows.filter((r) => r.kind === 'read' && r.ok && r.symbol === cell.symbol && r.arm === cell.arm);
    const items: Item[] = reads.flatMap((r) => [
      ...(r.output.theses?.bull ?? []).map((t: string, i: number) => ({ id: `r${r.read}-bull${i + 1}`, kind: 'bull' as const, read: r.read, text: t })),
      ...(r.output.theses?.bear ?? []).map((t: string, i: number) => ({ id: `r${r.read}-bear${i + 1}`, kind: 'bear' as const, read: r.read, text: t })),
      ...(r.output.events ?? []).map((t: string, i: number) => ({ id: `r${r.read}-ev${i + 1}`, kind: 'event' as const, read: r.read, text: t })),
    ]);
    // Wortgleiche Aussagen mehrerer Lesungen werden einmal geprüft.
    const unique = [...new Map(items.map((i) => [i.text.trim(), i.id])).entries()].map(([text, id]) => ({ id, text }));
    const base = { symbol: cell.symbol, arm: cell.arm, docId: cell.docId, model: JUDGE, items };
    try {
      if (unique.length === 0) {
        appendFileSync(out, `${JSON.stringify({ ...base, ok: true, urteile: [] })}\n`);
        continue;
      }
      const material = distillDossierSection(cell.symbol, await packageFor(cell.symbol, cell.arm, cell.docId));
      const judge = createProviderForModel(JUDGE, false);
      const res = await judge.complete({ label: 'beleg', system: SYSTEM, user: prompt(material, unique), schema: VerdictSchema, maxTokens: 8000 });
      const byText = new Map(unique.map((u) => [u.text.trim(), res.urteile.find((v) => v.id === u.id) ?? null]));
      const urteile = items.map((i) => {
        const v = byText.get(i.text.trim());
        return { urteil: v?.urteil ?? null, fehlt: v ? v.fehlt : 'kein Urteil', id: i.id, geprueftAls: v?.id ?? null };
      });
      appendFileSync(out, `${JSON.stringify({ ...base, ok: true, urteile })}\n`);
    } catch (e) {
      appendFileSync(out, `${JSON.stringify({ ...base, ok: false, error: (e as Error).message.slice(0, 500) })}\n`);
    }
    console.log(`${++n}/${cells.length} ${cell.symbol} ${cell.arm}`);
  }
}));
