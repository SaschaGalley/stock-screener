# Was trägt welche Quelle? distill, Perplexity-Brief und Tiefenrecherche, 10.10.2026

Zehn Aktien, eine Erkundung, keine Messung mit Vorschrift. Zuerst NU, ARGX und STR.VI, die drei mit einer
Tiefenrecherche, dazu ORCL, NKE und CRWV, bei denen im Blindvergleich (`../dossier-guidance/BERICHT.md`)
die alte distill-Lesung vorn lag. Danach trug der Eigentümer Tiefenrecherchen für ORCL, NKE, NVDA, MSFT,
AAPL und SAP nach, ORCL und NKE durch Einfügen aus dem Research-Modus, die übrigen über die API.

**Ergebnis:** Den Narrativ-Score bestimmen Perplexity-Brief und Tiefenrecherche; distill verschiebt ihn
um höchstens 0,5 Punkte, so viel wie drei Lesungen derselben Quelle untereinander streuen. Die
Tiefenrecherche verschiebt ihn um bis zu 1,5 Punkte und war bei acht der neun Aktien, für die es eine
gibt, die Quelle mit dem meisten Gewicht für eine Entscheidung; bei Apple war es der Brief. distill war
es bei keiner Aktie. Dafür bestimmt distill allein, wie viel der Narrativ-Score im Gesamturteil wiegt:
Mit einem Firmendossier liegt die Confidence bei 0,67–0,90, ohne bei 0,20–0,30, auch mit
Tiefenrecherche. Die Gewichte stehen damit umgekehrt zum Beitrag.

## Die Narrative-Stufe je Quelle (`lauf.ts`, `roh/lesungen.jsonl`)

Die echte Stufe (`gpt-5.4-mini`, drei Lesungen, Median), D = distill, P = Perplexity-Brief,
R = Tiefenrecherche; Confidence wie in der Produktion. Je Aktie der jüngste Lauf.

| Aktie | D | P | R | DP | PR | DPR |
|---|---|---|---|---|---|---|
| ORCL | 5,5 / 0,55 | 6,0 / 0,26 | 6,0 / 0,30 | 5,5 / 0,82 | 6,5 / 0,25 | 6,0 / 0,82 |
| NKE | 4,0 / 0,60 | 3,0 / 0,26 | 3,5 / 0,27 | 3,0 / 0,90 | 4,0 / 0,25 | 3,5 / 0,67 |
| NVDA | 6,5 / 0,55 | 7,0 / 0,23 | 6,5 / 0,27 | 6,5 / 0,82 | 6,5 / 0,30 | 6,5 / 0,90 |
| MSFT | 6,0 / 0,50 | 7,5 / 0,20 | 6,0 / 0,30 | 7,0 / 0,90 | 6,0 / 0,30 | 5,5 / 0,82 |
| AAPL | 6,5 / 0,60 | 5,5 / 0,21 | 5,0 / 0,25 | 6,0 / 0,82 | 6,0 / 0,27 | 6,0 / 0,90 |
| SAP | 7,5 / 0,55 | 5,0 / 0,26 | 6,5 / 0,30 | 5,0 / 0,82 | 6,0 / 0,27 | 6,5 / 0,82 |
| NU | 7,0 / 0,60 | 7,5 / 0,27 | 6,5 / 0,30 | 8,0 / 0,82 | 8,0 / 0,27 | 8,0 / 0,82 |
| ARGX | – / 0,07 | 7,5 / 0,27 | 6,5 / 0,18 | 7,0 / 0,30 | 8,0 / 0,22 | 7,0 / 0,33 |
| STR.VI | – / 0,07 | 7,5 / 0,04 | 7,0 / 0,27 | 7,0 / 0,14 | 7,0 / 0,30 | 7,0 / 0,33 |
| CRWV | 7,5 / 0,54 | 6,3 / 0,27 | | 6,9 / 0,90 | | |

Score / Confidence; – heißt Enthaltung. Die Spanne zwischen drei Lesungen liegt in jeder Kombination im
Median bei 0,5.

- **distill:** P gegen DP und PR gegen DPR unterscheiden sich um 0,0 bis 0,5 Punkte. Wo distill allein
  abweicht (SAP 7,5, CRWV 7,5, NKE 4,0), ziehen die anderen Quellen das Ergebnis zu sich.
- **Tiefenrecherche:** P gegen PR verschiebt um bis zu 1,5 Punkte (MSFT 7,5 → 6,0, NKE 3,0 → 4,0,
  SAP 5,0 → 6,0), also über das Rauschen hinaus.
- **Confidence:** Das Firmendossier zählt pauschal 0,5. Brief und Tiefenrecherche zählen zusammen als
  *eine* Quelle (die bessere von beiden), höchstens 0,3; die Tiefenrecherche hebt die Confidence daher
  nicht. STR.VI zeigt die andere Seite: Der Brief findet kaum unabhängige Belege und bringt 0,04.

## Die Quellen nebeneinander (`vergleich/`)

Je Aktie las eine frische Claude-Instanz die drei Texte nach einem festen Raster (Aktualität, fünf
Dimensionen, harte Zahlen, Belegart, Gegenargumente, Exklusives, Widersprüche, Rauschen). Die Texte der
zweiten Runde stehen in `vergleich/`, die der ersten im Verlauf dieser Sitzung.

| Aktie | trägt am meisten | was nur distill hat |
|---|---|---|
| ORCL | Tiefe: alle fünf Dimensionen mit Zahlen, Marge, Rating, Regulierung, ohne die Rechenfehler des Briefs | Anleihe bei 82 Cent und CDS (9.10.), OpenAI-Run-Rate (8.10.) |
| NKE | Tiefe: Rückgang nach Segment, Kanal und Region, Wirtschaftlichkeit von »Pace« | Dividendenfrage, Ladenschließungen, Markenschaden in China |
| NVDA | Tiefe: Margenprognose, Kartellverfahren, 105 Mrd. $ Restwertgarantien | die Oktober-Signale: OpenAI-Run-Rate, Beteiligungen, H200-Abgabe |
| MSFT | Tiefe: Wettbewerb, Regulierung, 45 % des Auftragsbestands von OpenAI | Engpass bis 2027, Strom und Gebäude, E7, Preismodell |
| AAPL | Brief: Quartal, Patenturteil über 5,7 Mrd. $, Prüftermin 29.10. | Duo-Preis, Preiserhöhungen wegen Speicher, Datenschutzkritik |
| SAP | Tiefe: Margen, Cashflow, richtige Prognose, Kartellamt, Celonis, Migrationsstand | JPMorgan »KI-gefährdet« (4.10.), Accenture-Partnergeschäft |
| NU | Tiefe: Kreditrisiken, Finanzvorstand, Mexiko-Regulierung | US-Start, Nu Global, Umsatz je Kunde gegen etablierte Banken |
| ARGX | Tiefe: Wettbewerb, verfehlte Untergruppe, Kostenträger, Meilensteine | nichts zur Firma |
| STR.VI | Tiefe: S&P zur Marge, Segmentverlust, Kartellstrafe, Rasperia-Klage | nichts zur Firma |
| CRWV | Brief: Q2, Prognose, Zinslast, Prüfgrößen | Kunden, Moody's-Rating, SemiAnalysis-Ranking, zugesagte gegen laufende Leistung |

**distill** ist die einzige Quelle für die Tage nach dem Brief und hat bei einzelnen Firmen exklusive
Belege zur Position. Daneben ein Viertel bis die Hälfte Chartmarken und Bewertung, Sektordossiers über
fremde Branchen (Autos bei Nike, Chips und Hyperscaler bei Apple und SAP) und Zahlen aus zweiter Hand,
teils falsch datiert (MSFT: RPO vom 29.7. als 24.9.).

**Der Perplexity-Brief** liefert die Quartalszahlen und Gegenargumente mit Prüfpunkt, ist aber eine
Woche alt. Er etikettiert zu großzügig (Firmenzahlen und Management-Deutungen als »unabhängig«), rechnet
falsch (ORCL: RPO +15 % statt +20 %, OCI-Vorquartal aus dem Vorjahreswachstum abgeleitet) und nennt
unmögliche Termine (NKE: Q3-Bericht vor Quartalsende).

**Die Tiefenrecherche** ist die breiteste Quelle: Regulierung und Wettbewerb fast nur dort, und sie
korrigiert den Brief mehrfach (SAP-Prognose, NKE-Prognose, ARGX-Myositis, STR.VI-Termine). Sie ist kaum
aktueller, viel liegt über 30 Tage zurück, sie überetikettiert ebenfalls und nennt Termine an
Wochenenden (NVDA, MSFT). Über die API kam sie für AAPL und SAP als Fließtext statt gegliedert zurück;
SAP bricht mitten im Satz ab, obwohl die API `stop` meldet. Sie kostete über die API 0,59–0,89 $ je Aktie.

## Was daraus folgt

1. **Ohne distill käme der Screener inhaltlich aus.** Der Narrativ-Score bliebe im Rauschen gleich;
   verloren gingen die Tage nach dem Brief und bei einzelnen Firmen exklusive Belege.
2. **Die Gewichte passen nicht zum Beitrag.** Vorschlag, vor dem Bauen zu messen: das Firmendossier nach
   eigenem Inhalt gewichten statt pauschal 0,5 (ohne Chartsätze, eine Leerformel zählt nichts), und die
   Tiefenrecherche als eigene Quelle zählen statt im Maximum mit dem Brief.
3. **»Unabhängig« schärfen,** in Brief und Tiefenrecherche: nur für Belege, die nicht vom Unternehmen
   stammen. Eine Frage an die Perplexity-Prompts.
4. **Tiefenrecherche über die API prüfen:** Warum kam sie für AAPL und SAP ungegliedert zurück, und
   warum endet SAP mitten im Satz? Ungegliedert zählt sie mit dem pauschalen Altgewicht.
5. **Aktualität ist distills eigentlicher Beitrag.** Ein Brief, der sieben Tage alt sein darf, lässt die
   Lücke, die distill füllt; ob ein kürzeres Fenster für den Brief distill ersetzt, wäre eine Kostenfrage.

## Umgesetzt am 10.10.2026

- **distill aus der Analyse:** `scoring.distill`, ab jetzt aus. Der nächtliche Schritt holt die
  Dossiers weiter und hebt sie auf; die Analyse liest sie nur, wenn der Schalter in der Verwaltung an
  ist (Karte »2 · Distill«, »In die Analyse«).
- **Neue Gewichte** (`SOURCE_WEIGHT` in `src/score-service.ts`): Brief bis 0,6, Tiefenrecherche bis
  0,3 daneben statt als das bessere von beiden, Firmendossier 0,2, nur Insights 0,1, Sektoren 0,05,
  Suche 0,1. Ein Bericht als Fließtext bringt die Hälfte seines Gewichts.
- **Wirkung** (`gewichte.ts`, alle 139 Aktien, gespeicherte Dokumente und jüngstes Urteil, ohne
  Modell-Call): Der Anteil der Narrative-Stufe am Gesamturteil sinkt im Median von 30 % auf 23 %; mit
  Tiefenrecherche bleibt er bei 28 % (alt 29 %). Über 30 % lagen 71 Aktien, jetzt 6. Die gespeicherten
  Briefs tragen noch die alten, zu großzügigen Etiketten; mit der Herkunft statt des Ja oder Nein
  bleiben im Probelauf (ORCL, NKE, NVDA, AAPL) drei von vier bei vollem Gewicht, Nike bei zwei
  Dritteln.
