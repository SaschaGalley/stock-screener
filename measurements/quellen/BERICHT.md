# Was trägt welche Quelle? distill, Perplexity-Brief und Tiefenrecherche, 10.10.2026

Sechs Aktien: NU, ARGX und STR.VI, die drei mit einer Tiefenrecherche, dazu ORCL, NKE und CRWV, bei
denen im Blindvergleich (`../dossier-guidance/BERICHT.md`) die alte distill-Lesung vorn lag. Eine
Erkundung, keine Messung mit Vorschrift: sechs Aktien, ein Stand, drei Lesungen je Zelle.

**Ergebnis:** Den Narrativ-Score bestimmt im Wesentlichen Perplexity; distill verschiebt ihn um
höchstens 0,6 Punkte. distill bestimmt aber, wie viel der Score im Gesamturteil wiegt: Mit einem
Firmendossier steigt die Confidence der Narrative-Stufe von rund 0,27 auf 0,75–0,90, weil jedes nicht
leere Dossier pauschal 0,5 zählt und Perplexity höchstens 0,3. Inhaltlich trägt in allen sechs
Vergleichen Perplexity oder die Tiefenrecherche am meisten; distill liefert Ergänzungen der letzten Tage
und viel Rauschen. Die Gewichte stehen damit umgekehrt zum Beitrag.

## Quellen

| Aktie | distill-Firmendossier (9.10.) | Perplexity sonar-pro | Tiefenrecherche |
|---|---|---|---|
| NU | 2.102 Zeichen | 3.10. | 6.10. |
| ARGX | keins, nur Sektor | 3.10. | 7.10. |
| STR.VI | keins, nur Sektor | 5.10. | 7.10. |
| ORCL | 12.890 Zeichen mit Sektor | 3.10. | – |
| NKE | 6.656 mit Sektor | 3.10. | – |
| CRWV | 12.923 mit Sektor | 3.10. | – |

## Die Narrative-Stufe je Quelle (`lauf.ts`, `roh/lesungen.jsonl`)

Die echte Stufe (`gpt-5.4-mini`, drei Lesungen, Median) mit D = distill, P = Perplexity-Brief,
R = Tiefenrecherche. Confidence wie in der Produktion (`narrativeMaterial` × Faktor aus der Spanne).

| Aktie | D | P | R | DP | PR | DPR |
|---|---|---|---|---|---|---|
| NU | 7,0 / 0,60 | 7,5 / 0,27 | 6,5 / 0,30 | 8,0 / 0,82 | 8,0 / 0,27 | 8,0 / 0,82 |
| ARGX | – / 0,07 | 7,5 / 0,27 | 6,5 / 0,18 | 7,0 / 0,30 | 8,0 / 0,22 | 7,0 / 0,33 |
| STR.VI | – / 0,07 | 7,5 / 0,04 | 7,0 / 0,27 | 7,0 / 0,14 | 7,0 / 0,30 | 7,0 / 0,33 |
| ORCL | 5,0 / 0,55 | 6,0 / 0,25 | | 6,0 / 0,75 | | |
| NKE | 4,0 / 0,58 | 3,0 / 0,27 | | 3,0 / 0,90 | | |
| CRWV | 7,5 / 0,54 | 6,3 / 0,27 | | 6,9 / 0,90 | | |

Score / Confidence; – heißt Enthaltung. Jede Kombination mit Perplexity bewertet alle oder fast alle
fünf Dimensionen. distill allein enthält sich bei den Aktien ohne Firmendossier.

- **Score:** DP gegen P unterscheidet sich um 0,0 bis 0,6 Punkte. Wo distill allein abweicht (ORCL 5,0,
  CRWV 7,5), zieht Perplexity das Ergebnis zu sich.
- **Confidence:** Mit Firmendossier 0,75–0,90, ohne 0,25–0,30. Die Tiefenrecherche hebt sie nicht, weil
  sie mit dem Brief als *eine* Quelle zählt (das bessere von beiden). STR.VI zeigt die andere Seite: Der
  Brief findet kaum unabhängige Belege und bringt nur 0,04, die Tiefenrecherche 0,27.

## Die Quellen im Vergleich

Je Aktie las eine frische Claude-Instanz die drei Texte nebeneinander, nach einem festen Raster
(Aktualität, Abdeckung der fünf Dimensionen, harte Zahlen, Belegart, Gegenargumente, Exklusives,
Widersprüche, Rauschen). Im Kern:

| Aktie | trägt am meisten | was nur distill hat | was ohne distill fehlte |
|---|---|---|---|
| ORCL | Perplexity: Q1-Zahlen, Prognose, Finanzierungslücke, Prüftermin 10.12. | die Woche nach dem Brief: OpenAI-Umsatzrate, Anleihe bei 82 Cent, CDS; Oracles Gegendarstellung zur Force Majeure | die jüngste Kreditmarkt-Lage und eine Korrektur an Perplexitys Lesart |
| NKE | Perplexity: Q1-Zahlen, Prognose, China-Anteil 27 → 16 %, Stornierungen | Nike Mind, Rückkehr in den Handel, Imageschaden in China | wenig; der neuere Stand ist fast nur Chartkommentar |
| CRWV | Perplexity: Q2-Zahlen, Prognose, Zinslast, Prüfgrößen bis 16.11. | Kunden (OpenAI, Meta mit Zahlungspflicht), Moody's-Investment-Grade, SemiAnalysis-Ranking, 4,2 GW zugesagt gegen 1,5 GW in Betrieb | die einzigen Belege zur Wettbewerbsposition |
| NU | Tiefenrecherche: Kreditrisiken (98 % unbesichert), Finanzvorstand, Mexiko-Regulierung | US-Start, Nu Global, Umsatz je Kunde gegen etablierte Banken | die Produktseite und eine Gegenprobe zu einer Zahl der Tiefenrecherche |
| ARGX | Tiefenrecherche: Wettbewerb (EPIC), verfehlte Untergruppe, Kostenträger, Meilensteine | nichts zur Firma | nichts |
| STR.VI | Tiefenrecherche: S&P zur Marge, Segmentverlust, Kartellstrafe, Rasperia-Klage | nichts zur Firma | nichts |

Weitere Befunde aus den Vergleichen:

- **Rauschen in distill:** ein Viertel bis 40 % Chartmarken bei ORCL, NKE und CRWV, dazu Sektordossiers
  über andere Branchen (Autos und Restaurants bei Nike, Marktbreite und Micron bei Oracle).
- **Perplexity etikettiert zu großzügig:** Firmenzahlen stehen als »unabhängig belegt« da, bei ORCL alle
  sechs Thesen. Dazu Rechenfehler (ORCL: RPO +15 % statt +20 %) und eine zu positive Lesart
  (ARGX: verfehlte Untergruppe bei Myositis nicht erwähnt).
- **Die Tiefenrecherche korrigiert den Brief** bei ARGX und STR.VI: Termine, fehlende Zahlen, die
  Lesart der Marge, die angebliche Prognose von argenx. Aktueller als der Brief ist sie kaum; fast
  nichts liegt nach Mitte September.
- **Der Brief ist eine Woche alt** (3.10.), distill vom 9.10. Was in dieser Woche geschah, steht nur in
  distill (ORCL: Anleihe und OpenAI-Zahlen).

## Was daraus folgt

1. **Ohne distill käme der Screener inhaltlich aus**, verlöre aber die letzten Tage und bei einzelnen
   Firmen Belege zur Position (CRWV, NU). Der Narrativ-Score bliebe nahezu gleich.
2. **Die Gewichte stimmen nicht mit dem Beitrag überein.** Das Firmendossier zählt pauschal 0,5, auch
   als Leerformel; Perplexity zählt nach unabhängigen Belegen bis 0,3, die Tiefenrecherche nicht
   zusätzlich. Ein Vorschlag, zu messen bevor er gebaut wird: distill nach eigenem Inhalt gewichten
   (Länge ohne Chartsätze, oder ganz ohne Pauschale), die Tiefenrecherche als eigene Quelle zählen.
3. **Die Etiketten des Briefs schärfen:** »unabhängig« nur für Belege, die nicht vom Unternehmen
   stammen. Das ist eine Frage an den Perplexity-Prompt.

## Offen

Der Eigentümer trägt Tiefenrecherchen für bekannte Firmen nach (vorgeschlagen: ORCL, NKE, NVDA, MSFT,
AAPL, SAP). Dann laufen `lauf.ts` und der Vergleich für diese Aktien noch einmal.
