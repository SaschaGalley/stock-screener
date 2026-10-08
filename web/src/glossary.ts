import { SCORE_BANDS } from '../../src/verdict.js';
import type { NarrativeDimension, PillarKey } from '../../src/types.js';
import type { TrendRatioKey } from '../../src/analysis/trends.js';
import type { HistoryMultiple } from '../../src/analysis/valuation-history.js';
// The `.js` endings are for the server's typecheck, which reads this file
// through `test/glossary.test.ts`; Vite resolves them to the `.ts` sources.

/**
 * What a number means — the ⓘ beside it.
 *
 * One place for every explanation, so a figure that appears in the header, the
 * fundamentals grid and the peer table says the same thing in all three.
 *
 * Where the figure is a stored metric, the key is the metric catalogue's own
 * (`financials.peRatio`, `metrics.dcf.fairValue`): the catalogue derives from
 * the zod schemas, and `test/glossary.test.ts` checks every such key against
 * it, so renaming a field cannot leave its explanation pointing at nothing.
 * What has no single series behind it — a section, a column, a way of reading
 * — takes a prefix of its own: `section.`, `concept.`, `list.`, `tech.`.
 *
 * The schemas' own descriptions say how a field is computed, in English and for
 * whoever maintains the code. These say what it means for the reader and how to
 * read it, and repeat the computation only where it changes the reading.
 */

const num = (n: number) => n.toLocaleString('de-DE');

/** The bands as the verdict reads them, from the one table that defines them. */
const BANDS = SCORE_BANDS
  .map((b) => (Number.isFinite(b.min) ? `ab ${num(b.min)} ${b.verdict}` : `darunter ${b.verdict}`))
  .join(', ');

export const GLOSSARY = {
  // ── The list ──────────────────────────────────────────────────────────────
  'list.score':
    `Gesamtscore 0–10. Er mischt eine deterministische Bewertung aus den gespeicherten Zahlen (Z) mit einer Lektüre der Research-Texte (T), gewichtet nach dem Vertrauen in beide. Bänder: ${BANDS}. Der Pfeil links zeigt die Veränderung seit dem ersten gespeicherten Urteil.`,
  'list.verdict':
    'Das Urteil ist das Band, in das der Score fällt. ⛔ heißt: Ein Deckel hält es bewusst darunter, etwa wegen schwacher Datenlage. Auf Hover: was das Urteil im Backtest brachte, über wie viel Prozent aller gespeicherten Aktien der Faktor-Score liegt — das trennt eine HOLD am oberen Rand von einer am unteren — und welches Modell die Texte gelesen hat.',
  'list.timing':
    'Wo der Kurs in seinem Chart steht: Richtung des 3-Monats-Kanals und an welchem Rand er ist; die Rendite des letzten Monats und der RSI stehen auf Hover. Ein Kästchen daneben nennt ein Setup, das heute auslöst — mit Stop, Ziel, Positionsgröße, Risiko und dem, was es im Backtest gegen einen Zufallseinstieg mit denselben Abständen brachte (grün umrandet nur, wenn es dort trug). Auf Hover steht jede Lesart neben dem, was der Backtest bei Aktien mit demselben Urteil dazu fand. Fließt nicht in Score und Urteil ein.',
  'list.price': 'Letzter Schlusskurs, in der Währung, in der die Aktie gehandelt wird.',
  'list.target': 'Abstand des mittleren Analysten-Kursziels (Yahoo-Konsens) zum Kurs; das Kursziel selbst auf Hover.',
  'list.modelFv':
    'Fairer Wert laut Bewertungsmodellen: der Primary-Composite aus DCF, Peer-Multiples, Peter Lynch und Analystenziel. Gezeigt ist sein Abstand zum Kurs, der Wert selbst auf Hover. Im Backtest (S&P 1500 seit 2013, Stand Oktober 2026) hat dieser Abstand keine Rendite vorhergesagt, und der Kurs hat sich dem Wert nicht genähert: Er beschreibt die Modelle, er ist keine erwartete Rendite.',
  'list.dividend':
    'Dividenden der letzten zwölf Monate geteilt durch den Kurs; „—“ für eine Aktie ohne Dividende. In Score und Urteil fließt sie nur über das Dividendenmodell in der Value-Lens ein: Im Backtest (S&P 1500 seit 2013, Stand Oktober 2026) hat eine höhere Dividendenrendite keine höhere Rendite gebracht, auch nicht innerhalb der Branche. Was dort trägt, sind Rückkäufe, und die liest der Score schon (Netto-Aktienausgabe).',
  'list.mcap': 'Börsenwert: Kurs mal alle ausstehenden Aktien.',
  'list.age':
    'Wann zuletzt eine Textanalyse lief; wie alt die Marktdaten sind, steht auf Hover. Der Score selbst wird bei jeder Datenaktualisierung neu gerechnet.',
  'list.consensus':
    'Konsens-Streifen: Anteil Kauf (grün), Halten (gelb) und Verkauf (rot) aus unserem Urteil und den Analystenratings zusammen.',

  // ── Header ────────────────────────────────────────────────────────────────
  'financials.price': 'Letzter regulärer Schlusskurs, in der Handelswährung.',
  'financials.marketCap':
    'Börsenwert: Kurs mal alle ausstehenden Aktien, über alle Aktiengattungen. Was der Markt für das Eigenkapital zahlt.',
  'financials.enterpriseValue':
    'Unternehmenswert: Börsenwert plus Schulden minus Cash. Der Preis für das ganze Geschäft, schuldenfrei gerechnet. Er ist die Basis der EV-Multiples, die Firmen mit unterschiedlicher Verschuldung vergleichbar machen.',
  'concept.range52w':
    'Tiefster und höchster Schlusskurs der letzten 52 Wochen. Wo der Kurs darin steht, zeigt die Kursentwicklung im Chart-Tab.',
  'financials.beta':
    'Wie stark die Aktie mit dem S&P 500 mitschwingt, gemessen über fünf Jahre Monatsrenditen. 1 heißt wie der Markt, 1,5 heißt 50 % stärker, 0,5 heißt halb so stark. Über das CAPM bestimmt Beta die Eigenkapitalkosten in DCF, DDM, EPV und Residual Income.',

  // ── Verdict, composite, consensus cards ──────────────────────────────────
  'card.verdict':
    `Das Urteil zur Aktie. Der Score 0–10 fällt in ein Band: ${BANDS}. Der Balken zeigt den Score, der Text darunter ist die Begründung des Sprachmodells. Oben rechts steht, welche gespeicherte Analyse gezeigt wird; ein Klick wechselt sie oder startet eine neue.`,
  'card.composite':
    'Der faire Wert, wie ihn die Bewertungsmodelle zusammen sehen. Primary ist die Schlagzeile: wachstumsbewusste, marktnahe Modelle, nämlich DCF, Peer-Multiples, Peter Lynch und das Analystenziel. Die Mitte ist ein gewichteter Median auf logarithmischer Skala. Ein Modell bei halbem und eines bei doppeltem Kurs heben sich auf, wacklige Modelle zählen halb. Was der Abstand zum Kurs im Backtest bedeutete, steht unten in der Karte, mit den Zahlen des neuesten Laufs.',
  'card.analysts':
    'Was die Analysten sagen, die die Aktie abdecken: das mittlere Kursziel und sein Abstand zum Kurs, die Spanne der Ziele, wie einig sie sich sind, jedes Haus einzeln und die Verteilung der Ratings. Kopfzahlen aus Yahoos Konsensdaten, die Häuser einzeln aus Yahoos Rating-Historie.',
  'concept.upside':
    'Abstand zum Kurs: (Wert − Kurs) / Kurs. Positiv heißt, der Wert liegt über dem Kurs. Das ist die Sicherheitsmarge, wenn man dem Wert glaubt.',
  'concept.modelRange': 'Niedrigster und höchster Wert unter den Modellen dieses Tiers. Je weiter die Spanne, desto weniger sind sich die Modelle einig.',
  'metrics.composite.conservative.median':
    'Die Value-Linse: Modelle, die kein Wachstum unterstellen oder an Vermögen ansetzen, nämlich Graham Number, Graham V*, EPV, Residual Income und das Dividendenmodell, jeweils nur, wo sie das Geschäft beschreiben. Sie liegt meist unter Primary. Ein Kurs darunter ist ein starkes Value-Signal.',
  'metrics.composite.confidence':
    'Wie verlässlich der Composite ist, 0–10. Bis zu 5 Punkte gibt es dafür, wie viele Primary-Modelle einen Wert liefern, bis zu 5 dafür, wie eng sie beieinander liegen. Der Wert wird halbiert, wenn die Beneish-Prüfung auf geschönte Zahlen hindeutet, und ist 0 bei weniger als zwei Modellen.',
  'metrics.composite.pctPrimaryUndervalued': 'Anteil der Primary-Modelle, deren fairer Wert über dem Kurs liegt.',
  'financials.targetMeanPrice':
    'Mittleres 12-Monats-Kursziel der Analysten, aus Yahoos Konsensdaten. Vorsicht: Kursziele folgen Kursen nur langsam. Nach einem Absturz wirkt das Potenzial groß, weil die Ziele noch nicht gesenkt wurden. Im Score zählt deshalb vor allem das Rating, das Kursziel nur schwach.',
  'concept.targetRange':
    'Niedrigstes und höchstes Einzelkursziel, dazu der Median. Der Median ist robuster als der Mittelwert, wenn einzelne Häuser weit daneben liegen.',
  'concept.targetDispersion':
    'Spanne zwischen höchstem und tiefstem Kursziel, geteilt durch das mittlere. Je größer sie ist, desto weniger trägt der Mittelwert. Bis 35 % gelten die Analysten als einig, bis 70 % als gemischt.',
  'concept.ratingCounts':
    'Wie viele Analysten diesen Monat Strong Buy (SB), Buy (B), Hold (H), Sell (S) und Strong Sell (SS) empfehlen, laut Yahoos Empfehlungstrend. „bullish“ ist der Anteil von SB und B.',
  'concept.coverageStrip':
    'Jeder Punkt ist das jüngste Kursziel eines Analystenhauses aus den letzten zwölf Monaten, gefärbt nach dessen Rating und gestapelt, wo sie sich drängen. Die helle Linie ist der Kurs, die blaue das mittlere Kursziel. Hover zeigt Haus, Rating und Datum.',

  // ── How the score is built ───────────────────────────────────────────────
  'score.factor.score':
    'Die Zahlen-Hälfte: sechs Säulen aus gespeicherten Daten, jede ein gewichteter Mittelwert benannter Kriterien. Fehlende Daten kosten Abdeckung, nicht Punkte. Ist die Datenlage dünn oder fragwürdig, wird der Wert Richtung 5 gezogen, statt ihm blind zu trauen.',
  'score.narrative.score':
    'Die Text-Hälfte: Ein Sprachmodell liest Distill-Dossier und Perplexity-Recherche, ohne die Bewertung zu kennen, und schätzt fünf Dimensionen der Geschäftslage ein. Das Ergebnis ist der Median aus mehreren Lesungen. „Enthaltung“ heißt, die Quellen geben nichts her.',
  'score.final.factorWeight':
    'Mit welchem Gewicht die Zahlen- und die Text-Hälfte in den Score eingehen. Die Gewichte sind keine Einstellung, sondern die beiden Konfidenzen: Schwache Daten geben dem Text mehr Gewicht, dünne Texte geben es den Zahlen zurück.',
  'score.final.adjustment':
    'Eine begrenzte Korrektur von höchstens ±1 durch das Synthesemodell, wenn es einen Umstand sieht, den die Mischung nicht erfasst. Die Begründung steht unter „Befunde & Begründung“.',
  'concept.capped':
    'Ein Deckel hält das Label unter dem Band, das der Score allein ergäbe, etwa kein STRONG bei geringem Datenvertrauen oder bei Warnsignalen in der Bilanz. Die Zahl selbst bleibt, wie sie ist, und die Aktie bleibt in der Liste, wo ihr Score sie einsortiert.',
  'concept.pillarCell':
    'Säulen-Score 0–10. Darunter: das Gewicht der Säule im Zahlen-Score, wie viele ihrer Kriterien klar besser abschneiden als die typische Aktie des Referenzuniversums, und, falls unter 100 %, für wie viel ihres Gewichts Daten vorlagen.',
  'concept.dimension':
    'Richtung von −2 bis +2, so wie die Quellen die Lage beschreiben. „–“ heißt, die Quellen sagen dazu nichts. Hover zeigt den Beleg.',

  // ── Fair value distribution and models ──────────────────────────────────
  'section.fairValue':
    'Jeder Balken ist der faire Wert eines Modells, die gestrichelte Linie der Kurs. Grün heißt, das Modell sieht die Aktie unter Wert, rot heißt über Wert. Gefüllt ist der Primary-Tier (die Schlagzeile), umrandet die konservative Value-Linse. Hover auf einen Balken erklärt das Modell.',
  'section.valuationModels':
    'Jedes Bewertungsmodell einzeln, mit seinen Annahmen. Dazu der Peer-Vergleich und die Umkehrfrage: Was muss das Unternehmen leisten, damit der heutige Kurs aufgeht?',
  'concept.singleEquation':
    'Modelle, die einen fairen Wert aus einer Formel ableiten, jedes mit eigener Sicht: Cashflows, Gewinne, Vermögen oder Dividenden. Sie widersprechen sich oft, und genau das ist der Grund, mehrere zu zeigen.',
  'concept.vsPrice': 'Abstand des Modellwerts zum Kurs: positiv heißt unterbewertet, negativ überbewertet.',
  'metrics.dcf.fairValue':
    'Discounted Cash Flow, umsatzgetrieben. Zehn Jahre Free Cashflow an alle Kapitalgeber, aufgebaut aus Umsatzwachstum (Konsens, dann Übergang zum langfristigen Wachstum), operativer Marge und dem Kapital, das Wachstum kostet. Abgezinst wird mit den Kapitalkosten (WACC), dazu kommt ein Endwert. p10 und p90 stammen aus einer Simulation mit gestreuten Annahmen.',
  'metrics.dcf.distribution.probabilityAbovePrice':
    'Anteil der simulierten DCF-Werte über dem Kurs. Er sagt, wie robust der DCF die Aktie für günstig hält, wenn man die Annahmen variiert.',
  'metrics.grahamNumber.grahamNumber':
    'Benjamin Grahams Obergrenze für defensive Anleger: √(22,5 × Gewinn je Aktie × Buchwert je Aktie), also höchstens KGV 15 und KBV 1,5 zusammen. Sie braucht positiven Gewinn und Buchwert und wird ausgelassen, wo der Buchwert nicht das eingesetzte Kapital ist (sehr hohe Eigenkapitalrendite durch Rückkäufe).',
  'metrics.grahamRevised.fairValue':
    'Grahams Wachstumsformel V* = EPS × (8,5 + 2 × Wachstum) × 4,4 / Rendite von AAA-Anleihen. Das Wachstum ist auf 15 % gedeckelt. Höhere Zinsen drücken den Wert.',
  'metrics.peterLynch.fairValue':
    'Peter Lynchs Faustregel: Ein faires KGV entspricht der Wachstumsrate in Prozent, plus Dividendenrendite. Fairer Wert = normalisierter Gewinn je Aktie × (Wachstum + Dividende). Nur für 5–25 % Wachstum sinnvoll, zählt im Composite halb.',
  'metrics.epv.fairValue':
    'Earnings Power Value nach Greenwald: Was das Geschäft wert ist, wenn es nie mehr wächst. Nachhaltiger operativer Gewinn (Durchschnittsmarge der letzten Jahre) nach Steuern, geteilt durch die Kapitalkosten, plus Cash minus Schulden. Liegt der Kurs darunter, bezahlt man kein Wachstum.',
  'metrics.ddm.fairValue':
    'Dividendendiskontierungsmodell, zweistufig: fünf Jahre wächst die Dividende wie bisher, dann läuft sie über fünf Jahre auf das Wachstum aus, das die Firma auf Dauer hat. Dafür gilt dieselbe Regel wie im DCF: ihr eigenes Umsatzwachstum, mindestens der halbe und höchstens der ganze Anleihezins. Abgezinst wird mit den Eigenkapitalkosten, die bis Jahr zehn auf die einer reifen Firma (Beta 1) zulaufen. Nur sinnvoll, wo die Dividende der Hauptweg ist, Wert auszuschütten.',
  'metrics.rim.fairValue':
    'Residual Income bzw. Excess Return: Buchwert plus Barwert der Gewinne, die über den Eigenkapitalkosten liegen. Das passende Modell für Banken und Versicherer, deren Eigenkapital ihr Betriebskapital ist.',
  'metrics.ncav.ncavPerShare':
    'Grahams Net Current Asset Value: Umlaufvermögen minus alle Verbindlichkeiten, je Aktie. Ein Liquidationsboden. Graham kaufte erst unter zwei Dritteln davon. Für gesunde Firmen liegt er meist weit unter dem Kurs.',
  'metrics.peerMultiples.medianFairPrice':
    'Fairer Preis aus Branchen-Multiples: die Median-Multiples der Vergleichsfirmen (KGV, EV/EBITDA, KUV …) auf die eigenen Kennzahlen angewendet. Jede Kennzahl gibt eine Stimme, der Median entscheidet. Bei weniger als fünf Peers zählt das Modell im Composite halb.',
  'concept.sectorMedian': 'Median dieses Multiples über die Vergleichsfirmen (Peers von Finnhub).',
  'concept.impliedFair': 'Der Kurs, den die Aktie hätte, wenn sie zum Median-Multiple der Peers bewertet wäre.',
  'metrics.reverseDCF.impliedGrowthRate':
    'Reverse DCF: Welches Umsatzwachstum in den nächsten zwei Jahren der heutige Kurs voraussetzt, mit dem eigenen DCF gerechnet. Liegt es weit über dem, was Analysten erwarten, ist viel Optimismus eingepreist.',
  'metrics.reverseDCF.impliedMargin.requiredMargin':
    'Welche operative Marge das Unternehmen bis Jahr fünf erreichen und halten muss, damit der Kurs aufgeht, auf dem Wachstumspfad des DCF. Verglichen wird sie mit der besten Marge, die es schon gezeigt hat (heute, im Schnitt der letzten Jahre oder bei Peers).',
  'financials.analystTargetMedian': 'Median der Einzelkursziele.',

  // ── Valuation history ────────────────────────────────────────────────────
  'section.valuationHistory':
    'Die letzten fünf Jahre, Monatsende für Monatsende. Die Frage: Ist das heutige Bild für diese Aktie normal oder ungewöhnlich? Wo SEC-Filings vorliegen, wird jeder Monat mit dem damaligen Wissensstand neu durch die Modelle gerechnet, sonst aus den Geschäftsjahren.',
  'concept.vh.fair':
    'Fairer Wert gegen Kurs über fünf Jahre, mit dem Band, in dem der Abstand üblicherweise lag. Ein großer Abschlag ist nur dann ein Signal, wenn er für diese Aktie ungewöhnlich ist.',
  'concept.vh.earnings':
    'Kurs gegen Gewinn × übliches KGV (die FAST-Graphs-Sicht). Läuft der Kurs über der Gewinnlinie, ist die Aktie teurer als gewohnt; folgt er ihr, trägt das Gewinnwachstum den Kurs.',
  'concept.vh.multiples': 'Jedes Multiple über die Zeit, gegen seinen eigenen Drei- und Fünfjahres-Median.',
  'concept.vh.multiplesTable':
    'Jedes Multiple gegen seine eigene Historie und gegen die Branche. Ein Qualitätsunternehmen ist fast immer teurer als seine Branche. Die eigene Historie sagt, ob es teurer ist als sonst.',
  'concept.vh.median': 'Median dieses Multiples über die letzten drei bzw. fünf Jahre, Monatsende für Monatsende.',
  'concept.vh.vs': 'Heutiger Wert gegen den Fünfjahres-Median. Positiv (rot) heißt teurer als üblich, negativ (grün) günstiger.',
  'concept.vh.rank': 'In wie viel Prozent der Monate das Multiple niedriger war als heute. 90 % heißt: fast nie so teuer.',
  'concept.vh.impliedPrice': 'Der Kurs, wenn die Aktie heute zu ihrem mittleren Multiple der letzten Jahre gehandelt würde.',
  'concept.vh.sector':
    'Dasselbe Multiple über die Branche (oder den Sektor, wenn die Branche zu klein ist) aus Watchlist und Referenzwerten: Median und in wie viel Prozent der Werte es niedriger ist.',
  'concept.vh.fairRatio':
    'Das Multiple, das Wachstum, Margen, Beta und Sektor dieser Aktie über das ganze Universum gerechnet normalerweise tragen (Regression). Rot heißt, die Aktie ist teurer, als ihre Eigenschaften erklären.',

  // ── Multiples (also in the grid, the peers and the history) ──────────────
  'metrics.ratios.pe':
    'Kurs-Gewinn-Verhältnis: Kurs durch Gewinn je Aktie der letzten zwölf Monate, also wie viele Jahresgewinne man für die Aktie zahlt. Für sich allein wenig aussagekräftig, nur im Vergleich mit der eigenen Historie, der Branche und dem Wachstum.',
  'metrics.ratios.forwardPE':
    'KGV auf den erwarteten Gewinn der nächsten zwölf Monate (Analystenkonsens). Deutlich unter dem KGV TTM heißt, die Analysten erwarten steigende Gewinne.',
  'financials.avgPE5Y':
    'Durchschnittliches KGV am Ende der letzten drei bis vier profitablen Geschäftsjahre, ohne Verlustjahre: die gewohnte Bewertung der Aktie.',
  'metrics.ratios.peg':
    'KGV geteilt durch das erwartete Gewinnwachstum in Prozent. Um 1 gilt nach Peter Lynch als fair bezahltes Wachstum, deutlich darüber als teuer.',
  'metrics.ratios.pb':
    'Kurs-Buchwert-Verhältnis: Kurs durch Eigenkapital je Aktie. Aussagekräftig bei Banken, Versicherern und anlageintensiven Firmen. Bei kapitalleichten Firmen mit Aktienrückkäufen ist der Buchwert oft klein und das KBV entsprechend hoch, ohne dass das teuer heißen muss.',
  'metrics.evMultiples.priceToSales':
    'Kurs-Umsatz-Verhältnis: Börsenwert durch Umsatz der letzten zwölf Monate. Nützlich, wo es noch keinen stabilen Gewinn gibt. Ein hohes KUV braucht später hohe Margen, um aufzugehen.',
  'metrics.evMultiples.forwardPriceToSales':
    'Börsenwert durch den erwarteten Umsatz des nächsten (oder laufenden) Geschäftsjahrs. Zeigt, wie viel vom hohen KUV das erwartete Wachstum schon relativiert.',
  'metrics.evMultiples.simpleValuationRatio':
    'Run-Rate-KUV: Börsenwert durch (Umsatz des letzten Quartals × 4). Reagiert sofort auf das jüngste Quartal statt auf den Zwölfmonatsschnitt, was bei schnell wachsenden Firmen fairer ist. Bei saisonalen Geschäften ist es verrauscht.',
  'metrics.evMultiples.seasonallyAdjustedValuationRatio':
    'Run-Rate-KUV ohne Saisonmuster: die letzten vier Quartale, jedes mit der Jahreswachstumsrate des jüngsten Quartals hochgerechnet. Weicht es stark vom einfachen Run-Rate ab, war das letzte Quartal saisonal stark oder schwach.',
  'metrics.evMultiples.evToEbitda':
    'Unternehmenswert durch EBITDA: wie viele Jahre operativer Gewinn vor Abschreibungen der Kauf des ganzen Unternehmens samt Schulden kostet. Über unterschiedliche Verschuldung hinweg vergleichbarer als das KGV.',
  'metrics.evMultiples.evToRevenue': 'Unternehmenswert durch Umsatz: das KUV, aber mit Schulden und abzüglich Cash.',
  'metrics.evMultiples.evToFCF': 'Unternehmenswert durch Free Cashflow.',
  'metrics.evMultiples.priceToFCF':
    'Börsenwert durch Free Cashflow (operativer Cashflow minus Investitionen). Der Kehrwert ist die FCF-Rendite. Robuster als das KGV, weil Cash schwerer zu gestalten ist als Gewinn.',
  'metrics.ratios.dividendYield':
    'Dividenden der letzten zwölf Monate geteilt durch den Kurs. Zu lesen gegen die Rendite zehnjähriger Staatsanleihen derselben Währung, also gegen das, was es ohne Risiko gibt: Die Anleihe zahlt sicher und am Ende alles zurück, die Dividende kann gekürzt werden und der Kurs schwankt. Was eine Aktie auf Dauer bringt, ist Dividende plus Wachstum. Unter dem Wert im Kopf der Aktie steht die Anleihe, oder gelb der Anteil am Gewinn, wenn mehr ausgeschüttet wird als verdient.',

  // ── Fundamentals grid ────────────────────────────────────────────────────
  'financials.revenue': 'Umsatz der letzten zwölf Monate (vier Quartale).',
  'financials.revenueGrowth':
    'Umsatzwachstum: die letzten vier Quartale gegen die vier davor, sonst die zwei jüngsten Geschäftsjahre. Kein einzelnes Quartal, damit Sondereffekte nicht durchschlagen.',
  'financials.earningsGrowth':
    'Wachstum des Nettogewinns, auf derselben Basis wie das Umsatzwachstum. Leer, wenn der Vorjahresgewinn nicht positiv war, denn Wachstum aus einem Verlust heraus ist keine Rate.',
  'financials.epsGrowth3Y': 'Durchschnittliches jährliches Wachstum des Gewinns je Aktie über drei Jahre (Finnhub).',
  'financials.grossProfit': 'Bruttogewinn der letzten zwölf Monate: Umsatz minus Herstellungskosten.',
  'financials.ebitda':
    'Operativer Gewinn vor Abschreibungen, über die letzten vier Quartale. Ein grobes Maß für den operativen Cashflow, blind für Investitionsbedarf.',
  'financials.freeCashFlow':
    'Operativer Cashflow minus Investitionen (Capex), über die letzten vier Quartale. Das Geld, das für Dividenden, Rückkäufe, Schuldentilgung oder Zukäufe frei ist.',
  'financials.operatingMargin':
    'Operativer Gewinn in Prozent vom Umsatz: was vom Euro Umsatz nach allen Betriebskosten bleibt, vor Zinsen und Steuern.',
  'financials.netMargin': 'Nettogewinn in Prozent vom Umsatz, nach Zinsen, Steuern und Sondereffekten.',
  'metrics.ratios.roe':
    'Eigenkapitalrendite: Nettogewinn durch durchschnittliches Eigenkapital. Über ~15 % gilt als stark. Rückkäufe und Schulden blähen sie auf, weil sie das Eigenkapital verkleinern.',
  'metrics.ratios.roa': 'Gesamtkapitalrendite: Nettogewinn durch durchschnittliche Bilanzsumme. Unabhängig von der Finanzierung, daher gut über Branchen vergleichbar.',
  'financials.roic':
    'Rendite auf das investierte Kapital (Eigenkapital plus Schulden) im letzten Geschäftsjahr. Liegt sie dauerhaft über den Kapitalkosten (meist 8–10 %), schafft Wachstum Wert. Darunter vernichtet jeder investierte Euro Wert.',
  'metrics.ratios.ownerEarningsYield':
    'Buffetts Owner Earnings, (Nettogewinn + Abschreibungen − Investitionen), geteilt durch den Börsenwert: die Rendite, die ein Eigentümer des ganzen Geschäfts erhielte.',
  'financials.totalCash': 'Barmittel und kurzfristige Geldanlagen laut letzter Bilanz.',
  'financials.totalDebt': 'Alle zinstragenden Schulden, kurz- und langfristig, einschließlich Leasingverbindlichkeiten.',
  'financials.longTermDebt': 'Schulden mit Laufzeit über einem Jahr.',
  'financials.workingCapital':
    'Umlaufvermögen minus kurzfristige Verbindlichkeiten. Negativ ist nicht automatisch schlecht: Abo-Geschäfte kassieren im Voraus.',
  'financials.currentRatio':
    'Umlaufvermögen durch kurzfristige Verbindlichkeiten. Über 1 kann die Firma ihre Rechnungen des nächsten Jahres aus kurzfristigem Vermögen zahlen. Bei Abo-Geschäften unterschätzt sie die Liquidität, weil Vorauszahlungen als Verbindlichkeit zählen.',
  'financials.quickRatio': 'Wie die Current Ratio, aber ohne Lagerbestände, die sich nicht sofort zu Geld machen lassen. Die strengere Liquiditätsprobe.',
  'financials.debtToEquity':
    'Schulden durch Eigenkapital. Unter 0,5 gilt als konservativ, über 2 als hoch, branchenabhängig. Bei Rückkauf-Firmen mit kleinem Eigenkapital ist der Wert oft verzerrt.',
  'financials.totalAssets': 'Bilanzsumme laut letztem Jahresabschluss.',
  'financials.totalLiabilities': 'Alle Verbindlichkeiten laut letztem Jahresabschluss, nicht nur Finanzschulden.',
  'financials.retainedEarnings':
    'Seit Gründung einbehaltene Gewinne, also nicht ausgeschüttet. Negativ nach langen Verlustphasen oder hohen Rückkäufen. Fließt in den Altman-Z ein.',

  // ── Margin trends ────────────────────────────────────────────────────────
  'concept.marginTrends':
    'Das letzte Geschäftsjahr gegen den eigenen Durchschnitt. Das Raster darunter zeigt die heutigen Margen, diese Tabelle, ob sie für das Unternehmen normal sind. Hover auf eine Zeile zeigt alle Jahre.',
  'concept.grossMargin': 'Bruttomarge: Bruttogewinn durch Umsatz. Hohe und stabile Bruttomargen deuten auf Preissetzungsmacht hin.',
  'concept.fcfMargin': 'Free Cashflow in Prozent vom Umsatz.',
  'concept.fcfConversion':
    'Free Cashflow durch Nettogewinn: wie viel vom Buchgewinn als Cash ankommt. Um oder über 100 % ist gesund. Dauerhaft deutlich darunter ist ein Warnsignal für die Gewinnqualität.',
  'concept.trendArrow': 'Vergleicht das letzte Jahr mit dem Schnitt der Jahre davor. Grün heißt verbessert, rot verschlechtert, Punkt heißt unverändert (unter 1 Prozentpunkt).',

  // ── Peers ────────────────────────────────────────────────────────────────
  'section.peers':
    'Die Aktie gegen den Median ihrer Vergleichsfirmen (Peers von Finnhub). Bei Multiples ist weniger besser, bei Margen, Renditen und Wachstum mehr. Grün heißt klar besser als die Peers, rot klar schlechter.',
  'concept.peerDelta': 'Abweichung vom Peer-Median in Prozent.',
  'peers.runRatePriceToSales':
    'Peer-Median des Run-Rate-KUV: das KUV jedes Peers mit dessen eigenem Quartalswachstum auf Run-Rate umgerechnet, damit ein schneller Wachser nicht gegen nachlaufende Peer-Multiples geschönt wird.',

  // ── Quality & risk ───────────────────────────────────────────────────────
  'section.quality':
    'Wie gut das Geschäft ist und wie belastbar seine Bilanz: klassische Prüfscores, die je eine Frage beantworten, nämlich Qualität, Insolvenzrisiko, Bilanzkosmetik, Risiko-Rendite, Wachstum gegen Marge und Zinslast.',
  'concept.balanceChecks':
    'Die einfachen Bilanzfragen, mit den Zahlen dahinter beantwortet: Reicht das Cash, sind die Schulden tragbar, ist die Liquidität gesichert?',
  'concept.cashRunway':
    'Für Firmen, die Geld verbrennen: Cash geteilt durch den monatlichen Abfluss an Free Cashflow der letzten zwölf Monate, also wie lange das Geld ohne neue Finanzierung reicht.',
  'metrics.piotroski.score':
    'Piotroski F-Score: neun Ja/Nein-Tests zu Profitabilität, Verschuldung, Liquidität und Effizienz, jeweils gegen das Vorjahr. Ab 75 % der berechenbaren Tests gilt er als stark, bis 33 % als schwach. Die Balken stehen für die Tests F1–F9.',
  'metrics.piotroski.signals.f1_positiveROA': 'F1: Gesamtkapitalrendite positiv, das Unternehmen ist profitabel.',
  'metrics.piotroski.signals.f2_positiveCFO': 'F2: Operativer Cashflow positiv.',
  'metrics.piotroski.signals.f3_improvingROA': 'F3: Gesamtkapitalrendite höher als im Vorjahr.',
  'metrics.piotroski.signals.f4_accruals': 'F4: Operativer Cashflow über dem Gewinn. Der Gewinn ist durch Cash gedeckt, nicht nur durch Buchungen.',
  'metrics.piotroski.signals.f5_reducingLeverage': 'F5: Langfristige Schulden im Verhältnis zur Bilanzsumme gesunken.',
  'metrics.piotroski.signals.f6_improvingLiquidity': 'F6: Current Ratio höher als im Vorjahr.',
  'metrics.piotroski.signals.f7_noNewShares': 'F7: Keine neuen Aktien ausgegeben, keine Verwässerung.',
  'metrics.piotroski.signals.f8_improvingGrossMargin': 'F8: Bruttomarge höher als im Vorjahr.',
  'metrics.piotroski.signals.f9_improvingAssetTurnover': 'F9: Umsatz je Euro Bilanzsumme höher als im Vorjahr, das Vermögen arbeitet effizienter.',
  'metrics.altmanZ.score':
    'Altman Z-Score: Insolvenzrisiko aus fünf Bilanzkennzahlen (Liquidität, einbehaltene Gewinne, operativer Gewinn, Börsenwert bzw. Eigenkapital gegen Schulden, Umsatz). Die Zonen sind sicher, grau und Gefahr; die Grenzen hängen vom Modell ab, original für Industrie, modifiziert für alle anderen. Für Banken nicht aussagekräftig.',
  'metrics.beneish.score':
    'Beneish M-Score: acht Kennzahlen, die typischerweise kippen, wenn Gewinne geschönt werden (Forderungen wachsen schneller als Umsatz, Margen bröckeln, hohe Accruals …). Über −1,78 deutet er auf Manipulation hin, unter −2,22 nicht. Ein Verdacht, kein Beweis, und unter vier berechneten Kennzahlen unzuverlässig.',
  'metrics.sortino.ratio':
    'Sortino-Ratio: Rendite über dem risikolosen Zins je Einheit Abwärtsschwankung, aus Monatsrenditen. Anders als Sharpe bestraft sie nur Verluste, nicht Kurssprünge nach oben. Ab 1 gut, ab 2 sehr gut.',
  'metrics.ruleOf40.score':
    'Rule of 40: Umsatzwachstum in Prozent plus Gewinnmarge in Prozent. Für Software- und Wachstumsfirmen gilt 40 als Schwelle eines gesunden Verhältnisses von Wachstum und Profitabilität. Für reife Industriefirmen wenig aussagekräftig.',
  'metrics.interestCoverage.ratio':
    'Zinsdeckung: operativer Gewinn durch Zinsaufwand, also wie oft der Gewinn die Zinsen deckt. Ab 8 exzellent, ab 4 gut, ab 2 ausreichend, unter 1 kritisch. ∞ heißt schuldenfrei. Die Zinsdeckung bestimmt auch das synthetische Rating für die Fremdkapitalkosten im DCF.',

  // ── Earnings ─────────────────────────────────────────────────────────────
  'section.earnings':
    'Gewinne und Umsätze der Vergangenheit, die Prognosen der Analysten, und wie oft das Unternehmen die Erwartungen geschlagen hat.',
  'concept.forecast': 'Die berichteten Jahre und die Analystenschätzungen für das laufende und nächste Geschäftsjahr auf einer Achse: Setzt die Prognose den Trend fort oder bricht sie mit ihm?',
  'concept.surprises':
    'Die letzten vier Quartale: erwarteter gegen tatsächlichen Gewinn je Aktie. Regelmäßig übertroffene Erwartungen sprechen für vorsichtige Guidance oder ein besser laufendes Geschäft; verfehlte drücken meist den Kurs.',
  'concept.surprisePct': 'Abweichung des tatsächlichen vom erwarteten Gewinn je Aktie, in Prozent der Erwartung.',
  'concept.forwardEstimates':
    'Konsensschätzungen der Analysten für Gewinn je Aktie und Umsatz: laufendes Quartal (Cur Q), nächstes Quartal (Nxt Q), laufendes Jahr (Cur Y), nächstes Jahr (Nxt Y), jeweils mit Wachstum gegenüber dem Vorjahreszeitraum.',

  // ── Track records ────────────────────────────────────────────────────────
  'section.analystRecord':
    'Wie gut die Kursziele der Analysten für diese Aktie bisher waren: jedes archivierte Ziel gegen den Kurs ein Jahr später, je Haus und für den Konsens.',
  'concept.ar.medianError':
    'Median von (Kurs nach zwölf Monaten / Kursziel − 1). −20 % heißt, der Kurs lag ein Jahr später typischerweise ein Fünftel unter dem Ziel; das Haus war zu optimistisch.',
  'concept.ar.reached': 'Anteil der Ziele, die der Kurs innerhalb des Jahres an mindestens einem Schlusskurs erreicht hat.',
  'concept.ar.direction': 'Anteil der Fälle, in denen sich der Kurs in die Richtung bewegte, die das Ziel nahelegte (rauf oder runter).',
  'concept.ar.targets': 'Kursziele dieses Hauses mit abgeschlossenem Jahr. Unter fünf ist die Bilanz eines Hauses kaum aussagekräftig.',
  'section.verdictRecord':
    'Jeder unserer Urteilswechsel für diese Aktie als Wette gegen den S&P 500: Wie hat sich die Aktie danach gegen den Index geschlagen?',
  'concept.vr.excess': 'Mehrrendite der Aktie gegenüber dem S&P 500 nach so vielen Monaten ab dem Urteilswechsel. Hover zeigt beide Renditen einzeln.',
  'concept.vr.held': 'Mehrrendite vom Urteil bis zum nächsten Wechsel, oder bis heute, wenn es noch gilt.',

  // ── Fundamentals section ─────────────────────────────────────────────────
  'section.fundamentals':
    'Die Geschäftszahlen: der Verlauf der letzten Geschäftsjahre, wie aus Umsatz Gewinn wird, und die aktuellen Kennzahlen zu Profitabilität, Bilanz und Bewertung.',
  'concept.incomeFlow':
    'Wohin der Umsatz geht: Herstellungskosten, Betriebskosten, Zinsen und Steuern, bis zum Nettogewinn. Die Breite jedes Stroms ist sein Anteil am Umsatz.',

  // ── Technicals ───────────────────────────────────────────────────────────
  'section.technicals':
    'Was der Kursverlauf allein sagt: Trendstruktur, Unterstützungen und Widerstände, Regressionskanäle, Trendlinien, Volumenprofil, Divergenzen, Ausbrüche und offene Kurslücken — gerechnet aus den archivierten Tageskursen. Dazu auf Wunsch die Lesart eines Sprachmodells und die klassische Indikator-Abstimmung. Beschreibung des Charts, kein Urteil über den Wert; nichts davon fließt in Score oder Urteil ein.',
  'tech.levels':
    'Preise, an denen der Kurs mehrfach gedreht hat. Wendepunkte stammen aus einem Zickzack, der eine Bewegung erst als Wende zählt, wenn der Kurs danach um drei typische Tagesbewegungen (ATR) zurückläuft. Wendepunkte innerhalb von rund 0,6 ATR werden zu einer Marke zusammengefasst; Stärke heißt: viele und jüngere Berührungen. Unter dem Kurs heißt eine Marke Unterstützung, darüber Widerstand. Rollentausch: Die Marke hat den Kurs von beiden Seiten gedreht.',
  'tech.channels':
    'Eine Gerade durch die logarithmierten Schlusskurse des Zeitraums, mit Rändern bei zwei Standardabweichungen. σ sagt, wo der letzte Kurs zwischen den Rändern steht: −2 am unteren, +2 am oberen. R² sagt, wie gerade der Weg war — unter 0,3 ist der Kanal eher eine Wolke. Die Liste zeigt den 3-Monats-Kanal; nur dessen Lage hat der Backtest geprüft.',
  'tech.trendlines':
    'Die Linie durch die letzten beiden Wendetiefs (Unterstützung) und die durch die letzten beiden Wendehochs (Widerstand), bis heute verlängert. Gebrochen heißt: Ein Schlusskurs lag seitdem deutlich jenseits der Linie.',
  'tech.profile':
    'Wo im letzten Jahr gehandelt wurde: das Volumen jedes Tages gleichmäßig über seine Spanne verteilt. Der POC ist der Preis mit dem meisten Umsatz, die Zone darum hält 70 % des Volumens. Viele Marktteilnehmer haben dort ihren Einstand — solche Preise wirken oft als Marke.',
  'tech.chartRead':
    'Ein Sprachmodell bekommt die Wochenkerzen der letzten zwei Jahre, die Tageskerzen des letzten Quartals und die hier gerechneten Marken — keine Nachrichten, keine Fundamentaldaten, kein Urteil — und liest daraus Chartmuster, die Marken, die es für wichtig hält, und Szenarien mit Auslösern. Ungeprüft: Chartmuster haben im Backtest dieser App keinen Nachweis, und Modelle sehen Muster auch, wo keine sind.',
  'tech.vote':
    'Die klassische Zusammenfassung im Stil von TradingView: zwölf gleitende Durchschnitte und sieben Oszillatoren stimmen je mit Kauf, Neutral oder Verkauf ab. Grob und kurzfristig; hier nur noch zum Nachschlagen.',
  'tech.movingAverages': 'Zwölf gleitende Durchschnitte (SMA und EMA über 10–200 Tage). Kurs darüber stimmt für Kauf, darunter für Verkauf. Viele Kaufstimmen heißen: Aufwärtstrend auf allen Zeitskalen.',
  'tech.oscillators': 'Sieben Oszillatoren (RSI, Stochastik, MACD, CCI, Williams %R, Momentum, Bollinger %B). Sie messen, ob der Kurs zu weit, zu schnell gelaufen ist.',
  'tech.overall': 'Durchschnitt der beiden Gruppen, gleich gewichtet, damit die zwölf Durchschnitte die sieben Oszillatoren nicht überstimmen.',
  'tech.sma': 'Einfacher gleitender Durchschnitt der Schlusskurse über so viele Tage. Kurs darüber heißt Aufwärtstrend auf dieser Zeitskala. SMA 200 ist die klassische Trendlinie.',
  'tech.ema': 'Exponentieller gleitender Durchschnitt: wie der SMA, gewichtet jüngere Kurse aber stärker und reagiert dadurch schneller.',
  'tech.rsi': 'Relative Strength Index (14 Tage), 0–100: Verhältnis der Auf- zu den Abwärtstagen. Über 70 gilt als überkauft, unter 30 als überverkauft. In starken Trends bleibt er lange extrem.',
  'tech.stoch': 'Stochastik: Wo der Kurs innerhalb der Spanne der letzten 14 Tage steht, 0–100. Über 80 überkauft, unter 20 überverkauft. Das Signal entsteht beim Kreuzen von %K und %D.',
  'tech.macd': 'MACD: Differenz zweier exponentieller Durchschnitte (12 und 26 Tage) gegen ihre eigene 9-Tage-Linie. Gezeigt wird das Histogramm: positiv heißt, das Momentum nimmt zu.',
  'tech.cci': 'Commodity Channel Index (20): Abstand des Kurses vom Durchschnitt in Einheiten seiner üblichen Schwankung. Über +100 überkauft, unter −100 überverkauft.',
  'tech.williams': 'Williams %R (14): wie die Stochastik, auf −100 bis 0. Über −20 überkauft, unter −80 überverkauft.',
  'tech.momentum': 'Momentum (10): Kurs heute minus Kurs vor zehn Handelstagen. Das Vorzeichen zeigt die kurzfristige Richtung.',
  'tech.bollinger': 'Bollinger %B: Lage des Kurses im Band aus 20-Tage-Durchschnitt ± 2 Standardabweichungen. 0 ist das untere Band, 1 das obere; außerhalb ist ungewöhnlich weit gelaufen.',

  // ── Price action ─────────────────────────────────────────────────────────
  'section.priceAction': 'Was die Aktie getan hat: Renditen, Schwankung, Lage zu Hochs und Tiefs, und wie sie sich gegen Markt und Sektor geschlagen hat.',
  'concept.trailingReturns': 'Kursrendite über die jeweiligen Zeiträume bis heute, ohne Dividenden.',
  'signals.technicals.atr14Pct': 'Average True Range (14 Tage) in Prozent vom Kurs: die typische Tagesspanne. Ein Maß dafür, wie weit die Aktie an einem normalen Tag schwankt.',
  'signals.technicals.hv30': 'Historische Volatilität der letzten 30 Tage, auf ein Jahr hochgerechnet: die Standardabweichung der Tagesrenditen. 20 % ist ruhig für eine Einzelaktie, 50 % sehr bewegt.',
  'signals.technicals.hv90': 'Historische Volatilität der letzten 90 Tage, auf ein Jahr hochgerechnet.',
  'signals.technicals.drawdownFromHighPct': 'Abstand vom höchsten Schlusskurs der letzten zwölf Monate.',
  'signals.technicals.position52WPct': 'Lage in der 52-Wochen-Spanne: 0 % am Tief, 100 % am Hoch.',
  'signals.technicals.currentVolRatio': 'Handelsvolumen des letzten Tages gegen den 30-Tage-Schnitt. Deutlich über 1 heißt, es passiert etwas: Nachrichten, Zahlen, große Umschichtungen.',
  'signals.technicals.rsVsSPY3M': 'Relative Stärke: Rendite der Aktie über drei Monate minus Rendite des S&P 500. Positiv heißt, sie hat den Markt geschlagen.',
  'signals.technicals.rsVsSector3M': 'Rendite über drei Monate minus Rendite des Sektor-ETFs. Trennt die eigene Stärke von der ihrer Branche.',

  // ── Market context ───────────────────────────────────────────────────────
  'section.marketContext': 'Was das Umfeld sagt: wie der Optionsmarkt das Risiko einpreist, wohin die Gewinnschätzungen driften, und die Lage am Gesamtmarkt.',
  'signals.options.ivAtm30d': 'Implizite Volatilität am Geld, rund 30 Tage: die Schwankung, die der Optionsmarkt für das nächste Jahr einpreist, annualisiert.',
  'signals.options.ivVsHv90Ratio': 'Implizite gegen tatsächliche Volatilität (90 Tage). Über 1,3 sind Optionen teuer: Der Markt erwartet mehr Unruhe als zuletzt, oft vor Zahlen oder Ereignissen. Unter 0,8 sind sie günstig.',
  'signals.options.putCallVolumeRatio': 'Gehandelte Puts durch Calls (Strikes ±15 % um den Kurs). Über 1,2 sichern sich viele ab oder wetten auf Verluste, unter 0,7 überwiegen Wetten auf Anstieg. Kontraindikator bei Extremen.',
  'signals.options.putCallOIRatio': 'Offene Put- durch Call-Kontrakte: die bestehenden Positionen statt des heutigen Handels, deshalb träger und weniger verrauscht.',
  'signals.options.nextEarningsImpliedMove.pct': 'Die Kursbewegung, die der Optionsmarkt über die nächsten Quartalszahlen einpreist (Preis des Straddles am Geld durch Kurs).',
  'concept.revisions': 'Wie sich die Gewinnschätzungen der Analysten in den letzten 30 Tagen bewegt haben, je Zeitraum. Steigende Schätzungen gehen Kursanstiegen oft voraus.',
  'signals.revisions.perPeriod.0q.epsChange30dPct': 'Veränderung der Konsensschätzung für den Gewinn je Aktie gegenüber vor 30 Tagen.',
  'signals.revisions.perPeriod.0q.netRevision30d': 'Anhebungen minus Senkungen der Gewinnschätzung in den letzten 30 Tagen. Positiv heißt, mehr Analysten haben nach oben korrigiert.',
  'macro.vix': 'Volatilitätsindex der Optionen auf den S&P 500, das „Angstbarometer“. Unter 15 ruhig, 15–20 normal, 20–30 erhöht, über 30 Stress.',
  'macro.spy3MReturn': 'Rendite des S&P 500 über drei Monate: die Marktlage, gegen die sich die Aktie bewegt.',
  'macro.yieldCurve2Y10Y': 'Zinsdifferenz zehnjähriger minus zweijähriger US-Staatsanleihen. Negativ (invertiert) ging historisch vielen Rezessionen voraus.',
  'macro.hySpreadBps': 'Risikoaufschlag von Hochzinsanleihen über Staatsanleihen. Über 400 Basispunkte wird Kredit teurer, über 600 herrscht Stress. Steigende Spreads warnen früh.',
  'macro.dxyLevel': 'US-Dollar-Index gegen einen Korb großer Währungen, daneben die Veränderung über drei Monate. Ein starker Dollar belastet die Auslandsumsätze von US-Firmen.',
  'macro.sectorEtfReturn3M': 'Rendite des Sektor-ETFs über drei Monate: wie es der Branche insgesamt ging.',

  // ── Ownership ────────────────────────────────────────────────────────────
  'section.ownership': 'Wer die Aktie hält, wer gegen sie wettet, und was die Insider mit ihren eigenen Aktien tun.',
  'financials.shortPercentOfFloat': 'Anteil der frei handelbaren Aktien, die leer verkauft sind, also Wetten auf fallende Kurse. Über 8 % ist viel, über 20 % sehr viel. Das kann einen Short Squeeze möglich machen.',
  'financials.sharesShort': 'Anzahl leer verkaufter Aktien laut letzter Meldung (zweimal im Monat).',
  'financials.shortRatio': 'Days to Cover: leer verkaufte Aktien durch durchschnittliches Tagesvolumen, also wie viele Handelstage die Short-Seite bräuchte, um sich einzudecken.',
  'concept.shortMoM': 'Veränderung der leer verkauften Aktien gegenüber der Meldung des Vormonats. Steigend heißt, die Wetten gegen die Aktie nehmen zu.',
  'financials.institutionsPercentHeld': 'Anteil der Aktien bei institutionellen Anlegern (Fonds, Pensionskassen, Versicherer), laut ihren Pflichtmeldungen.',
  'financials.insidersPercentHeld': 'Anteil der Aktien bei Vorstand, Aufsichtsrat und Großaktionären mit Insiderstatus. Hoch heißt: Das Management sitzt im selben Boot.',
  'concept.insiderActivity': 'Käufe an der Börse und Verkäufe der Insider in den letzten sechs Monaten. Zuteilungen, Optionsausübungen und Schenkungen zählen nicht als Kauf: Dafür hat niemand den Börsenkurs bezahlt. Verkäufe haben viele Gründe (Steuern, Diversifikation); Käufe mit eigenem Geld haben meist nur einen.',
  'concept.insiderYahooCount': 'Yahoos eigene Zählung der letzten sechs Monate. Als Zugang zählt dort jeder Erwerb, auch Zuteilungen und Optionsausübungen, für die niemand den Börsenkurs bezahlt hat. „Kaufen oder verkaufen die Insider?“ zählt nur Käufe an der Börse.',
  'concept.holders.share': 'Anteil an allen ausstehenden Aktien.',
  'concept.holders.change': 'Veränderung der Position seit der vorigen Meldung des Halters. Die Meldungen kommen meist quartalsweise und mit Wochen Verzögerung.',
  'concept.insiderTrades': 'Jede gemeldete Insider-Transaktion. Zuteilungen, Schenkungen und Optionsausübungen sind Vergütung und standardmäßig ausgeblendet; Käufe und Verkäufe sind Meinungen.',

  // ── Timeline, research ───────────────────────────────────────────────────
  'section.journal': 'Deine eigenen Einträge zu dieser Aktie: was du gelesen und gedacht hast, wann und warum du gekauft oder verkauft hast. Neben jeder Aktie steht, wie sie sich seit dem Tag des Eintrags bewegt hat. Fließt nicht in den Score ein.',
  'section.timeline': 'Alles Archivierte auf einer Zeitachse: deine Journal-Einträge, Analystenaktionen, Insider-Trades, Quartalszahlen, Dividenden, unsere Urteilswechsel, datierte Ereignisse aus der Recherche und große Kurssprünge.',
  'section.distill': 'Distill sammelt laufend Nachrichten und Berichte zur Firma und ihren Branchen und verdichtet sie zu Dossiers; das Briefing fasst die jüngsten Insights zusammen. Die stärkste Textquelle der Analyse.',
  'section.perplexity': 'Eine Recherche von Perplexity zur Firma: Geschäft, jüngste Entwicklungen, Risiken, mit Quellen. Wird gespeichert und von jeder Analyse gelesen, bis das im Admin eingestellte Zeitfenster abläuft.',
  'section.deepResearch': 'Der ausführliche Firmenbericht — über die API gekauft oder in einer Chat-App recherchiert und eingefügt — und weitere Recherchen von Hand: Vorschau auf Zahlen, Prüfung eigener Thesen. Nur der Firmenbericht geht in die Analysen ein.',
  'section.news': 'Die jüngsten Meldungen zur Aktie von Finnhub, mit Quelle und Datum.',
  'section.searches': 'Welche Suchen die gespeicherte Analyse ausgeführt hat und was sie fand — zur Kontrolle, woraus das Modell sein Urteil gebaut hat.',
} as const satisfies Record<string, string>;

export type GlossaryKey = keyof typeof GLOSSARY;

/**
 * The six pillars, keyed by the scorer's own closed set: a seventh pillar is a
 * type error here until it is explained.
 */
export const PILLAR_GLOSSARY: Record<PillarKey, string> = {
  valuation:
    'Ist die Aktie ihren Preis wert? Der faire Wert der Modelle gegen den Kurs (Primary und Value-Linse), der Vergleich mit den Multiples der Peers, und was der Kurs an Wachstum und Marge voraussetzt.',
  quality:
    'Wie gut ist das Geschäft? Piotroski-Score, Kapitalrendite über den Kapitalkosten, Bruttoprofitabilität, Marge, Wachstum, Gewinnqualität (Accruals), Verwässerung durch neue Aktien, Rule of 40.',
  health:
    'Wie belastbar ist die Bilanz? Altman-Z (Insolvenzrisiko), Zinsdeckung, Verschuldung, Liquidität und Beneish-M (Hinweise auf geschönte Zahlen).',
  consensus:
    'Was sagen die Analysten? Vor allem ihr Rating (Kaufen, Halten, Verkaufen), schwächer das Kursziel-Potenzial, weil Kursziele fallenden Kursen nur langsam folgen und „Potenzial“ sonst vor allem einen Absturz misst.',
  momentum:
    'Wie läuft die Aktie? Momentum der letzten zwölf Monate ohne den jüngsten (der kehrt oft um), Abstand zum 52-Wochen-Hoch, relative Stärke gegen den Sektor.',
  revisions:
    'Wohin bewegen sich die Erwartungen? Drift der Gewinnschätzungen, Verhältnis von Anhebungen zu Senkungen, übertroffene oder verfehlte Quartale, Änderungen der Analystenratings.',
};

/** The five dimensions the narrative read rates, keyed by the schema's closed set. */
export const DIMENSION_GLOSSARY: Record<NarrativeDimension, string> = {
  demand:     'Nachfrage: Wächst oder schrumpft der Bedarf nach dem, was das Unternehmen verkauft?',
  position:   'Position: Marktanteil, Preissetzungsmacht, Abstand zum Wettbewerb.',
  execution:  'Ausführung: Liefert das Management, was es ankündigt, also Pläne, Margen, Zeitpläne?',
  regulation: 'Regulierung: Rückenwind oder Gegenwind durch Gesetze, Behörden, Klagen, Zölle.',
  product:    'Produkt: Stärke und Erneuerung des Angebots, also Neuheiten, Pipeline, Qualität.',
};

/** The margin-trend rows, keyed by `trends.ts`'s own ratios. */
export const TREND_TERMS: Record<TrendRatioKey, GlossaryKey> = {
  grossMargin:     'concept.grossMargin',
  operatingMargin: 'financials.operatingMargin',
  netMargin:       'financials.netMargin',
  fcfMargin:       'concept.fcfMargin',
  fcfConversion:   'concept.fcfConversion',
  roe:             'metrics.ratios.roe',
  roa:             'metrics.ratios.roa',
};

/** The valuation history's multiples, keyed by its own list. */
export const HISTORY_MULTIPLE_TERMS: Record<HistoryMultiple, GlossaryKey> = {
  pe:       'metrics.ratios.pe',
  ps:       'metrics.evMultiples.priceToSales',
  pfcf:     'metrics.evMultiples.priceToFCF',
  evEbitda: 'metrics.evMultiples.evToEbitda',
};

/**
 * The composite's contributors by the names the models carry. Model names are
 * display strings in `metrics.ts`, not a type, so an unknown one simply gets no
 * explanation rather than a wrong one.
 */
export const MODEL_TERMS: Record<string, GlossaryKey> = {
  'DCF (Revenue-Driven)': 'metrics.dcf.fairValue',
  'Peer Multiples':       'metrics.peerMultiples.medianFairPrice',
  'Peter Lynch':          'metrics.peterLynch.fairValue',
  'Analyst Consensus':    'financials.targetMeanPrice',
  'Graham Number':        'metrics.grahamNumber.grahamNumber',
  'Graham Revised V*':    'metrics.grahamRevised.fairValue',
  'EPV (Greenwald)':      'metrics.epv.fairValue',
  'Excess Return (RIM)':  'metrics.rim.fairValue',
  'DDM (Two-Stage)':      'metrics.ddm.fairValue',
};

/** A technical indicator's explanation, by the name `signals.ts` gives it ("RSI (14)", "SMA 50"). */
export function technicalTerm(name: string): GlossaryKey | null {
  const rules: [RegExp, GlossaryKey][] = [
    [/^SMA\b/, 'tech.sma'], [/^EMA\b/, 'tech.ema'], [/^RSI\b/, 'tech.rsi'], [/^Stochastic\b/, 'tech.stoch'],
    [/^MACD\b/, 'tech.macd'], [/^CCI\b/, 'tech.cci'], [/^Williams\b/, 'tech.williams'],
    [/^Momentum\b/, 'tech.momentum'], [/^Bollinger\b/, 'tech.bollinger'],
  ];
  return rules.find(([re]) => re.test(name))?.[1] ?? null;
}
