/**
 * Was die neuen Quellengewichte am Gewicht der Narrative-Stufe ändern, für jede Aktie der
 * Beobachtungsliste, ohne Modell-Call: aus den in der Produktion gespeicherten Dokumenten und dem
 * jüngsten Urteil (Übereinstimmung der Säulen, Spanne der Lesungen).
 *
 *   alt: bis 10.10.2026 — Firmendossier 0,5 pauschal, Sektoren 0,1, Brief und Tiefenrecherche
 *        zusammen als das bessere von beiden bis 0,3, mit distill
 *   neu: `narrativeMaterial` wie gebaut, ohne distill (`scoring.distill` aus)
 *
 *   npx tsx measurements/quellen/gewichte.ts
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

loadEnv({ path: resolve(process.cwd(), '../../../.env') });
process.env.DATABASE_URL = 'postgres://niemand@127.0.0.1:1/keine';

const { narrativeMaterial } = await import('../../src/score-service.js');
const { NARRATIVE_MAX_WEIGHT, NARRATIVE_SPREAD_LIMIT, FACTOR_WEIGHT_FLOOR } = await import('../../src/analysis/score.js');

const API = 'https://stockcli.troop.at';
const DEEP_MAX_AGE_MS = 60 * 86_400_000;
const get = async (path: string) => (await fetch(`${API}${path}`)).json() as Promise<any>;

function recency(ages: number[]): number {
  if (ages.length === 0) return 0.7;
  const a = Math.min(...ages);
  return a <= 7 ? 1 : a <= 21 ? 0.85 : a <= 60 ? 0.65 : 0.45;
}
const age = (iso?: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 86_400_000 : null);

/** Die Gewichtung bis zum 10.10.2026, nachgebaut. */
function oldConfidence(distill: any, pplx: any, deep: any): number {
  let w = 0;
  const company = distill?.company;
  if (company?.content?.trim()) w += 0.5;
  else if ((company?.insights?.items?.length ?? 0) > 0) w += 0.3;
  if ((distill?.sectors ?? []).some((b: any) => b.content?.trim() || (b.insights?.items?.length ?? 0) > 0)) w += 0.1;
  const indep = (f: any) => f.events.filter((e: any) => e.independent).length
    + f.bearEvidence.filter((e: any) => e.independent).length
    + f.bullClaims.filter((c: any) => c.evidence !== 'management-only').length;
  const briefs = [pplx, deep].filter((p) => p?.synthesis?.trim());
  if (briefs.length) w += Math.max(...briefs.map((p) => (p.findings ? 0.3 * Math.min(1, indep(p.findings) / 6) : 0.3)));
  const ages = [age(company?.periodEnd), age(pplx?.fetchedAt), age(deep?.fetchedAt)].filter((a): a is number => a !== null);
  return Math.min(1, w) * recency(ages);
}

const share = (conf: number, agreement: number, spread: number | null) => {
  const c = conf * (spread === null ? 1 : 1 - Math.min(spread, NARRATIVE_SPREAD_LIMIT) / (2 * NARRATIVE_SPREAD_LIMIT));
  const nw = Math.min(1, c) * NARRATIVE_MAX_WEIGHT;
  const fw = FACTOR_WEIGHT_FLOOR + (1 - FACTOR_WEIGHT_FLOOR) * agreement;
  return nw / (fw + nw);
};

const symbols: string[] = (await get('/api/overview')).rows.map((r: any) => r.symbol);
const rows: { s: string; old: number; neu: number; deep: boolean }[] = [];
for (const s of symbols) {
  const sym = encodeURIComponent(s);
  const [verdict, distill, pp] = await Promise.all([
    get(`/api/stocks/${sym}/documents/verdict?limit=1`),
    get(`/api/stocks/${sym}/documents/distill?limit=1`),
    get(`/api/stocks/${sym}/documents/perplexity?limit=40`),
  ]);
  const card = verdict.documents?.[0]?.data?.scoreCard;
  if (!card?.factor) continue;
  const pplx = (pp.documents as any[]).find((d) => d.variant === 'sonar-pro')?.data ?? null;
  const deepDoc = (pp.documents as any[]).find((d) => /deep/i.test(d.variant));
  const deep = deepDoc && Date.now() - new Date(deepDoc.producedAt).getTime() < DEEP_MAX_AGE_MS ? deepDoc.data : null;
  const d = distill.documents?.[0]?.data ?? null;
  const spread = card.narrative?.spread ?? null;
  rows.push({
    s,
    old: share(oldConfidence(d, pplx, deep), card.factor.agreement, spread),
    neu: share(narrativeMaterial(null, pplx, undefined, deep).confidence, card.factor.agreement, spread),
    deep: !!deep,
  });
}

const med = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : NaN; };
const pct = (x: number) => `${(100 * x).toFixed(0)} %`;
console.log(`Aktien: ${rows.length}`);
console.log(`Anteil der Narrative-Stufe am Gesamturteil, Median: alt ${pct(med(rows.map((r) => r.old)))}, neu ${pct(med(rows.map((r) => r.neu)))}`);
console.log(`  mit Tiefenrecherche (${rows.filter((r) => r.deep).length}): alt ${pct(med(rows.filter((r) => r.deep).map((r) => r.old)))}, neu ${pct(med(rows.filter((r) => r.deep).map((r) => r.neu)))}`);
for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 1]]) {
  console.log(`  Anteil ${pct(lo)}–${pct(hi)}: alt ${rows.filter((r) => r.old >= lo && r.old < hi).length}, neu ${rows.filter((r) => r.neu >= lo && r.neu < hi).length}`);
}
