/**
 * The factor score, written out for a reader — human or model.
 *
 * Two renderings of one object, because two consumers need different amounts of
 * it. The **full** card carries every criterion and is what the data summariser
 * gets: it is the complete numeric picture, already reduced from eight thousand
 * tokens of models and ratios to a page of scored lines. The **brief** card
 * carries the pillars and the findings only, and is what the synthesis model
 * gets alongside the two prose summaries — by then the detail has done its job.
 *
 * Both are deliberately readable as prose. A card that only a parser can follow
 * would be a worse artefact for the UI, and the UI is the other reader.
 */

import { FactorScore, ScoreFinding, ScorePillar } from '../types.js';

const KIND_MARK: Record<ScoreFinding['kind'], string> = {
  driver:     '▲',
  drag:       '▼',
  divergence: '⇄',
  cap:        '⛔',
  gap:        '⚠',
};

const KIND_LABEL: Record<ScoreFinding['kind'], string> = {
  driver:     'Treiber',
  drag:       'Belastung',
  divergence: 'Divergenz',
  cap:        'Deckel',
  gap:        'Lücke',
};

function pct(n: number): string {
  return `${(n * 100).toFixed(0)} %`;
}

function pillarRow(p: ScorePillar): string {
  const score = p.score === null ? '—' : `${p.score.toFixed(1)}/10`;
  const weight = p.score === null ? '(ausgelassen)' : pct(p.effectiveWeight);
  return `| ${p.label} | ${score} | ${weight} | ${pct(p.coverage)} |`;
}

function findingLine(f: ScoreFinding): string {
  const impact = f.kind === 'driver' || f.kind === 'drag'
    ? ` ${f.impact >= 0 ? '+' : ''}${f.impact.toFixed(2)} Pkt ·`
    : '';
  return `- ${KIND_MARK[f.kind]} **${KIND_LABEL[f.kind]}**${impact} ${f.note}`;
}

/** Headline line, used on its own where a whole card would be too much. */
export function scoreHeadline(s: FactorScore): string {
  return `**${s.score.toFixed(1)}/10 → ${s.verdict}** — Rohwert ${s.raw.toFixed(1)} `
    + `bei ${pct(s.coverage)} Abdeckung und ${pct(s.confidence)} Konfidenz, `
    + `daher mit ${s.shrink.toFixed(2)} Richtung Neutral gezogen`;
}

export interface RenderOptions {
  /** Include every criterion under each pillar, not just the pillar totals. */
  criteria?: boolean;
}

export function renderFactorCard(s: FactorScore, opts: RenderOptions = {}): string {
  const capped = s.verdict !== s.uncappedVerdict
    ? `\nOhne die Deckel unten wäre das Urteil **${s.uncappedVerdict}** — der Score selbst ist davon unberührt.`
    : '';

  const table = `| Säule | Score | Gewicht | Abdeckung |
| --- | --- | --- | --- |
${s.pillars.map(pillarRow).join('\n')}`;

  const detail = opts.criteria
    ? `\n\n#### Einzelkriterien\n\n${s.pillars.map((p) => {
        const lines = p.criteria.map((c) => {
          const pts = c.points === null
            ? 'nicht bewertbar'
            : `${(c.points * 10).toFixed(1)}/10, Beitrag ${c.impact === null ? '—' : `${c.impact >= 0 ? '+' : ''}${c.impact.toFixed(2)} Pkt`}`;
          return `- ${c.label} (${pts}): ${c.note}`;
        }).join('\n');
        return `**${p.label}** — ${p.score === null ? 'nicht bewertbar' : `${p.score.toFixed(1)}/10`}\n${lines}`;
      }).join('\n\n')}`
    : '';

  const caps = s.caps.length > 0
    ? `\n\n**Deckel auf der Überzeugung** (sie begrenzen das Label, nicht die Zahl):\n${
        s.caps.map((c) => `- ${c.reason}`).join('\n')}`
    : '';

  const findings = s.findings.length > 0
    ? `\n\n#### Befunde\n\nNach Einfluss sortiert. Was hier nicht steht, hat den Score nicht bewegt — das ist der Filter, nicht eine Auslassung.\n\n${
        s.findings.map(findingLine).join('\n')}`
    : '';

  return `### Faktor-Score (im Code berechnet, nicht verhandelbar)

${scoreHeadline(s)}${capped}

Sechs Säulen, jede ein gewichtetes Mittel benannter Kriterien. Kriterien ohne
Daten werden fallen gelassen und die übrigen Gewichte neu normiert — nichts wird
mangels Wissens mit 5/10 bewertet. Die Einzelbeiträge summieren sich exakt auf
Rohwert − 5.

${table}${detail}${caps}${findings}`;
}
