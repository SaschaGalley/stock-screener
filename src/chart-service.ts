/**
 * The price chart for the stock page, and a model's reading of it.
 *
 * `readChart` is arithmetic: the archived daily bars, the moving averages and
 * everything `analysis/chart.ts` finds in them. `runChartRead` hands that
 * reading and the bars themselves — weekly for two years, daily for the last
 * quarter — to a language model and asks what a chartist would add: the
 * patterns, which levels matter and why, the scenarios with their trigger
 * prices, and what would prove the reading wrong.
 *
 * The model sees prices and nothing else — no news, no fundamentals, no
 * verdict — so that what comes back is a reading of the chart and not the
 * thesis restated with a chart's vocabulary. Run by hand, stored as a
 * `chart` document, never part of the score.
 */

import { z } from 'zod';

import {
  CHART_PATTERN_STATUS, chartAnalysis, channelMove, levelPhrase, smaSeries,
  type ChartAnalysis, type ChartBar, type ChartRead, type ChartReadDoc, type ChartResponse,
} from './analysis/chart.js';
import { readPriceBarsOhlc } from './db/history-store.js';
import { latestDocument, readFinancialsLax, saveDocument } from './db/store.js';
import { modelFor, readAppConfig } from './app-config.js';
import { resolveModelId } from './models.js';
import { createProviderForModel } from './providers/factory.js';
import { logger } from './utils/logger.js';

/** Bars read: three years, so the 200-day line and the year's squeeze have warmed up where the chart begins. */
const READ_DAYS = 3 * 366;
/** Bars shown: two years of sessions. */
const SHOWN_SESSIONS = 504;
/** What the model gets: weekly bars over two years, daily bars over the last quarter. */
const WEEKS_FOR_MODEL = 104;
const DAYS_FOR_MODEL = 65;

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function bars(symbol: string): Promise<ChartBar[]> {
  return readPriceBarsOhlc(symbol, isoDaysAgo(READ_DAYS));
}

function toDoc(row: { data: ChartRead | null; model: string | null; producedAt: string } | null): ChartReadDoc | null {
  return row?.data ? { read: row.data, model: row.model, producedAt: row.producedAt } : null;
}

/** `GET /api/stocks/:symbol/chart` */
export async function readChart(symbol: string): Promise<ChartResponse> {
  const [all, f, doc] = await Promise.all([
    bars(symbol),
    readFinancialsLax(symbol),
    latestDocument<ChartRead>(symbol, 'chart'),
  ]);
  const closes = all.map((b) => b.close);
  const from = Math.max(0, all.length - SHOWN_SESSIONS);
  const cut = <T>(xs: T[]) => xs.slice(from);
  return {
    symbol,
    currency: f?.tradingCurrency ?? null,
    bars: cut(all),
    sma: {
      sma20:  cut(smaSeries(closes, 20)),
      sma50:  cut(smaSeries(closes, 50)),
      sma200: cut(smaSeries(closes, 200)),
    },
    analysis: chartAnalysis(all),
    read: toDoc(doc),
  };
}

// ─── The prompt ──────────────────────────────────────────────────────────────

const n2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;

/** Monday-to-Friday weeks, each as one bar. */
export function weeklyBars(xs: readonly ChartBar[]): ChartBar[] {
  const out: ChartBar[] = [];
  let key = '';
  for (const b of xs) {
    const d = new Date(`${b.day}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const w = out.at(-1);
    if (monday !== key || !w) {
      key = monday;
      out.push({ ...b, day: monday, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close });
      continue;
    }
    w.high = Math.max(w.high!, b.high ?? b.close);
    w.low = Math.min(w.low!, b.low ?? b.close);
    w.close = b.close;
    w.volume = w.volume !== null && b.volume !== null ? w.volume + b.volume : w.volume ?? b.volume;
  }
  return out;
}

const row = (b: ChartBar) => [
  b.day, n2(b.open ?? b.close), n2(b.high ?? b.close), n2(b.low ?? b.close), n2(b.close),
  b.volume === null ? '' : (b.volume / 1e6).toFixed(2),
].join(',');

/** The computed reading, as the model gets it: the facts it is asked to check, not to repeat. */
function analysisBlock(a: ChartAnalysis): string {
  const lines = [
    `Letzter Schlusskurs ${n2(a.close)} am ${a.asOf}; ATR(14) ${a.atr !== null ? n2(a.atr) : 'n/a'}; RSI(14) ${a.rsi14 !== null ? a.rsi14.toFixed(0) : 'n/a'}.`,
    `Trendstruktur: ${a.structure.text}`,
    `Gleitende Durchschnitte: SMA20 ${a.ma.sma20 !== null ? n2(a.ma.sma20) : 'n/a'}, SMA50 ${a.ma.sma50 !== null ? n2(a.ma.sma50) : 'n/a'}, SMA200 ${a.ma.sma200 !== null ? n2(a.ma.sma200) : 'n/a'}`
      + `${a.ma.cross ? `; letzter Schnitt 50/200: ${a.ma.cross.kind === 'golden' ? 'Golden Cross' : 'Death Cross'} am ${a.ma.cross.day}` : ''}.`,
    'Regressionskanäle (±2σ):',
    ...a.channels.map((c) => `- ${c.label}: ${pct(channelMove(c))} über den Zeitraum, R² ${c.r2.toFixed(2)}, Kurs bei ${c.z.toFixed(1)}σ, `
      + `Kanal heute ${n2(c.lower[1])}–${n2(c.upper[1])}`),
    'Unterstützungen und Widerstände aus Wendepunkten (Zickzack mit 3 ATR):',
    ...a.levels.map((l) => `- ${l.kind === 'support' ? 'Unterstützung' : 'Widerstand'} ${levelPhrase(l)}`),
    ...a.trendlines.map((t) => `Trendlinie (${t.kind === 'support' ? 'Tiefs' : 'Hochs'}) ${t.from.day} ${n2(t.from.price)} → ${t.to.day} ${n2(t.to.price)}, heute ${n2(t.now)}${t.broken ? `, gebrochen am ${t.brokenAt}` : ''}.`),
    a.profile ? `Volumenprofil (1 Jahr): POC ${n2(a.profile.poc)}, 70-%-Zone ${n2(a.profile.valueLow)}–${n2(a.profile.valueHigh)}.` : '',
    a.fibonacci ? `Fibonacci der Jahresbewegung (${a.fibonacci.dir === 'up' ? 'aufwärts' : 'abwärts'} ${a.fibonacci.from.day} ${n2(a.fibonacci.from.price)} → ${a.fibonacci.to.day} ${n2(a.fibonacci.to.price)}): `
      + a.fibonacci.levels.map((l) => `${(l.ratio * 100).toFixed(1)} % ${n2(l.price)}`).join(', ') : '',
    ...a.divergences.map((d) => `RSI-Divergenz ${d.kind === 'bullish' ? 'bullisch' : 'bärisch'}: ${d.from.day} (${n2(d.from.price)}, RSI ${d.from.rsi.toFixed(0)}) → ${d.to.day} (${n2(d.to.price)}, RSI ${d.to.rsi.toFixed(0)}).`),
    ...a.breakouts.map((b) => `${b.dir === 'up' ? 'Ausbruch über' : 'Bruch unter'} ${n2(b.level)} am ${b.day}${b.volumeRatio !== null ? `, Volumen ${b.volumeRatio.toFixed(1)}× üblich` : ''}.`),
    ...a.gaps.map((g) => `Offene Kurslücke ${g.dir === 'up' ? 'aufwärts' : 'abwärts'} vom ${g.day}: ${n2(g.low)}–${n2(g.high)}.`),
    a.squeeze ? `Bollinger-Bandbreite enger als ${Math.round((1 - a.squeeze.percentile) * 100)} % der Tage des letzten Jahres.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const SYSTEM = `Du bist ein erfahrener Chartanalyst. Du liest ausschließlich die Kursdaten, die du bekommst — keine Nachrichten, keine Fundamentaldaten, kein Vorwissen über die Firma. Du antwortest auf Deutsch und ausschließlich mit einem JSON-Objekt.

Grundsätze:
- Nenne ein Chartmuster (z. B. Kopf-Schulter, Doppelboden, Doppeltop, Dreieck, Keil, Flagge, Wimpel, Rechteck, Tasse mit Henkel, Ausbruch mit Pullback) nur, wenn es in den Daten tatsächlich zu sehen ist, mit Anfangs- und Enddatum aus den Daten. Lieber kein Muster als ein erfundenes.
- Jeder Preis, den du nennst, muss sich aus den Daten begründen lassen. Ein Kursziel nur, wenn das Muster eine Messregel hat (z. B. Höhe der Formation ab Ausbruchspunkt).
- Prüfe die vorberechneten Marken kritisch: Welche haben wirklich gehalten, welche sind nur Rauschen? Fehlt eine wichtige Marke (z. B. eine runde Zahl, an der der Kurs mehrfach drehte)?
- Sag, wo die Lage mehrdeutig ist. Technische Analyse ist keine geprüfte Vorhersage; formuliere Szenarien mit Auslösern, keine Empfehlungen.
- Kurz und konkret. In den Feldern "from" und "to" Daten als YYYY-MM-DD; im Text (summary, comment, trigger, invalidation, watch) schreibst du deutsch: Daten als 17.9.2026, Zahlen mit Dezimalkomma und Tausenderpunkt, Beträge mit dem Währungszeichen dahinter (1.042,40 $, 109,40 €). Preise in "price", "trigger" und "target" bleiben JSON-Zahlen.

JSON-Schema:
{
  "summary": "2–4 Sätze: Was zeigt der Chart jetzt?",
  "trend": { "direction": "up" | "down" | "sideways", "phase": "z. B. Akkumulation, Aufwärtstrend, Distribution, Abwärtstrend, Bodenbildung, Konsolidierung", "comment": "ein Satz" },
  "patterns": [ { "name": "…", "status": "forming" | "confirmed" | "failed", "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null, "trigger": Zahl | null, "target": Zahl | null, "comment": "Woran erkennbar, was es bedeutet" } ],
  "levels": [ { "price": Zahl, "kind": "support" | "resistance", "strength": "strong" | "medium" | "weak", "comment": "warum diese Marke zählt" } ],
  "scenarios": [ { "case": "bull" | "bear" | "base", "trigger": "konkreter Auslöser mit Preis", "target": Zahl | null, "comment": "ein Satz" } ],
  "invalidation": "Was die ganze Lesart widerlegen würde" | null,
  "watch": [ "worauf in den nächsten Wochen zu achten ist" ]
}
Höchstens 4 Muster, 8 Marken, 3 Szenarien, 5 Beobachtungspunkte.`;

export function chartReadPrompt(symbol: string, name: string | null, currency: string | null, all: readonly ChartBar[], a: ChartAnalysis): string {
  const weeks = weeklyBars(all).slice(-WEEKS_FOR_MODEL);
  const days = all.slice(-DAYS_FOR_MODEL);
  return [
    `# ${name ?? symbol} (${symbol}), Kurse in ${currency ?? 'Handelswährung'}, splitbereinigt`,
    '',
    '## Vorberechnet',
    analysisBlock(a),
    '',
    `## Wochenkerzen, ${weeks.length} Wochen (Wochenbeginn,Eröffnung,Hoch,Tief,Schluss,Volumen in Mio.)`,
    ...weeks.map(row),
    '',
    `## Tageskerzen, letzte ${days.length} Handelstage (Datum,Eröffnung,Hoch,Tief,Schluss,Volumen in Mio.)`,
    ...days.map(row),
  ].join('\n');
}

// ─── The answer ──────────────────────────────────────────────────────────────

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((s) => s.slice(0, 10)).nullable().catch(null);
const price = z.number().positive().nullable().catch(null);

export const ChartReadSchema = z.object({
  summary: z.string().min(1),
  trend: z.object({
    direction: z.enum(['up', 'down', 'sideways']),
    phase:     z.string().catch(''),
    comment:   z.string().catch(''),
  }),
  patterns: z.array(z.object({
    name:    z.string().min(1),
    status:  z.enum(CHART_PATTERN_STATUS).catch('forming'),
    from:    day,
    to:      day,
    trigger: price,
    target:  price,
    comment: z.string().catch(''),
  })).default([]),
  levels: z.array(z.object({
    price:    z.number().positive(),
    kind:     z.enum(['support', 'resistance']),
    strength: z.enum(['strong', 'medium', 'weak']).catch('medium'),
    comment:  z.string().catch(''),
  })).default([]),
  scenarios: z.array(z.object({
    case:    z.enum(['bull', 'bear', 'base']),
    trigger: z.string(),
    target:  price,
    comment: z.string().catch(''),
  })).default([]),
  invalidation: z.string().nullable().catch(null),
  watch: z.array(z.string()).default([]),
});

/** The reading as text, for the document's `content` — what a later diff reads. */
function readAsText(r: ChartRead): string {
  return [
    r.summary,
    `Trend: ${r.trend.direction}, ${r.trend.phase}. ${r.trend.comment}`,
    ...r.patterns.map((p) => `Muster: ${p.name} (${p.status}${p.from ? `, ${p.from}–${p.to ?? ''}` : ''})`
      + `${p.trigger !== null ? `, Auslöser ${n2(p.trigger)}` : ''}${p.target !== null ? `, Ziel ${n2(p.target)}` : ''}. ${p.comment}`),
    ...r.levels.map((l) => `${l.kind === 'support' ? 'Unterstützung' : 'Widerstand'} ${n2(l.price)} (${l.strength}): ${l.comment}`),
    ...r.scenarios.map((s) => `Szenario ${s.case}: ${s.trigger}${s.target !== null ? ` → ${n2(s.target)}` : ''}. ${s.comment}`),
    r.invalidation ? `Widerlegt, wenn: ${r.invalidation}` : '',
    ...r.watch.map((w) => `Beobachten: ${w}`),
  ].filter(Boolean).join('\n');
}

export class ChartReadInputError extends Error {}

/**
 * Ask `model` to read the chart — without one, the chart reading's model from
 * the administration — keep the answer and return it. Prices far outside
 * anything the chart traded at are dropped: a level at ten times the high is
 * a typo, not a reading.
 */
export async function runChartRead(symbol: string, model?: string | null): Promise<ChartReadDoc> {
  const modelId = model ? resolveModelId(model) : modelFor(await readAppConfig(), 'chart');
  const [all, f] = await Promise.all([bars(symbol), readFinancialsLax(symbol)]);
  const a = chartAnalysis(all);
  if (!a) throw new ChartReadInputError(`Zu wenige Kursdaten für ${symbol}, um den Chart zu lesen.`);

  const shown = all.slice(-SHOWN_SESSIONS);
  const lo = Math.min(...shown.map((b) => b.low ?? b.close));
  const hi = Math.max(...shown.map((b) => b.high ?? b.close));
  const plausible = (p: number | null) => p === null || (p >= lo * 0.5 && p <= hi * 1.6);

  logger.info(`${symbol}: Chart-Lesung mit ${modelId}…`);
  const out = await createProviderForModel(modelId).complete({
    label:  'chart-read',
    system: SYSTEM,
    user:   chartReadPrompt(symbol, f?.companyName ?? null, f?.tradingCurrency ?? null, all, a),
    schema: ChartReadSchema,
    // Reasoning models spend this on thinking too; the answer itself is short.
    maxTokens: 8000,
  });

  const read: ChartRead = {
    asOf: a.asOf,
    summary: out.summary,
    trend: out.trend,
    patterns: out.patterns.slice(0, 4).map((p) => ({
      ...p, trigger: plausible(p.trigger) ? p.trigger : null, target: plausible(p.target) ? p.target : null,
    })),
    levels: out.levels.filter((l) => plausible(l.price)).slice(0, 8),
    scenarios: out.scenarios.slice(0, 3).map((s) => ({ ...s, target: plausible(s.target) ? s.target : null })),
    invalidation: out.invalidation,
    watch: out.watch.slice(0, 5),
  };
  await saveDocument({ symbol, kind: 'chart', content: readAsText(read), data: read, model: modelId, schemaVer: 1 });
  return { read, model: modelId, producedAt: new Date().toISOString() };
}
