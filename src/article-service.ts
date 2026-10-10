/**
 * The report on a stock (`analysis/article.ts`), written on request: each
 * section from its own material — the pillars' criteria with their figures,
 * the research brief, the chart reading, the calendar, the verdict's case —
 * in parallel, then the editor's headline, lead and conclusion. Kept as a
 * document of its own, beside the verdict it was written from.
 *
 * Public data only: nothing of the depot goes into it.
 */

import { z } from 'zod';

import {
  ARTICLE_SECTIONS, articleMarkdown, editorPrompt, sectionPrompt,
  type ArticleContext, type ArticleSectionKey, type StockArticle,
} from './analysis/article.js';
import { analysisFlagsFor, readAppConfig } from './app-config.js';
import { readCases, type CasePointView } from './cases.js';
import { readAsText, readChart, runChartRead } from './chart-service.js';
import { sourceLabel, type PerplexityContext, type PerplexityFinding } from './data/perplexity.js';
import {
  latestDocument, listVerdictDocuments, readDeepResearchLax, readFinancialsLax, readPerplexityLax, saveDocument,
} from './db/store.js';
import { fmtPriceDe } from './format.js';
import { modelForTask, taskOrFallback } from './llm/gateway.js';
import type { PillarKey } from './types.js';
import { providerForTask } from './providers/factory.js';
import { stockUpcoming } from './stock-history-service.js';
import { logger } from './utils/logger.js';

/** A chart reading older than this is read again for the article. */
const CHART_MAX_AGE_MS = 7 * 86_400_000;

/** The pillars each section is told about, with every criterion's figures. */
const SECTION_PILLARS: Partial<Record<ArticleSectionKey, PillarKey[]>> = {
  figures:   ['quality', 'health', 'revisions'],
  valuation: ['valuation', 'consensus'],
  chart:     ['momentum'],
};

const SectionSchema = z.object({ title: z.string().min(1), text: z.string().min(1) });
const EditorSchema = z.object({ headline: z.string().min(1), teaser: z.string().min(1), conclusion: z.string().min(1) });

export class ArticleInputError extends Error {}

/** The newest article on a stock, and the day of the newest verdict, to tell whether it was written from that one. */
export async function readArticle(symbol: string): Promise<{ article: StockArticle | null; analysisAt: string | null }> {
  const [doc, verdicts] = await Promise.all([latestDocument<StockArticle>(symbol, 'article'), listVerdictDocuments(symbol)]);
  return { article: doc?.data ?? null, analysisAt: verdicts[0]?.data.generatedAt ?? null };
}

const findingLine = (x: PerplexityFinding) =>
  `- ${x.date ?? 'undatiert'} · ${sourceLabel(x)} — ${x.what}${x.impact ? ` Folge: ${x.impact}` : ''}`;
const pointLine = (p: CasePointView) => `- ${p.title ? `${p.title}: ` : ''}${p.text}`;

/** The brief's facts, and deep research's beside them where there is one. */
function briefFacts(brief: PerplexityContext | null, deep: PerplexityContext | null): string {
  const one = (c: PerplexityContext, label: string) => {
    const f = c.findings;
    if (!f) return `${label} (${c.fetchedAt.slice(0, 10)}), als Text:\n${c.synthesis.slice(0, 3000)}`;
    return [
      `${label} vom ${c.fetchedAt.slice(0, 10)}:`,
      f.events.length ? `Ereignisse:\n${f.events.map(findingLine).join('\n')}` : '',
      f.kpis?.length ? `Operative Kennzahlen:\n${f.kpis.map((k) => `- ${k.name}: ${k.values.map((v) => `${v.period} ${v.value}`).join(' → ')}${k.read ? ` — ${k.read}` : ''}`).join('\n')}` : '',
      f.bearEvidence.length ? `Gegenbelege:\n${f.bearEvidence.map(findingLine).join('\n')}` : '',
      f.catalysts?.length ? `Termine aus der Recherche:\n${f.catalysts.map((c2) => `- ${c2.date ?? 'ohne Datum'}: ${c2.event}${c2.watch ? ` — ${c2.watch}` : ''}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  };
  return [brief && one(brief, 'Recherche'), deep && one(deep, 'Tiefenrecherche (bei Widerspruch gilt die neuere Quelle)')]
    .filter(Boolean).join('\n\n');
}

/**
 * Write the article on `symbol` from its newest verdict. Reads the chart again
 * where the reading is missing or older than a week. Throws when there is no
 * verdict to write from.
 */
export async function writeArticle(symbol: string): Promise<StockArticle> {
  const [verdicts, f, brief, deep, upcoming, config] = await Promise.all([
    listVerdictDocuments(symbol), readFinancialsLax(symbol), readPerplexityLax(symbol), readDeepResearchLax(symbol),
    stockUpcoming(symbol).catch(() => []), readAppConfig(),
  ]);
  const verdict = verdicts[0]?.data;
  if (!verdict || !f) throw new ArticleInputError(`Für ${symbol} gibt es noch keine Analyse, aus der ein Bericht entstehen könnte.`);
  const card = verdict.scoreCard?.factor ?? null;
  const llm = verdict.llmAnalysis;
  const cur = f.tradingCurrency;
  const price = (n: number | null | undefined) => fmtPriceDe(n, cur);

  // The chart reading the article describes: the stored one while it is recent, else a new one.
  let chart = (await readChart(symbol).catch(() => null))?.read ?? null;
  if (!chart || Date.now() - Date.parse(chart.producedAt) > CHART_MAX_AGE_MS) {
    chart = await runChartRead(symbol).catch((e) => {
      logger.warn(`${symbol}: chart reading for the article failed (${(e as Error).message})`);
      return chart;
    });
  }

  const pillars = (keys: PillarKey[] = []) => (card?.pillars ?? []).filter((p) => keys.includes(p.key)).map((p) => [
    `${p.label}: ${p.score === null ? 'nicht bewertbar' : `${p.score.toFixed(1)} von 10`}`,
    ...p.criteria.filter((c) => c.points !== null && c.note).map((c) => `- ${c.label}: ${c.note}`),
  ].join('\n')).join('\n\n');
  const findings = (keys: PillarKey[] = []) => (card?.findings ?? [])
    .filter((x) => x.pillar !== null && keys.includes(x.pillar)).map((x) => `- ${x.note}`).join('\n');
  const cases = readCases(llm);

  const material: Record<ArticleSectionKey, string> = {
    business: [
      `${f.companyName}, ${[f.sector, f.industry].filter(Boolean).join(' / ')}`,
      f.description ? `Geschäft: ${f.description.slice(0, 900)}` : '',
      upcoming.length ? `Termine (Kalender und Recherche):\n${upcoming.slice(0, 8).map((e) => `- ${e.day}: ${e.title}${e.detail ? ` — ${e.detail}` : ''}`).join('\n')}` : '',
      briefFacts(brief, deep),
    ].filter(Boolean).join('\n\n'),
    figures: [pillars(SECTION_PILLARS.figures), findings(SECTION_PILLARS.figures)].filter(Boolean).join('\n\nBefunde:\n'),
    valuation: [
      pillars(SECTION_PILLARS.valuation),
      findings(SECTION_PILLARS.valuation) && `Befunde:\n${findings(SECTION_PILLARS.valuation)}`,
      `Faire Spanne der Bewertungsmodelle: ${llm.fairValueEstimate}`,
      f.analystCount ? `Analysten: ${f.analystCount}, davon ${f.analystStrongBuy ?? 0} Strong Buy, ${f.analystBuy ?? 0} Buy, `
        + `${f.analystHold ?? 0} Hold, ${(f.analystSell ?? 0) + (f.analystStrongSell ?? 0)} Sell. Kursziel im Mittel `
        + `${price(f.targetMeanPrice)}, Median ${price(f.analystTargetMedian)}, Spanne ${price(f.analystTargetLow)} bis ${price(f.analystTargetHigh)}.` : '',
    ].filter(Boolean).join('\n\n'),
    chart: [
      `Kurs ${price(f.price)}, 52-Wochen-Spanne ${price(f.fiftyTwoWeekLow)} bis ${price(f.fiftyTwoWeekHigh)}.`,
      pillars(SECTION_PILLARS.chart),
      chart ? `Chartlesung (Kurse bis ${chart.read.asOf}):\n${readAsText(chart.read)}` : 'Keine Chartlesung vorhanden.',
    ].filter(Boolean).join('\n\n'),
    debate: [
      brief?.findings?.debate?.length
        ? `Offene Kernfragen:\n${brief.findings.debate.map((d) => `- ${d.question} ${d.why}${d.settles ? ` Entscheidet: ${d.settles}${d.when ? ` (${d.when})` : ''}` : ''}`).join('\n')}` : '',
      // The theses, not the figures: those are the sections before, and repeated here they were read twice.
      `Bull Case:\n${[...cases.bull.theses, ...cases.bull.unsorted].map(pointLine).join('\n')}`,
      cases.bull.triggers.length ? `Was das Urteil heben würde:\n${cases.bull.triggers.map(pointLine).join('\n')}` : '',
      `Bear Case:\n${[...cases.bear.theses, ...cases.bear.unsorted].map(pointLine).join('\n')}`,
      cases.bear.triggers.length ? `Was das Urteil senken würde:\n${cases.bear.triggers.map(pointLine).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  };

  const ctx: ArticleContext = { symbol, company: f.companyName, price: price(f.price), date: new Date().toISOString().slice(0, 10) };
  // Its own task in the proxy where it is set up there, else the analysis's.
  const task = await taskOrFallback('article', 'analysis');
  const model = await modelForTask(task, analysisFlagsFor(config).model);
  const calls: { usedModel: string | null; costUsd: number | null }[] = [];
  const ask = async <T>(label: string, user: string, schema: z.ZodType<T>): Promise<T> => {
    const provider = providerForTask(task, model);
    const out = await provider.complete({ label, system: 'Du bist Redakteur eines Anlegermagazins. Antworte ausschließlich mit gültigem JSON nach dem angegebenen Schema.', user, schema, maxTokens: 6000 });
    calls.push({ usedModel: provider.usedModel, costUsd: provider.costUsd });
    return out;
  };

  logger.step(`${symbol}: Bericht mit ${model} — ${ARTICLE_SECTIONS.length} Abschnitte…`);
  const sections = await Promise.all(ARTICLE_SECTIONS.map(async (s) => {
    const out = await ask(`article-${s.key}`, sectionPrompt(s.key, ctx, material[s.key]), SectionSchema);
    return { key: s.key, title: out.title.trim(), text: out.text.trim() };
  }));
  const editor = await ask('article-editor', editorPrompt(ctx, {
    recommendation: llm.recommendation, score: llm.score, thesis: llm.thesis, fairValue: llm.fairValueEstimate,
  }, sections), EditorSchema);

  const costs = calls.map((c) => c.costUsd).filter((c): c is number => c !== null);
  const article: StockArticle = {
    symbol, generatedAt: new Date().toISOString(),
    basis: {
      analysisAt: verdict.generatedAt, recommendation: llm.recommendation, score: llm.score,
      chartAsOf: chart?.read.asOf ?? null, briefAt: brief?.fetchedAt ?? null,
    },
    headline: editor.headline.trim(), teaser: editor.teaser.trim(), sections, conclusion: editor.conclusion.trim(),
    model: calls.find((c) => c.usedModel)?.usedModel ?? model,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
  await saveDocument({ symbol, kind: 'article', content: articleMarkdown(article), data: article, model: article.model, costUsd: article.costUsd });
  logger.success(`${symbol}: Bericht geschrieben${article.costUsd !== null ? `, $${article.costUsd.toFixed(3)}` : ''}`);
  return article;
}
