import {
  calculateDCF,
  calculateGraham,
  calculateRatios,
  calculateReverseDCF,
  calculatePeterLynch,
  calculateEVMultiples,
  calculateRuleOf40,
  calculateGrahamRevised,
  calculatePiotroski,
  calculateAltmanZ,
  calculateDDM,
  calculateEPV,
  calculateInterestCoverage,
  calculateSortino,
  calculateBeneish,
  calculateRIM,
  calculateNCAV,
  calculatePeerMultiples,
  calculateCompositeFairValue,
  fmt,
  fmtPct,
  fmtBig,
} from '../analysis/metrics.js';
import { SEASONAL_GAP_THRESHOLD } from '../analysis/run-rate.js';
import { currencyPrefix, fmtPrice } from '../format.js';
import { MarketSignals, NarrativeTheses, SectorMedians, StockFinancials } from '../types.js';
import { PerplexityContext } from '../data/perplexity.js';
import { DistillBundle, DistillDossierBlock, DistillInsight } from '../data/distill.js';

export interface PromptData {
  dcf: ReturnType<typeof calculateDCF>;
  grahamNumber: ReturnType<typeof calculateGraham>;
  ratios: ReturnType<typeof calculateRatios>;
  reverseDCF: ReturnType<typeof calculateReverseDCF>;
  peterLynch: ReturnType<typeof calculatePeterLynch>;
  evMultiples: ReturnType<typeof calculateEVMultiples>;
  ruleOf40: ReturnType<typeof calculateRuleOf40>;
  grahamRevised: ReturnType<typeof calculateGrahamRevised>;
  piotroski: ReturnType<typeof calculatePiotroski>;
  altmanZ: ReturnType<typeof calculateAltmanZ>;
  ddm: ReturnType<typeof calculateDDM>;
  epv: ReturnType<typeof calculateEPV>;
  rim: ReturnType<typeof calculateRIM>;
  ncav: ReturnType<typeof calculateNCAV>;
  peerMultiples: ReturnType<typeof calculatePeerMultiples>;
  composite: ReturnType<typeof calculateCompositeFairValue>;
  interestCoverage: ReturnType<typeof calculateInterestCoverage>;
  sortino: ReturnType<typeof calculateSortino>;
  beneish: ReturnType<typeof calculateBeneish>;
  sectorMedians: SectorMedians | null;
  marketSignals: MarketSignals;
}

// ─── Market-signal section helpers ───────────────────────────────────────────

function bps(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(0)}bps`;
}

function signedPct(n: number | null): string {
  if (n === null) return 'N/A';
  const v = n * 100;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

/**
 * Push an embedded document's headings below the heading that introduces it.
 *
 * The analysis prompt is one markdown document whose top level is
 * `## Stock Analysis: …`. A Distill briefing is its own document and rightly
 * heads its sections with `##` — but pasted in verbatim, `## Risks & Concerns`
 * becomes a *sibling of the whole analysis*, so the briefing's risks read as the
 * analysis's risks. Demoting keeps the briefing's internal structure intact and
 * subordinate, which is what the surrounding text ("weight this below the
 * quantitative models") depends on being true structurally as well as in prose.
 *
 * Fenced blocks are skipped: `#` inside one is content, not a heading.
 */
/**
 * How many raw insights a block is allowed to spend on the prompt.
 *
 * A company's own are worth the room. Its sector's are backdrop, there can be
 * two of them, and thirty days of raw industry chatter would outweigh the
 * company's entire dossier — so they are capped, newest kept.
 */
const INSIGHTS_IN_PROMPT: Record<DistillDossierBlock['kind'], number> = {
  company: 25,
  sector:  8,
};

/** `2026-08-27 · wired.com — Title: statement` */
function insightLine(i: DistillInsight): string {
  const when   = i.at ? i.at.slice(0, 10) : 'undated';
  const source = [i.sourceName, i.documentTitle].filter(Boolean).join(' — ');
  const body   = i.content.replace(/\s+/g, ' ').trim();
  return `- ${when}${source ? ` · ${source}` : ''}: ${body}`;
}

/**
 * The raw material a dossier does not reproduce.
 *
 * Two things the reader has to know and cannot infer. These are *unsynthesised*
 * — single statements that passed no editorial fold — so they do not carry the
 * weight the dossier prose does. And they are not simply "today": Distill
 * excludes by provenance, not by date, so a document that arrived late and
 * never made it into the window's text shows up here with its original date.
 * That is the same class of item that marks a dossier stale.
 */
function distillInsights(block: DistillDossierBlock): string {
  const all = block.insights?.items ?? [];
  if (all.length === 0) return '';

  const cap  = INSIGHTS_IN_PROMPT[block.kind];
  const kept = all.length > cap ? all.slice(-cap) : all;
  const more = block.insights?.truncated || kept.length < all.length;

  const heading = block.content?.trim()
    ? 'Raw source statements the dossier above does NOT reproduce'
    : 'No dossier has been built for this entity yet — the following raw source statements are all there is';

  return `
**${heading}** (${kept.length}, oldest first, dated by when the news is from rather than
when Distill saw it). Unsynthesised and unfiltered: weigh a single one as a single
source.${more ? missingNote(block, all, kept) : ''}

${kept.map(insightLine).join('\n')}`;
}

/**
 * What is missing from the list, said as a span when the span is known.
 *
 * Both cuts drop the *oldest* statements: Distill's `insight_limit` upstream and
 * the per-kind cap here. So the gap sits before the first line shown, usually
 * right behind the dossier's window — the one place a reader would otherwise
 * assume nothing happened. From 16 to 23 September 2026 that was 87 statements
 * about Nvidia (distill#168).
 */
function missingNote(block: DistillDossierBlock, all: DistillInsight[], kept: DistillInsight[]): string {
  const upstream = block.insights?.omitted ?? null;
  const cutHere  = all.length - kept.length;
  const count    = (upstream?.count ?? 0) + cutHere;
  const from     = upstream ? upstream.from : cutHere > 0 ? all[0].at : null;
  const to       = cutHere > 0 ? all[cutHere - 1].at : upstream?.to ?? null;
  if (count === 0 || !from || !to) {
    return ' More exist than are shown — absence here is not evidence of absence.';
  }
  return ` ${count} older statements from ${from.slice(0, 10)} to ${to.slice(0, 10)} are not`
    + ' shown — absence in that span is not evidence of absence.';
}

/**
 * How current the prose is, in the words the model needs.
 *
 * A bare `stale` used to be rendered as "a late document landed in a built tile;
 * the window above still holds" — also when the dossier was twelve days old
 * because Distill's sweep had not run (distill#168). The reason decides the
 * sentence now, and a dossier more than a day behind is said to be out of date
 * in a paragraph of its own, not in a trailing clause.
 */
function freshnessNote(block: DistillDossierBlock): { inline: string; paragraph: string } {
  const reasons = block.staleReasons ?? [];
  const behind  = block.behindDays ?? null;
  if (block.state === 'outdated' || (behind !== null && behind > 1)) {
    const days = behind !== null ? `${behind} days` : 'more than a day';
    const end  = block.periodEnd ? ` on ${block.periodEnd.slice(0, 10)}` : '';
    return {
      inline: '',
      paragraph: `**Out of date:** this dossier ends${end}, ${days} behind today, and Distill has`
        + ' not rebuilt it since. Read it as background up to its end; anything newer is only in'
        + ' the raw statements below.',
    };
  }
  if (reasons.includes('window_moved') && behind === 1) {
    return { inline: " · a day behind until Distill's nightly build; the raw statements below cover it", paragraph: '' };
  }
  if (!block.stale) return { inline: '', paragraph: '' };
  // No reasons: a bundle stored before Distill gave them, or a reason this
  // client does not know yet. The old sentence is the best it can say.
  if (reasons.length === 0 || reasons.every((r) => r === 'late_material')) {
    return { inline: ' · marked stale upstream (a late document landed in a built day; the window above still holds)', paragraph: '' };
  }
  return {
    inline: ' · marked stale upstream (part of its material was rebuilt or reassigned since; the window above still holds)',
    paragraph: '',
  };
}

/** One dossier block, headed by what it is *about* — see `distillDossierSection`. */
function distillBlock(block: DistillDossierBlock, symbol: string): string {
  const window = block.periodStart && block.periodEnd
    ? `Window ${block.periodStart.slice(0, 10)} to ${block.periodEnd.slice(0, 10)} (end exclusive)`
    : 'Window unknown';
  const built = block.builtAt ? ` · built ${block.builtAt.slice(0, 10)}` : '';

  const scope = block.kind === 'sector'
    ? `**Scope: the ${block.displayName} sector as a whole — NOT ${symbol}.** `
      + 'Use it as the backdrop the company is read against: what is true of the sector is not '
      + 'thereby true of this company, and a sector-level claim never becomes a company-level '
      + 'finding. Where the company diverges from its sector, that divergence is the signal.'
    : `**Scope: ${symbol} itself.**`;

  const fresh = freshnessNote(block);
  const prose = block.content?.trim()
    ? `\n${window}${built}${fresh.inline}${fresh.paragraph ? `\n\n${fresh.paragraph}` : ''}\n\n${demoteHeadings(block.content.trim(), 3)}`
    : '';

  return `#### ${block.kind === 'sector' ? 'Sector' : 'Company'} — ${block.displayName} (\`${block.ref}\`)

${scope}${prose}
${distillInsights(block)}`.trimEnd();
}

/**
 * Everything Distill has to say, as two sections that cannot be read as one.
 *
 * The split is the point. Company and sector prose used to sit under a single
 * heading that declared its contents "your strongest qualitative signal", and
 * each sector block then spent a paragraph walking that back. In a prompt,
 * structure outweighs prose: material filed under a strong-weight heading reads
 * as strong-weight material however the sentences hedge. So the sectors get
 * their own section, headed as background, placed after.
 *
 * The company section no longer claims weight either. It called the material
 * "curated, multi-source" and "vetted RSS, earnings transcripts, sell-side
 * research" and ranked it above Perplexity. Distill's own audit (27 Sept 2026)
 * found 86 % of its statements coming from YouTube commentators, most daily
 * dossier tiles passed through unedited, and promotional segments getting in
 * (distill#171, distill#199). It is commentary to learn what is being said, and
 * the section now says so.
 *
 * It also answers the volume problem the labelling alone could not. Two sector
 * dossiers routinely outweigh a company's several times over — Airbus has 2.9k
 * characters of its own against 20k of industry — and length is a signal in
 * itself. Under a heading that says "background", length reads as thoroughness
 * about the backdrop rather than as importance to the company.
 */
export function distillDossierSection(symbol: string, distill?: DistillBundle): string {
  if (!distill) return '';

  // A block with no dossier text but with insights still carries material —
  // that is exactly the just-switched-on entity the paid briefing used to cover.
  const carries = (b: DistillDossierBlock | null | undefined): b is DistillDossierBlock =>
    !!b && (!!b.content?.trim() || (b.insights?.items.length ?? 0) > 0);

  const company  = carries(distill.company) ? distill.company : null;
  const sectors  = (distill.sectors ?? []).filter(carries);
  const briefing = distill.briefing;
  if (!company && sectors.length === 0 && !briefing) return '';

  const briefingBlock = briefing
    ? `
#### Briefing — ${briefing.briefingTypeName} (${briefing.createdAt.slice(0, 10)}, ${briefing.insightCount} insights)

**Scope: ${symbol} itself.** A synthesis stored from an earlier run.

${demoteHeadings(briefing.body.trim(), 3)}`
    : '';

  const companySection = company || briefing
    ? `
### Distill Dossier — ${symbol} (aggregated commentary and news — not verified, not ranked above other sources)

Condensed by Distill from the channels, feeds and newsletters it follows — a mix
of news and commentary, much of it from individual commentators. Distill keeps
statements that carry a claim; it does not check whether they are true. Weigh it
like the web research, not above it: it tells you what is being said about
${symbol}, not whether it holds.

- **An opinion stays an opinion.** "Undervalued" or "the next winner" from a
  channel is that channel's view, however confidently it is phrased.
- **Repetition is not confirmation.** One channel saying it on three days is one
  source, and so is a dossier sentence built from those three.
- **A number or an event needs a second source** — the financial data, the
  consensus or the web research — before it carries a finding on its own.
- **Promotion can slip through.** A pitch with an offer, a discount code or a
  "sponsored segment" is marketing, not evidence.
- Where it contradicts the calculated models or the analyst consensus, surface
  the divergence in the bull or bear case — as a question to check, not as a
  verdict.

The block carries two kinds of thing. The **dossier** condenses the last 30 days
of these statements; on a quiet day it is the day's statements themselves,
unedited. The **raw source statements** beneath it are single items the dossier
does not reproduce — that includes today, which no dossier window covers, but
also older material that arrived late. Treat one raw statement as one source.
${company ? `\n${distillBlock(company, symbol)}\n` : ''}${briefingBlock}
`
    : '';

  const sectorSection = sectors.length > 0
    ? `
### Sector Context — ${sectors.map((b) => b.displayName).join(', ')} (background, NOT about ${symbol})

Distill dossiers for the *industries* ${symbol} sits in. They are here to give
you the backdrop the company is read against, and nothing in them is a fact
about ${symbol}. A sector-wide headwind is a reason to check whether this
company shares it — never a finding that it does. Where ${symbol}'s own numbers
diverge from its sector's narrative, that divergence is the signal, and it is
worth more than either block on its own.

These blocks are usually longer than the company's own dossier, because an
industry generates more text than one firm. **Length here is not weight.**
${sectors.map((b) => `\n${distillBlock(b, symbol)}\n`).join('')}`
    : '';

  return `${companySection}${sectorSection}`;
}


export function demoteHeadings(md: string, by: number): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (_, hashes: string) =>
        '#'.repeat(Math.min(6, hashes.length + by)));
    })
    .join('\n');
}

function optionsSection(s: MarketSignals): string {
  const o = s.options;
  if (!o) return `**Optionsmarkt**\n- Keine liquide Optionskette verfügbar`;
  const move = o.nextEarningsImpliedMove
    ? `${signedPct(o.nextEarningsImpliedMove.pct)} (expiry ${o.nextEarningsImpliedMove.expirationDate})`
    : 'N/A';
  return `**Optionsmarkt**
- ATM IV (~30d): ${fmtPct(o.ivAtm30d)}  |  IV / HV90: ${fmt(o.ivVsHv90Ratio, 'x', 2)}
- Put/Call Volumen: ${fmt(o.putCallVolumeRatio, '', 2)}  |  P/C Open Interest: ${fmt(o.putCallOIRatio, '', 2)}
- Implizite Bewegung zu den nächsten Zahlen: ${move}`;
}

/**
 * Contradictions found in the payload, stated before any of the numbers they
 * affect.
 *
 * Placed first in the prompt on purpose. The failure this exists to prevent was
 * a model reading a stale P/E of 107.88x, a stale negative FCF and a stale 2.07%
 * operating margin as three independent bear arguments and writing a confident
 * SELL — each figure was plausible on its own, and nothing in the prompt said
 * they all came from a data block three years out of date.
 */
function dataQualitySection(f: StockFinancials): string {
  const warnings = f.dataQualityWarnings ?? [];
  if (warnings.length === 0) return '';

  const errors = warnings.filter((w) => w.severity === 'error');
  const notes  = warnings.filter((w) => w.severity === 'warn');
  const line = (w: typeof warnings[number]) => `- **${w.code}** (${w.fields.join(', ')}): ${w.message}`;

  return `### ⚠ Data Quality — READ BEFORE USING THE NUMBERS BELOW

Automated cross-checks found ${warnings.length} problem${warnings.length === 1 ? '' : 's'} in this payload${
  errors.length > 0 ? `, ${errors.length} of them invalidating` : ''
}. These are contradictions *between* fields, so the individual figures below still look plausible — that is exactly why they need flagging.

${errors.length > 0 ? `**Invalidating — do not build a conclusion on the listed fields:**
${errors.map(line).join('\n')}
` : ''}${notes.length > 0 ? `**Qualifying — usable, but temper the conclusion:**
${notes.map(line).join('\n')}
` : ''}
How to handle this:
- Any model whose inputs appear in an invalidating finding is **out of evidence**, however precise its output looks. Say so explicitly in the bear or bull case instead of quoting the number.
- Prefer the annual statement series (revenue/EPS/FCF history) over trailing figures wherever they conflict.
- Reduce conviction: a flagged payload does not support a STRONG BUY or STRONG SELL. Widen the fair-value range to reflect what you cannot verify.
- Never present a flagged figure as a finding of fact about the company. "Reported FCF is negative" is a statement about the data, not about the business.
`;
}

function macroSection(s: MarketSignals): string {
  const m = s.macro;
  return `**Makro**
- VIX ${fmt(m.vix, '', 1)} (${m.vixRegime})  |  SPY 3M ${signedPct(m.spy3MReturn)}
- Zinskurve 10J−2J ${bps(m.yieldCurve2Y10Y)}  |  HY-Spread ${bps(m.hySpreadBps)}
- DXY ${fmt(m.dxyLevel, '', 1)} (3M ${signedPct(m.dxyChange3MPct)})
- Sektor-ETF ${m.sectorEtfSymbol ?? 'nicht zugeordnet'} 3M ${signedPct(m.sectorEtfReturn3M)}`;
}

// ─── The three prompts ───────────────────────────────────────────────────────
//
// The analysis used to be one call: eight thousand tokens of models, ratios,
// technicals, dossiers and search results, and a request at the bottom for a
// score. Which evidence carried the day was then a property of that particular
// model on that particular evening.
//
// It is three calls now, and the split is the point:
//
//   1. **Data summary** — a cheap model turns the *already scored* factor card
//      into prose. It cannot weigh anything, because the weighing happened in
//      `analysis/score.ts` before the call was made. What it may talk about is
//      what the score card's findings list contains, which is decided by impact.
//   2. **Narrative** — a cheap model reads the qualitative sources and nothing
//      else. No price, no multiples, no fair value: a summariser that can see
//      the valuation will read the news as confirming it, which is precisely
//      the contamination the single call suffered from.
//   3. **Synthesis** — the expensive model gets the two short summaries and the
//      pillar table, and writes the thesis. It does not set the score; it may
//      move the blended one by up to a point, with a reason on the record.

/**
 * What the score does not look at.
 *
 * The six pillars cover valuation, quality, balance sheet, consensus, momentum
 * and revisions. This block carries the rest — the market's own expectations,
 * the positioning, the macro regime and the calendar. It is context for the
 * prose, not an input to the number, and it says so.
 */
function contextSection(f: StockFinancials, d: PromptData): string {
  const cur = f.tradingCurrency;
  const P = (n: number | null | undefined) => fmtPrice(n, cur);
  const im = d.reverseDCF.impliedMargin;
  const ev = d.evMultiples;

  const seasonal = ev.seasonalGap !== null && Math.abs(ev.seasonalGap) > SEASONAL_GAP_THRESHOLD
    ? `\n- ⚠ SVR liegt ${signedPct(ev.seasonalGap)} neben dem saisonbereinigten Wert — das jüngste Quartal ist ein saisonales ${ev.seasonalGap < 0 ? 'Hoch' : 'Tief'} oder enthält einen Sondereffekt.`
    : '';

  const estimates = f.earningsEstimates.length > 0
    ? f.earningsEstimates.map((e) => {
        const label: Record<string, string> = { '0q': 'Lfd. Quartal', '+1q': 'Nächstes Quartal', '0y': 'Lfd. Jahr', '+1y': 'Nächstes Jahr' };
        const eps = e.epsEstimate !== null ? `EPS ${P(e.epsEstimate)}` : 'EPS N/A';
        const growth = e.epsGrowth !== null ? ` (${signedPct(e.epsGrowth)} YoY)` : '';
        const rev = e.revenueEstimate !== null ? `, Umsatz ${fmtBig(e.revenueEstimate, cur)}${e.revenueGrowth !== null ? ` (${signedPct(e.revenueGrowth)} YoY)` : ''}` : '';
        return `  - ${label[e.period] ?? e.period}: ${eps}${growth}${rev}`;
      }).join('\n')
    : '  - Keine Konsensschätzungen verfügbar';

  return `### Weiterer Kontext (fließt NICHT in den Score ein — Material für die Prosa)

**Was der Kurs bereits unterstellt**
- Reverse DCF: ${d.reverseDCF.isPossible && d.reverseDCF.impliedGrowthRate !== null
    ? `${fmtPct(d.reverseDCF.impliedGrowthRate)} Umsatzwachstum in den ersten zwei Jahren (auslaufend) bei WACC ${fmtPct(d.reverseDCF.discountRate)}${d.reverseDCF.consensusGrowth !== null ? `, Konsens ${fmtPct(d.reverseDCF.consensusGrowth)}` : ''}`
    : 'nicht berechenbar'}
- Verlangte Marge: ${im
    ? `Der heutige Kurs verlangt eine operative Zielmarge von ${fmtPct(im.requiredMargin)} auf ${fmtBig(im.revenueBase, cur)} Umsatz bei ${fmtPct(im.revenueGrowth)} Wachstum (${im.growthSource}); gezeigt wurden bestenfalls ${fmtPct(im.achievableMargin)} (${im.achievableBasis ?? '—'}). ${im.interpretation}`
    : 'nicht berechenbar'}${seasonal}

**Kursbild**
- Renditen: 1M ${signedPct(d.marketSignals.technicals.returns.m1)} | 3M ${signedPct(d.marketSignals.technicals.returns.m3)} | YTD ${signedPct(d.marketSignals.technicals.returns.ytd)} | 1J ${signedPct(d.marketSignals.technicals.returns.y1)}
- RSI14 ${fmt(d.marketSignals.technicals.rsi14, '', 1)} | ATR14 ${fmtPct(d.marketSignals.technicals.atr14Pct)} des Kurses | HV30 ${fmtPct(d.marketSignals.technicals.hv30)}
- 52W-Spanne ${P(f.fiftyTwoWeekLow)}–${P(f.fiftyTwoWeekHigh)}, Beta ${fmt(f.beta)}

${optionsSection(d.marketSignals)}

${macroSection(d.marketSignals)}

**Positionierung**
- Short-Quote ${f.shortPercentOfFloat !== null ? fmtPct(f.shortPercentOfFloat) : 'N/A'} des Free Float, Days to Cover ${fmt(f.shortRatio, ' Tage', 1)}
- Institutionell ${f.institutionsPercentHeld !== null ? fmtPct(f.institutionsPercentHeld) : 'N/A'} | Insider ${f.insidersPercentHeld !== null ? fmtPct(f.insidersPercentHeld) : 'N/A'}
- Insider-Transaktionen (6M): ${(f.insiderBuyCount ?? 0) > 0 || (f.insiderSellCount ?? 0) > 0
    ? `${f.insiderBuyCount ?? 0} Käufe, ${f.insiderSellCount ?? 0} Verkäufe`
    : 'keine'}

**Konsensschätzungen**
${estimates}
- Nächste Zahlen: ${f.nextEarningsDate ?? 'unbekannt'}`;
}

/** Shared tail for the two prose stages, so the register cannot drift apart. */
const GERMAN_STYLE = `**Sprache: Deutsch.** Register einer Sell-Side-Research-Notiz:
direkt, zahlengestützt, ohne Floskeln. Keine Hedging-Verben ("könnte",
"möglicherweise"), keine Erzählkonnektoren ("erstens … schließlich"). Etablierte
Fachbegriffe bleiben englisch (*Free Cash Flow*, *EBITDA*, *DCF*, *Margin of
Safety*, *Piotroski*), Zahlen behalten die englische Schreibweise ("$1.2B",
"23.4%", "1.8x").`;

/**
 * Stage 1 — turn the scored card into readable prose.
 *
 * The instruction that matters is the negative one: this model does not judge.
 * It arrived after the judgement and its job is to make the judgement legible,
 * which is why the task says "erkläre" and never "bewerte".
 */
export function buildDataSummaryPrompt(f: StockFinancials, card: string, d: PromptData): string {
  const cur = f.tradingCurrency;
  const dataQuality = dataQualitySection(f);

  return `## ${f.symbol} — ${f.companyName}

Kurs ${fmtPrice(f.price, cur)} · Marktkapitalisierung ${fmtBig(f.marketCap, cur)} · ${f.sector ?? 'N/A'} / ${f.industry ?? 'N/A'}
${dataQuality ? `\n${dataQuality}` : ''}
${card}

${contextSection(f, d)}

---

**Deine Aufgabe: den quantitativen Befund lesbar machen — nicht ihn bewerten.**

Der Score oben steht fest. Er wurde im Code berechnet, bevor dieser Aufruf
begann, und du kannst ihn weder ändern noch anfechten. Was du beiträgst, ist die
Erklärung: warum diese Zahl, in Sätzen, die jemand ohne die Tabelle versteht.

Regeln:
- Halte dich an die **Befunde**. Sie sind nach Einfluss sortiert; was dort nicht
  steht, hat den Score nicht bewegt und gehört nicht in die Zusammenfassung.
- Nenne in jedem Satz eine konkrete Zahl aus der Karte oder dem Kontextblock.
- Divergenzen sind die interessanteste Zeile, die du hast — wenn zwei Säulen sich
  widersprechen, sag das ausdrücklich, statt es zu glätten.
${dataQuality ? `- Die Datenqualitätsbefunde oben sind Aussagen **über die Daten**, nie über das
  Unternehmen. "Der ausgewiesene FCF ist negativ" ist erlaubt; "das Unternehmen
  verbrennt Geld" ist es nicht.\n` : ''}- Keine Kauf-/Verkaufsempfehlung, keine Kursziele, keine Prognose.

${GERMAN_STYLE}

Antworte als JSON:
{
  "summary": "4–6 Sätze, die den Score erklären: was ihn trägt, was ihn drückt, was unsicher bleibt."
}`;
}

/**
 * Stage 2 — the qualitative read, deliberately blind to the valuation.
 *
 * No price, no multiple, no fair value appears in this prompt. A summariser that
 * knows the stock looks cheap will find the news encouraging; one that knows it
 * looks expensive will find the same news worrying. Withholding the number is
 * the only way the score it returns is worth blending with the other one.
 */
export function buildNarrativePrompt(
  f: StockFinancials,
  distill?: DistillBundle,
  perplexity?: PerplexityContext,
): string {
  const distillSection = distillDossierSection(f.symbol, distill);
  // The structured brief reads differently from the old free prose, and the
  // summariser has to know which of its three parts carries weight: a bull claim
  // marked contradicted is the strongest thing on the page, a company-sourced
  // event the weakest.
  const pplx = !perplexity ? ''
    : perplexity.findings
      ? `
### Forensische Web-Recherche (Perplexity — gezielt nach dem gefragt, was die Zahlen nicht zeigen)

Die Teile wiegen nicht gleich. **Ereignisse** sind datierte Fakten. Die **Belege gegen
die Bullen-These** sind das Ergebnis einer ausdrücklichen Suche nach dem, was die
Optimisten übersehen. Die **geprüften Bullen-Thesen** sagen, welche verbreiteten
Argumente unabhängig belegt, nur vom Management behauptet oder widerlegt sind — eine
widerlegte These ist das stärkste Signal auf dieser Seite, eine reine Management-Aussage
das schwächste. Die **geprüften Bären-Thesen** sind die Argumente der Skeptiker, ebenso
geprüft; „bisher nur Meinung" heißt, dass noch nichts sie belegt. Einträge aus einer
Unternehmensquelle wiegen weniger als unabhängige. Leere Abschnitte heißen „gesucht und
nichts gefunden", nicht „nicht gesucht".

${perplexity.synthesis}
`
      : `\n### Perplexity Sonar (web-recherchiert)\n\n${perplexity.synthesis}\n`;

  return `## Qualitative Lage: ${f.symbol} — ${f.companyName}
Sektor ${f.sector ?? 'N/A'} / ${f.industry ?? 'N/A'}
${distillSection}${pplx}
---

**Deine Aufgabe: lies diese Quellen und sonst nichts.**

Du bekommst bewusst keinen Kurs, kein Multiple und keinen Fair Value. Deine
Bewertung soll beantworten, wie sich das Geschäft laut diesen Quellen entwickelt
— nicht, ob die Aktie günstig ist. Die Bewertungsfrage wird an anderer Stelle
deterministisch beantwortet und danach mit deiner zusammengeführt.

Bewerte die **Geschäftsentwicklung, wie die Quellen sie beschreiben**, und zwar
getrennt in fünf Dimensionen. Den Gesamtwert rechnet danach der Code aus — du
setzt keine Gesamtnote.

| Dimension    | Frage |
|--------------|-------|
| \`demand\`     | Wie entwickeln sich Nachfrage, Aufträge, Umsatz? |
| \`position\`   | Gewinnt oder verliert das Unternehmen gegenüber Wettbewerbern, Kunden, Lieferanten? |
| \`execution\`  | Liefert das Management, was es angekündigt hat? Führung, Kapitalallokation, Margen-Umsetzung |
| \`regulation\` | Regulierung, Recht, Politik, Zölle — was davon ist **entschieden** und trifft das Geschäft? |
| \`product\`    | Produktzyklus, Pipeline, Technologie |

Skala je Dimension:
- **+2 / −2** — nur für etwas, das bereits in den Zahlen steht oder entschieden
  ist: ein unterschriebener Auftrag, ein verlorener Großkunde, ein Verbot in Kraft,
  ein Rückruf, ein verfehltes Quartal. Datiert.
- **+1 / −1** — eine klare Richtung, von unabhängigen Quellen berichtet, aber noch
  nicht in den Ergebnissen; oder eine reine Unternehmensaussage.
- **0** — gemischt, oder nichts bewegt diese Dimension spürbar.
- **null** — die Quellen sagen dazu nichts. Eine ehrliche Lücke ist brauchbar,
  eine erfundene 0 nicht.

Regeln:
- **Bewertung gehört nicht hierher.** Kurs, KGV, Multiples, Kursziele und
  Analystenratings, die in den Quellen auftauchen, fließen in keine Dimension —
  das wird an anderer Stelle gemessen.
- **Die forensische Recherche hat gezielt nach Belegen gegen die Bullen-These
  gesucht.** Dass sie welche findet, ist erwartet und für sich kein Signal —
  bewerte, *was* sie gefunden hat. Eine eröffnete Untersuchung, eine Klage oder
  ein Risiko ist höchstens −1; −2 erst, wenn es entschieden ist und trifft.
- **Sektor-Dossiers sind Hintergrund, keine Aussage über dieses Unternehmen.**
  Ein Branchengegenwind ist ein Grund nachzusehen, ob die Firma ihn teilt — kein
  Befund, dass sie ihn teilt.
- Rohe Einzelmeldungen wiegen als eine Quelle, nicht als ein Trend.
- **Distill ist gesammelter Kommentar, keine geprüfte Quelle.** Die Einschätzung
  eines einzelnen Kanals oder Newsletters trägt für sich weder ±2 noch ±1 —
  dafür braucht es einen datierten Vorgang oder eine zweite, unabhängige Quelle.
  Wiederholt dieselbe Quelle etwas, bleibt es eine Quelle.
- **Eine These ist kein Befund.** Bullen- und Bären-Thesen sind Argumente; als
  Meinung tragen sie keine Dimension, nur was sie belegt oder widerlegt.
- \`events\` sind konkrete, datierte Vorgänge (Auftrag, Zulassung, Rückruf,
  Personalwechsel, Kapitalmaßnahme) — keine Einschätzungen.
- \`theses\` sammelt die Argumente, die in den Quellen für (\`bull\`) und gegen
  (\`bear\`) das Unternehmen vertreten werden — je Seite bis zu 4, so wie eine
  Investment-Debatte sie führt: Treiber → was er mit dem Geschäft macht → warum es
  zählt. Sag in einem Halbsatz, wer es vertritt oder was es belegt (unabhängige
  Recherche, Management, ein Kommentar), und führe eine widerlegte Bullen-These als
  Bären-Argument. Nur Geschäft, keine Bewertung. Steht für eine Seite nichts in den
  Quellen, bleibt sie leer.

${GERMAN_STYLE}

Antworte als JSON:
{
  "summary": "4–6 Sätze zur qualitativen Lage.",
  "events":  ["bis zu 5 datierte, konkrete Vorgänge"],
  "theses":  { "bull": ["bis zu 4 Argumente"], "bear": ["bis zu 4 Argumente"] },
  "dimensions": {
    "demand":     { "rating": -2, -1, 0, 1, 2 oder null, "note": "Beleg in einem Halbsatz" },
    "position":   { "rating": ..., "note": "..." },
    "execution":  { "rating": ..., "note": "..." },
    "regulation": { "rating": ..., "note": "..." },
    "product":    { "rating": ..., "note": "..." }
  }
}`;
}

/** The arguments the narrative stage collected, as the synthesis reads them. */
function thesesBlock(t: NarrativeTheses | undefined): string {
  if (!t || (t.bull.length === 0 && t.bear.length === 0)) return '';
  const side = (title: string, items: string[]) =>
    `\n${title}:\n${items.length ? items.map((x) => `- ${x}`).join('\n') : '- keine in den Quellen'}`;
  return `\n\nThesen aus den Quellen (ohne Kenntnis der Bewertung gesammelt):${side('Bull', t.bull)}${side('Bear', t.bear)}`;
}

export interface SynthesisInputs {
  /** Brief factor card: pillars, caps and findings, without the criteria detail. */
  card:      string;
  dataNote:  string | null;
  narrative: {
    summary: string; events: string[]; score: number | null; sources: string[];
    /** The arguments the sources make, per side — the raw material for the theses. */
    theses?: NarrativeTheses;
  } | null;
  /** The Perplexity findings, compact — what the bull and bear cases may cite beyond the summary. */
  research?: string | null;
  /** How the code will combine the two, stated before the model answers. */
  blendNote: string;
}

/**
 * Stage 3 — the thesis, and a bounded correction.
 *
 * The model is told the arithmetic that will produce the headline *before* it
 * answers, which is what keeps `adjustment` an argued exception rather than an
 * opinion competing with the score. The bound is small on purpose: a point is
 * one band, and anything a model can justify beyond that belongs in a pillar.
 */
export function buildSynthesisPrompt(f: StockFinancials, s: SynthesisInputs): string {
  const cur = f.tradingCurrency;
  const sym = currencyPrefix(cur);

  const narrative = s.narrative
    ? `### Qualitative Zusammenfassung (aus Distill/Perplexity, ohne Kenntnis der Bewertung)

Quellen: ${s.narrative.sources.join(', ') || 'keine'}
Narrativ-Score: ${s.narrative.score === null ? 'Enthaltung — die Quellen trugen zu wenig' : `${s.narrative.score.toFixed(1)}/10`}

${s.narrative.summary}
${s.narrative.events.length > 0 ? `\nKonkrete Vorgänge:\n${s.narrative.events.map((e) => `- ${e}`).join('\n')}` : ''}${thesesBlock(s.narrative.theses)}`
    : `### Qualitative Zusammenfassung

Keine — für dieses Unternehmen lagen weder Distill-Dossier noch Perplexity-Recherche vor.
Der Score ruht damit allein auf der Arithmetik. Die Thesen stützen sich dann nur auf
das Geschäftsmodell; sag in den Bear-Thesen, dass aktuelle Quellen fehlen.`;

  const research = s.research
    ? `### Recherche-Befunde (Perplexity, gezielt nach dem gesucht, was die Zahlen nicht zeigen)\n\n${s.research}`
    : '';

  return `## ${f.symbol} — ${f.companyName}

Kurs ${fmtPrice(f.price, cur)} · Marktkapitalisierung ${fmtBig(f.marketCap, cur)} · ${f.sector ?? 'N/A'}

${s.card}

${s.dataNote ? `### Quantitative Zusammenfassung\n\n${s.dataNote}` : ''}

${narrative}

${research}

### So entsteht der Headline-Score

${s.blendNote}

---

**Deine Aufgabe: die These schreiben. Den Score schreibst du nicht.**

Score und Empfehlung ergeben sich aus der Rechnung oben. Dein Beitrag ist der
Text — und, falls nötig, eine begründete Korrektur von höchstens ±1 Punkt.

Für \`adjustment\` gilt eine hohe Hürde. Zulässig ist sie nur, wenn die
qualitativen Quellen etwas enthalten, das **keine Säule sehen kann** und das den
Fall material verändert: eine angekündigte Übernahme, ein Regulierungsentscheid,
ein Produktrückruf, ein Wechsel im Management, eine Kapitalmaßnahme. Nicht
zulässig ist sie, wenn du die vorliegenden Zahlen bloß anders gewichten würdest —
diese Gewichtung ist bereits getroffen. Ohne solchen Anlass: \`adjustment: 0\` und
\`adjustmentReason: null\`.

Für die Texte — Bull und Bear Case sind das Erste, was ein Leser nach dem Urteil
sieht. Jede Seite hat drei Abschnitte, und jeder hat eine andere Aufgabe:
- \`theses\` (2–4 je Seite): die Investment-Debatte, wie der Markt sie führt —
  Geschäftsmodell, Nachfrage, Wettbewerb, Produkt, Management, Regulierung. Jede
  These ist eine Wirkungskette in 20–40 Wörtern: Treiber → was er mit dem Geschäft
  macht → warum es für die Aktie zählt. Höchstens eine Zahl, und nur, wenn sie die
  These trägt; Kennzahlen aus der Säulentabelle gehören nicht hierher.
  Ein Beispiel für die Form, nicht für den Inhalt: „Plattform und hohe Wechselkosten
  treiben die Ausweitung auf HR, Customer Service und Security; jeder neue Workflow
  erhöht die Ausgaben pro Kunde und macht den Abo-Umsatz planbarer."
- Material für die Thesen sind die Thesen aus den Quellen, die geprüften Bullen- und
  Bären-Thesen und die Gegenbelege. Eine widerlegte Bullen-These ist ein
  Bear-Argument. Strukturelle Thesen zum Geschäftsmodell (Wechselkosten,
  Netzwerkeffekte, Zyklik, Preissetzungsmacht) darfst du aus deinem Wissen über das
  Unternehmen formulieren; alles Aktuelle — Vorgänge, Trends, Zahlen — nur aus den
  Quellen oben.
- \`figures\` (1–3 je Seite): was die Zahlen für diese Seite sagen — Bewertung,
  Qualität, Wachstum, Konsens, Momentum. Je Punkt die Zahl mit ihrem Maßstab und in
  einem Halbsatz, was sie bedeutet, 15–30 Wörter.
- \`triggers\` (1–2 je Seite): konkrete, beobachtbare Auslöser, die das Urteil in
  diese Richtung verschieben würden — auf der Bull-Seite nach oben, auf der
  Bear-Seite nach unten: eine Kennzahl, die eine Schwelle kreuzt, eine terminierte
  Entscheidung, ein Quartal. Schreib nur die Bedingung, ohne „wenn" und ohne Pfeil —
  die Überschrift sagt die Richtung. Keine allgemeinen Risiken.
- **Risiken gehören in die Bear-Thesen**, nicht in eine eigene Liste: was noch nicht
  eingetreten ist, aber den Fall brechen würde, mit dem, was es auslöst.
- Führe in jedem Abschnitt mit dem stärksten Punkt. Keine Konnektoren zwischen den
  Punkten, und kein Punkt sagt, was ein anderer schon gesagt hat.
- Widersprechen sich die quantitative und die qualitative Seite, gehört dieser
  Widerspruch in \`thesis\` oder auf die Bear-Seite. Er ist die wertvollste
  Information auf dieser Seite, nicht ein Problem, das zu glätten wäre.
- Die Fair-Value-Spanne wird **nicht** von dir gesetzt — sie ist die Spanne der
  Modelle, die sie erzeugt haben, und steht bereits fest. Erfinde keine.

${GERMAN_STYLE}

Antworte als JSON:
{
  "bullCase": {
    "theses":   ["2–4 Wirkungsketten"],
    "figures":  ["1–3 Punkte aus den Zahlen"],
    "triggers": ["1–2 Bedingungen, die das Urteil heben würden"]
  },
  "bearCase": {
    "theses":   ["2–4 Wirkungsketten, Risiken eingeschlossen"],
    "figures":  ["1–3 Punkte aus den Zahlen"],
    "triggers": ["1–2 Bedingungen, die das Urteil senken würden"]
  },
  "thesis":           "ein Satz",
  "adjustment":       -1 bis +1,
  "adjustmentReason": "warum — oder null bei 0"
}`;
}
