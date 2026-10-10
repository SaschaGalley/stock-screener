# Narrative-Stufe mit altem und neuem distill-Paket: Messlauf 2026-10-10

Vorschrift: `VORSCHRIFT.md`, festgelegt vor dem ersten Call. Zahlen: `auswertung-ausgabe.md`, erzeugt von
`auswertung.py` aus `roh/` und `beleg/`. Teil 2 (Kursmarken) steht in `CHARTMARKEN.md`.

**Ergebnis, vorläufig:** Das Hauptkriterium, das Urteil des Eigentümers im Blindvergleich, steht noch
aus. Von den Leitplanken halten Beleg und Stabilität; die Abdeckung ist nach der Vorschrift verletzt,
weil die neue Stufe bei 17 statt 9 Aktien keinen Narrativ-Score gibt. Sieben der zehn neuen
Enthaltungen sind Aktien, deren altes Dossier fast nur von anderen Firmen handelte (Novo Nordisk bei
Pfizer und Johnson & Johnson, Quantinuum bei BMW, Krypto und D-Wave bei Mastercard); ihre alten Scores
waren aus fremdem Text gelesen. Der Narrativ-Score verschiebt sich im Rauschen. Neu ist, dass die Stufe
Kursmarken als Ereignisse übernimmt: 19 % der Ereignisse sind jetzt Chartkommentar, vorher 6 %.

## Bestand

- 139 Symbole, alle geeignet: 93 mit Firmendossier in beiden Paketen (S1), 46 nur mit Sektorkontext (S2).
  Alle alten Firmendossiers wurden am 08.10. gegen 22 UTC gebaut, alle neuen nach der Umschaltung.
- Altes Paket: Abruf 09.10., 01:30 Wien. Neues Paket: Abruf 10.10., 01:30 Wien (der nächtliche Lauf der
  Produktion lief von 23:30 bis 23:52 UTC). Pakete aus dem Fenster dazwischen gab es keine.
- Je Symbol und Arm drei Lesungen auf `gpt-5.4-mini`, nur distill, Stand des Codes `07222a1`.
  833 von 834 Lesungen gültig; eine scheiterte am Schema (005930.KS, neu).
- Belegprüfung: 186 Zellen (S1 × 2 Arme) auf `claude-sonnet-5-5`, 6.151 Aussagen.

## Abweichungen vom Ablauf

- Der Rechner schlief in der Nacht mehrmals (Deckel zu). Der erste Lauf brach nach 38 Symbolen an einem
  Netzfehler zur Produktion ab; danach scheiterten bei 24 Symbolen Lesungen an Verbindungsfehlern und
  Zeitüberschreitungen zu OpenAI, jeweils alle sechs eines Symbols. Diese 24 Symbole wurden am Morgen
  vollständig neu gelesen, beide Arme gleichzeitig wie vorgesehen; ihre verworfenen Zeilen stehen in
  `roh/verworfen-netz.jsonl`. Fehlschläge des Modells selbst wurden nicht wiederholt.
- Der Prüfer lief zuerst mit 4, dann mit 12 parallelen Calls; fertige Zellen wurden nicht wiederholt.

## Metriken (S1, 93 Symbole)

| | alt | neu |
|---|---:|---:|
| Firmendossier, Median Zeichen | 2.669 | 2.432 |
| Prompt, Median Zeichen | 12.805 | 15.011 |
| bewertete Dimensionen je Lesung, Mittel | 3,97 | 3,68 |
| Enthaltungen (kombinierter Score null) | 9 | 17 |
| Bull-Thesen je Lesung | 3,61 | 3,52 |
| Bear-Thesen je Lesung | 3,85 | 3,73 |
| Ereignisse je Lesung | 3,50 | 3,83 |
| davon Chartkommentar | 6 % | 19 % |
| Narrativ-Score, Median | 6,9 | 6,6 |
| Spanne der drei Lesungen, Median | 0,5 | 0,5 |
| Symbole mit Spanne ab 1 | 26 | 14 |
| Lesungen mit einer Kursmarke des Dossiers | 47 von 279 | 121 von 279 |
| Aussagen *nicht belegt* | 0,4 % | 0,2 % |
| Aussagen *teilweise* belegt | 17,6 % | 15,7 % |

Das Firmendossier wird im Median kürzer, der Prompt länger: Die Sektordossiers sind mit der neuen
Vorgabe gewachsen. Die Lesungen kosten rund 14 % mehr Eingabe-Tokens.

**Dimensionen:** Am stärksten fällt *regulation* (bewertet in 67 % der Lesungen, neu 51 %), dann
*demand* (79 % → 73 %). Die neue Vorgabe will Quartalszahlen nur noch als Schluss einer Quelle; die
Stufe findet weniger, woran sie Nachfrage und Regulierung festmachen kann.

**Verschiebung:** 74 Symbole haben in beiden Armen einen Score. Δ neu − alt im Median 0,0, im Mittel
−0,22; niedriger bei 30, höher bei 13, gleich bei 31. |Δ| im Median 0,35, kleiner als die Spanne
innerhalb eines Arms (0,5): nach der Vorschrift im Rauschen. |Δ| ≥ 1 bei 15 Symbolen.

## Woher die neuen Enthaltungen kommen

| Aktie | Firmendossier alt → neu (Zeichen) | Was das alte Dossier war |
|---|---|---|
| JNJ | 1.023 → 83 | Novo Nordisk, J&J als Konkurrent aufgezählt |
| PFE | 1.023 → 116 | dasselbe |
| MA | 2.387 → 316 | Krypto-Infrastruktur, D-Wave, ein Trend-Screener |
| BMW.DE | 1.097 → 177 | Quantinuum, BMW als Erstkunde |
| STX | 730 → 136 | Börsenbericht und Broadcom |
| SIE.DE | 352 → 185 | Bewertung von Rockwell, Siemens als Vergleich |
| LMT | 2.439 → 786 | eigener Chartkommentar plus D-Wave und Voyager |
| ASML | 702 → 739 | in beiden nur ein Chart-Setup |
| LULU | 593 → 518 | in beiden nur Chartmarken |
| IFX.DE | 176 → 147 | in beiden eine Ranking-Zeile |

Umgekehrt bekommen ABBNY und WDC neu einen Score. Die neuen Dossiers dieser Aktien sagen jetzt, dass es
nichts gibt (»No stock-specific claims, price levels, or views on Johnson & Johnson are provided«); die
Stufe enthält sich, wie ihr Prompt es verlangt. Bei den drei reinen Chart-Dossiers hängt Enthaltung an
der Laune einer Lesung.

## Beleg

Der Prüfer stimmt in 29 von 30 von Hand nachgelesenen Urteilen (je zehn *nicht belegt*, *teilweise*,
*belegt*) mit dem Paket überein. Die eine Abweichung ist eine Grenze: »bindet Kunden über
wiederkehrende Umsätze« (Axon) hält er für *nicht belegt*, nachgelesen wäre es *teilweise*. *Teilweise*
heißt meist ein falsches oder erfundenes Datum, eine falsche Zuschreibung (»Management«, »unabhängige
Behördenberichte«) oder eine Sektoraussage als Firmenaussage. In einer Probe mit identischem Material
in beiden Armen wich er um ein Urteil von 39 ab.

## Abnahme

| Kriterium | Ergebnis |
|---|---|
| Hauptkriterium: Urteil des Eigentümers | **ausstehend** |
| L1 Abdeckung: Median Δ ≥ −0,5 und höchstens 3 Enthaltungen mehr | **verletzt**: Median Δ 0,0, aber 8 Enthaltungen mehr; Ursache oben |
| L2 Beleg: *nicht belegt* ≤ 10 % und ≤ alt + 3 Punkte | erfüllt: 0,2 % gegen 0,4 % |
| L3 Stabilität: Median der Spanne ≤ alt + 0,5 | erfüllt: 0,5 gegen 0,5 |

Nach der Vorschrift kann das Gesamturteil damit nicht »verbessert« lauten, auch wenn der Eigentümer die
neuen Lesungen vorzieht. Was die Leitplanke L1 hier misst, ist zum größten Teil der Wegfall von
Scores, die aus fremdem Text kamen; die Vorschrift hat diesen Fall nicht vorgesehen. Er wird hier
berichtet, nicht nachträglich herausgerechnet.

## Was daraus für stock-cli folgt

- **Ereignisse sind keine Chartkommentare.** Die Stufe übernimmt datierte Kursmarken als Ereignis. Eine
  Regel im Narrativ-Prompt (»Kursmarken, Chartmuster und Kursziele sind keine Ereignisse und keine
  Thesen«) oder das Entfernen der Chart-Sätze aus ihrem Material ist zu messen, bevor sie gebaut wird.
- **Leerformeln** wie »No stock-specific claims … are provided« sind ehrlich, kosten aber einen Prompt
  und eine Enthaltung. Ein Dossier unter einer Mindestlänge könnte als fehlend gelten.

## Grenzen

- Ein Abruf je Arm, ein Fenster, ein Modell, drei Lesungen je Zelle. Das neue Fenster endet einen Tag
  später als das alte.
- Vorgabe, Verdichtung ab einem Insight und Längengrenze wurden gemeinsam umgeschaltet; die Messung
  trennt sie nicht. Die neuen Enthaltungen gehen eher auf die Verdichtung zurück, die fremden Rohtext
  entfernt, als auf die Vorgabe.
- Der Prüfer ist ein Modell, an 30 Urteilen nachgelesen.
