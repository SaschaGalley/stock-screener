/**
 * The report on a stock: an article in the manner of an investor magazine,
 * written on request from what the app already holds — the verdict and its
 * pillars, the research brief, the chart reading, the calendar.
 *
 * It explains the verdict and never sets it. Score, recommendation and the
 * fair-value range come from the arithmetic and the models; the article only
 * puts them into words. That is why it is written in sections, one model call
 * each with only its own material — the business, the figures, the valuation,
 * the chart, the debate — and then by an editor who sees the sections and the
 * verdict and writes the headline, the lead and the conclusion: a section that
 * sees only its material cannot argue past it, and each has room for more than
 * the verdict's bullet points.
 *
 * Pure and dependency-free: the web app imports the types and the sections.
 */

export const ARTICLE_SECTIONS = [
  { key: 'business',  title: 'Geschäft und Lage',      brief: 'Was das Unternehmen macht und was sich zuletzt getan hat: die Ereignisse, die operativen Kennzahlen, was bevorsteht.' },
  { key: 'figures',   title: 'Die Zahlen',             brief: 'Wachstum, Profitabilität, Cashflow, Bilanz — und wohin sich die Erwartungen der Analysten bewegen.' },
  { key: 'valuation', title: 'Bewertung und Analysten', brief: 'Was die Aktie kostet, gegen die Branche und die eigene Historie; was die Bewertungsmodelle als fairen Wert sehen; was die Analysten erwarten.' },
  { key: 'chart',     title: 'Der Chart',              brief: 'Trend, Marken und Szenarien aus der Chartlesung, dazu das Momentum.' },
  { key: 'debate',    title: 'Pro und Contra',         brief: 'Was für die Aktie spricht, was dagegen, und an welchen Fragen der Kurs hängt — die Argumente; Kennzahlen und Bewertung stehen in den Abschnitten davor, wiederhole sie nicht.' },
] as const;
export type ArticleSectionKey = (typeof ARTICLE_SECTIONS)[number]['key'];

export interface StockArticle {
  symbol:      string;
  generatedAt: string;
  /** What it was written from: the verdict's day and outcome, the chart reading's and the brief's day. */
  basis: {
    analysisAt:     string;
    recommendation: string;
    score:          number;
    chartAsOf:      string | null;
    briefAt:        string | null;
  };
  headline:   string;
  teaser:     string;
  sections:   { key: ArticleSectionKey; title: string; text: string }[];
  conclusion: string;
  /** The model that wrote it, as the proxy routed it. */
  model:      string | null;
  costUsd:    number | null;
}

/** The register, between Börse Online and Der Aktionär: readable, not shouted. */
export const ARTICLE_STYLE = `So schreibst du — wie die Redaktion eines Anlegermagazins, zwischen Börse Online
und Der Aktionär:
- Lebendig und gut lesbar: kurze und lange Sätze im Wechsel, aktive Verben, ein
  anschauliches Bild, wo es trägt. Nicht trocken, aber nicht zugespitzt: keine
  Superlative, keine Ausrufezeichen, kein „Rakete", „Kursfeuerwerk" oder „jetzt
  zugreifen", keine Kaufaufforderung.
- Jede Aussage aus dem Material unten. Zahlen nennst du mit ihrem Maßstab („Marge
  von 31 %, rund fünf Punkte über dem Branchenschnitt"), nie ohne Einordnung. Was
  nicht im Material steht, erfindest du nicht — keine Zahlen, Kursziele, Termine,
  Zitate oder Ereignisse.
- Deutsch, Zahlen mit Dezimalkomma (8,4 %), Beträge in der Handelswährung.
- Keine Überschrift im Text, keine Aufzählungszeichen, kein Hinweis auf Anlageberatung:
  das macht die Seite.`;

/** What every section and the editor are told about the stock. */
export interface ArticleContext {
  symbol:  string;
  company: string;
  /** "412,30 $" */
  price:   string;
  date:    string;
}

/** A section's prompt: its task, its material, nothing of the others'. */
export function sectionPrompt(key: ArticleSectionKey, ctx: ArticleContext, material: string): string {
  const s = ARTICLE_SECTIONS.find((x) => x.key === key)!;
  return `## ${ctx.company} (${ctx.symbol}) — Kurs ${ctx.price}, Stand ${ctx.date}

Du schreibst einen Abschnitt eines Artikels über die Aktie, den Abschnitt „${s.title}":
${s.brief}

Andere Abschnitte behandeln die übrigen Themen; bleib bei deinem. Zwei bis vier Absätze,
zusammen 180 bis 320 Wörter. Führe mit dem, was ein Anleger zuerst wissen will.

${ARTICLE_STYLE}

### Material

${material.trim() || 'Kein Material — schreib in einem Satz, dass dazu nichts vorliegt.'}

Antworte als JSON:
{ "title": "Zwischenüberschrift, 3–7 Wörter, die Aussage des Abschnitts", "text": "die Absätze, getrennt durch eine Leerzeile" }`;
}

/** The editor's prompt: the verdict as it stands, the sections as written. */
export function editorPrompt(
  ctx: ArticleContext,
  verdict: { recommendation: string; score: number; thesis: string; fairValue: string },
  sections: { title: string; text: string }[],
): string {
  return `## ${ctx.company} (${ctx.symbol}) — Kurs ${ctx.price}, Stand ${ctx.date}

Du bist die Redaktion. Die Abschnitte unten sind geschrieben; du schreibst die Überschrift,
den Vorspann und das Fazit des Artikels.

Das Urteil steht fest und kommt aus der Rechnung der App, nicht von dir: ${verdict.recommendation},
Score ${verdict.score.toFixed(1).replace('.', ',')} von 10. Die These dazu: ${verdict.thesis}
Faire Spanne der Bewertungsmodelle: ${verdict.fairValue}.

- "headline": die Überschrift, 6–12 Wörter — der Kern des Falls, mit dem Namen der Firma,
  ohne Frage und ohne Ausrufezeichen.
- "teaser": der Vorspann, zwei bis drei Sätze, die neugierig machen und sagen, worum es geht.
- "conclusion": das Fazit, ein Absatz von 80 bis 140 Wörtern. Es nennt das Urteil und den Score
  so, wie sie oben stehen, sagt, was es trägt und was es kippen würde, und widerspricht keinem
  Abschnitt.

${ARTICLE_STYLE}

### Die Abschnitte

${sections.map((s) => `#### ${s.title}\n\n${s.text}`).join('\n\n')}

Antworte als JSON:
{ "headline": "...", "teaser": "...", "conclusion": "..." }`;
}

/** The article as markdown: what is stored beside the object, and what a copy takes. */
export function articleMarkdown(a: StockArticle): string {
  return [
    `# ${a.headline}`, `**${a.teaser}**`,
    ...a.sections.map((s) => `## ${s.title}\n\n${s.text}`),
    `## Fazit\n\n${a.conclusion}`,
  ].join('\n\n');
}
