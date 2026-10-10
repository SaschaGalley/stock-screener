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
  { key: 'business',  title: 'Geschäft und Lage',      brief: 'Was sich zuletzt getan hat und was bevorsteht: die Ereignisse, die operativen Kennzahlen, die nächsten Termine. Was das Unternehmen macht, nur so weit, wie es zum Verständnis nötig ist.' },
  { key: 'figures',   title: 'Die Zahlen',             brief: 'Wachstum, Profitabilität, Cashflow, Bilanz — und wohin sich die Erwartungen der Analysten bewegen.' },
  { key: 'valuation', title: 'Bewertung und Analysten', brief: 'Was die Aktie kostet, gegen die Branche und die eigene Historie; was die Bewertungsmodelle als fairen Wert sehen; was die Analysten erwarten.' },
  { key: 'chart',     title: 'Der Chart',              brief: 'Wohin der Trend zeigt, die zwei, drei Marken, auf die es ankommt, und was dort passieren müsste; dazu das Momentum.' },
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

/**
 * The register, between Börse Online and Der Aktionär: readable, not shouted.
 * The first reports read like an analyst's note — every figure of the material
 * in turn, two decimals, Altman-Z and Rule of 40 — so the style chooses, rounds
 * and translates, and leaves the figures to the app's other tabs.
 */
export const ARTICLE_STYLE = `So schreibst du — wie ein Börsenredakteur zwischen Der Aktionär und Börse Online,
der einem interessierten Bekannten die Aktie erklärt:
- Locker und leicht zu lesen. Kurze und mittellange Sätze im Wechsel, kaum einer über
  20 Wörter, aber kein Stakkato: Verbinde, was zusammengehört. Verben statt Hauptwörter
  („das Geschäft wirft viel ab" statt „die Ertragskraft bildet ein breites Fundament").
  Ein Bild oder eine Frage zum Einstieg in einen Absatz ist willkommen.
  Nicht zugespitzt: keine Superlative, keine Ausrufezeichen, kein „Rakete",
  „Kursfeuerwerk" oder „jetzt zugreifen", keine Kaufaufforderung.
- Auswählen statt aufzählen. Das Material ist mehr, als in deinen Text passt: Nimm die
  zwei, drei Punkte, die ein Anleger wissen muss, und lass den Rest weg — lieber drei
  Zahlen erklärt als zehn genannt.
- Höchstens eine Zahl je Satz, gerundet, wie man sie sagt: „gut 45 %", „knapp 30",
  „rund 50 $". Die Einordnung gern in Worten („weit mehr als die Konkurrenz").
- Fachbegriffe übersetzt du oder lässt sie weg. KGV und Dividendenrendite kennt der Leser;
  Altman-Z, Rule of 40, EV/EBITDA, Current Ratio, Kapitalkosten oder die Namen der
  Bewertungsmodelle nicht — sag, was sie bedeuten („die Bilanz ist kerngesund").
- Jede Aussage aus dem Material. Was nicht darin steht, erfindest du nicht — keine
  Zahlen, Kursziele, Termine, Zitate oder Ereignisse. Und du schreibst nicht über das
  Material („liegt nicht vor", „fehlt im Material"): Was fehlt, lässt du weg.
- Deutsch, Dezimalkomma, Beträge in der Handelswährung.
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

Andere Abschnitte behandeln die übrigen Themen; bleib bei deinem. Zwei oder drei kurze
Absätze, zusammen 110 bis 180 Wörter. Steig mit dem ein, was ein Anleger zuerst wissen will.

${ARTICLE_STYLE}

### Material

${material.trim() || 'Kein Material — schreib in einem Satz, dass dazu nichts vorliegt.'}

Antworte als JSON:
{ "title": "Zwischenüberschrift, 2–6 Wörter, gern mit Pfiff: die Aussage des Abschnitts", "text": "die Absätze, getrennt durch eine Leerzeile" }`;
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

- "headline": die Überschrift, 5–10 Wörter, so wie eine Zeitschrift titelt — der Kern des Falls,
  mit dem Namen der Firma, gern mit Doppelpunkt oder einem Bild; ohne Frage, ohne Ausrufezeichen.
- "teaser": der Vorspann, zwei Sätze, die neugierig machen und sagen, worum es geht.
- "conclusion": das Fazit, ein Absatz von 60 bis 100 Wörtern. Fang nicht mit dem Urteil an,
  sondern mit dem, worauf der Fall hinausläuft; dann das Urteil und den Score so, wie sie oben
  stehen, in einem Satz („Die App sieht die Aktie mit … von 10 Punkten bei …"), dann, was
  es kippen würde. Es widerspricht keinem Abschnitt.

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
