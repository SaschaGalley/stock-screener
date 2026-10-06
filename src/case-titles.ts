/**
 * Headlines for the bull and bear points stored before points had them.
 *
 * From 7 October the synthesis writes a headline over every thesis and every
 * figure, because five sentences a point read as a wall and the headlines read
 * as the case. The verdicts already stored — most of them flat lists from
 * before the sections — are the text alone, and the page could only guess a
 * headline from a first clause. A cheap model writes them instead, once: it
 * reads each point and names it, it does not judge anything, so the summary
 * tier is enough.
 *
 * The text of a point is never changed; the headline is put beside it. Triggers
 * stay text — they read as conditions under their section's heading — and so
 * does a schema-v3 paragraph, which has no points to head.
 */

import { z } from 'zod';
import type { CasePoint, StoredCase, StoredCases } from './cases.js';

/** Where a point sits in a stored analysis, so its headline goes back to the same place. */
export type Slot =
  | { field: 'bullCase' | 'bearCase'; section: 'theses' | 'figures' | null; index: number }
  | { field: 'keyRisks'; section: null; index: number };

export interface UntitledPoint { slot: Slot; text: string }

/** The sections of a side that carry headlines. */
const HEADED = ['theses', 'figures'] as const;

function untitledOfSide(field: 'bullCase' | 'bearCase', v: StoredCase | undefined): UntitledPoint[] {
  if (v === undefined || v === null || typeof v === 'string') return [];
  if (Array.isArray(v)) {
    return v.flatMap((p, index) => (typeof p === 'string' && p.trim()
      ? [{ slot: { field, section: null, index }, text: p.trim() }] : []));
  }
  return HEADED.flatMap((section) => (v[section] ?? []).flatMap((p, index) => (typeof p === 'string' && p.trim()
    ? [{ slot: { field, section, index }, text: p.trim() }] : [])));
}

/** The points of a stored analysis that should carry a headline and do not. */
export function untitledPoints(a: StoredCases): UntitledPoint[] {
  return [
    ...untitledOfSide('bullCase', a.bullCase),
    ...untitledOfSide('bearCase', a.bearCase),
    ...(a.keyRisks ?? []).flatMap((p, index) => (typeof p === 'string' && p.trim()
      ? [{ slot: { field: 'keyRisks', section: null, index } as Slot, text: p.trim() }] : [])),
  ];
}

/** A headline worth keeping: some words, shorter than the point, not the point itself. */
export function usableTitle(title: string | undefined, text: string): string | null {
  const t = (title ?? '').trim().replace(/^["„“]+|["“”]+$/g, '').replace(/[.:;]+$/, '').trim();
  if (t.length < 4 || t.length > 90 || t.length >= text.length) return null;
  return t;
}

/**
 * The analysis with the headlines put in, `titles[i]` for `points[i]`. A
 * point whose headline came back unusable stays as it was. Returns a copy.
 */
export function withTitles<T extends StoredCases>(a: T, points: UntitledPoint[], titles: (string | undefined)[]): T {
  const out = structuredClone(a);
  points.forEach((p, i) => {
    const title = usableTitle(titles[i], p.text);
    if (!title) return;
    const point: CasePoint = { title, text: p.text };
    const { field, section, index } = p.slot;
    if (field === 'keyRisks') {
      out.keyRisks![index] = point;
      return;
    }
    const side = out[field];
    if (Array.isArray(side)) side[index] = point;
    else if (section && typeof side === 'object') side[section][index] = point;
  });
  return out;
}

export const TitlesSchema = z.object({
  titles: z.array(z.string()).describe('One headline per point, in the order given'),
});

export const TITLES_SYSTEM = `Du schreibst Überschriften für die Argumente einer Aktienanalyse.

Jeder Punkt bekommt eine Überschrift von 3–7 Wörtern: die Aussage selbst als
Schlagzeile, so dass wer nur die Überschriften liest, den Fall schon kennt —
„Kapitalrendite weit über Kapitalkosten", nicht „Rendite" oder „Bewertung".
Auf Deutsch, ohne Punkt am Ende, ohne Anführungszeichen, Zahlen deutsch
geschrieben („36,3 %", „175 Mrd. $"). Nichts hinzufügen, was nicht im Punkt
steht; keine Zahl, die der Punkt nicht nennt.

Antworte nur mit JSON: {"titles": ["…", "…"]} — genau eine Überschrift je Punkt,
in der Reihenfolge der Nummern.`;

/** The user message: the stock, then the points numbered, with the side each argues. */
export function titlesPrompt(symbol: string, points: UntitledPoint[]): string {
  const side = (s: Slot) => (s.field === 'bullCase' ? 'Bull' : 'Bear');
  return [
    `Aktie: ${symbol}`,
    '',
    ...points.map((p, i) => `${i + 1}. (${side(p.slot)}) ${p.text}`),
  ].join('\n');
}
