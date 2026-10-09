# Messvorschrift: Verbessert die neue Dossier-Vorgabe von distill die Narrative-Stufe?

Festgelegt am 09.10.2026 gegen 23:45 Wiener Zeit, bevor ein Call der Messung lief. Anlass ist der
Auftrag aus der distill-Sitzung „Dossiers und Briefings Status“: distill hat für das Projekt
`stock-screener` am 09.10.2026 gegen 11:00 UTC auf die neue Dossier-Vorgabe umgeschaltet
(Wortlaut: distill-Repo, `packages/service/src/pipeline/measurements/dossier-guidance/fassungen-4.json`),
dazu die Verdichtung ab einem Insight und eine Längengrenze je Dossier-Call. Ein Rendite-Vergleich mit
`evaluate` zeigt bei rund 40 Aktien über Monate nichts; gemessen wird deshalb die Stufe, die die
Dossiers liest.

## Frage

Liest die Narrative-Stufe von stock-cli aus den neuen Paketen etwas, auf dem der Eigentümer lieber
entscheidet, ohne dass sie an Abdeckung, Belegtreue oder Stabilität verliert?

## Pakete

Ein Paket ist das `documents`-Dokument der Art `distill` eines Symbols aus der Produktion
(`https://stockcli.troop.at`, gelesen über `GET /api/stocks/:symbol/documents/distill`): Firmendossier,
Sektordossiers und die rohen Insights, die das Dossier nicht wiedergibt.

- **alt:** je Symbol das jüngste Dokument mit `produced_at` vor 2026-10-09 11:00 UTC. Das ist der Abruf
  von 01:30 Wien am 09.10.; Stand der Erhebung: alle 139 Symbole haben eines, 94 davon mit Firmendossier,
  gebaut am 08.10. gegen 22 UTC unter der alten Vorgabe.
- **neu:** das Dokument, das der nächtliche Abruf am 10.10. um 01:30 Wien (ab 2026-10-09 23:00 UTC)
  gesehen hat: das jüngste mit `produced_at` vor 2026-10-10 05:00 UTC, sofern sein `produced_at` oder
  `last_seen_at` nach 2026-10-09 23:00 UTC liegt.
- Pakete mit `produced_at` am 09.10. zwischen 11:00 und 23:00 UTC werden nicht verwendet; sie können
  gemischt sein. (Zum Zeitpunkt dieser Vorschrift gab es keines.)

Ein Symbol ist **geeignet**, wenn es beide Pakete hat, jedes nicht leere Dossier im alten Paket vor
2026-10-09 11:00 UTC und jedes im neuen danach gebaut wurde (`builtAt`), und die beiden Pakete nicht
wörtlich gleich sind. Als Erstes wird das je Symbol geprüft und protokolliert.

**Schichten:** S1 hat in beiden Paketen ein Firmendossier mit Text, S2 alle übrigen geeigneten (nur
Sektorkontext). Die Kriterien unten gelten für S1; S2 wird nur berichtet.

## Lauf

- **Code:** die echte Narrative-Stufe auf dem Stand von `07222a1`: `buildNarrativePrompt(f, paket)` aus
  `src/output/prompt.ts`, System-Prompt `SYSTEM_SUMMARISER` aus `src/score-service.ts` (im Skript
  kopiert und beim Start gegen die Quelle geprüft), `NarrativeOutputSchema`, `maxTokens` 4000,
  `createProviderForModel` mit dem Modell der Produktion (`scoring.summaryModel` = `gpt-5.4-mini`).
- **Nur distill:** keine Perplexity, keine Tiefenrecherche, keine Suchtreffer, keine native Suche. Die
  Firmenangaben `f` (Symbol, Name, Sektor, Branche) kommen einmal aus der Produktion
  (`GET /api/stocks/:symbol`) und sind in beiden Armen dieselben.
- **Lesungen:** je Symbol und Arm drei unabhängige Calls desselben Prompts (`NARRATIVE_SAMPLES`),
  zusammengeführt wie in der Produktion mit `narrativeScoreFrom` und `combineNarrativeReads`;
  Confidence = `narrativeMaterial(paket).confidence × confidenceFactor`. Je Symbol laufen die sechs
  Calls (alt 1–3, neu 1–3) gleichzeitig, damit kein Arm eine andere Tageszeit des Anbieters trifft.
  Eine gescheiterte Lesung fällt weg wie in der Produktion und wird als Fehlschlag gezählt.
- **Wegwerf-Skript** (`lauf.ts`): liest nur über die API, schreibt nichts in die Datenbank von
  stock-cli (keine `documents`, keine `observations`, keine Score-Serie). Es läuft mit einer
  `DATABASE_URL`, die auf keinen Server zeigt, damit ein versehentlicher Zugriff scheitert statt
  schreibt. Rohausgaben je Lesung als JSONL in `roh/` (Symbol, Arm, Lesung, Dokument-ID, `produced_at`,
  `builtAt`, Hash und Länge des Prompts, Ausgabe oder Fehler, Dauer).
- **Probelauf:** zwei Symbole nur mit dem alten Paket, um die Mechanik zu prüfen. Er wird verworfen und
  nicht ausgewertet.
- **Bewertung getrennt** (`auswertung.py`): liest nur `roh/` und `beleg/` und lässt sich ohne neue Calls
  beliebig wiederholen.

## Metriken je Arm

1. **Abdeckung:** bewertete Dimensionen (von fünf, Bewertung statt `null`) je Lesung, je Symbol gemittelt;
   Enthaltungen (kombinierter Narrativ-Score `null`).
2. **Umfang:** Thesen je Seite (bull, bear) und Ereignisse je Lesung.
3. **Stabilität:** Confidence wie in der Produktion und Spanne zwischen den drei Lesungen.
4. **Verschiebung:** kombinierter Narrativ-Score neu minus alt je Symbol; Median von |Δ|, Anteil mit
   |Δ| ≥ 1, verglichen mit der Spanne innerhalb eines Arms. Gilt als „im Rauschen“, wenn der Median von
   |Δ| nicht über dem Median der Spanne liegt.
5. **Beleg:** Jede These und jedes Ereignis aller drei Lesungen wird gegen das Paket des eigenen Arms
   geprüft, so wie die Stufe es gesehen hat (der gerenderte distill-Abschnitt des Prompts): *belegt*,
   *teilweise* (Kern belegt, ein Detail nicht) oder *nicht belegt*. Prüfer ist ein Modell einer anderen
   Familie als die Stufe (`claude-sonnet-5-5`), ein Call je Symbol und Arm, nur S1. Seine Antworten liegen
   als JSONL in `beleg/`. Kalibriert wird er an 30 Urteilen, von Hand gegen das Paket nachgelesen
   (zehn je Klasse, sofern vorhanden); die Übereinstimmung steht im Bericht. Zusätzlich ohne Modell:
   Zahlen in Thesen und Ereignissen, die im Paket nicht vorkommen.
6. **Kursmarken:** wie viele der Kursmarken des Firmendossiers irgendwo in der Ausgabe stehen
   (Zusammenfassung, Ereignisse, Thesen, Notizen der Dimensionen). Die Marken zieht der Extraktor aus
   Teil 2 (`CHARTMARKEN.md`); er wird an distills Dossiers kalibriert und eingefroren, bevor die Ausgaben
   dieses Laufs ausgewertet werden. Die Stufe soll laut Prompt keine Kursmarke verwenden („Kurs, KGV,
   Multiples, Kursziele … fließen in keine Dimension“); jede Marke in der Ausgabe ist also ein
   Durchsickern, kein Gewinn.
7. Beschreibend: Länge der Pakete und Prompts, Fehlschläge, Kosten.

## Urteil des Eigentümers

Zwölf Aktien aus S1, vor dem Lauf ausgelost (`random.Random(20261010)`, je Drittel der Länge des alten
Firmendossiers die ersten vier der gemischten Reihenfolge; fällt eine aus S1 heraus, rückt die nächste
desselben Drittels nach):

| Drittel | Länge alt | Auswahl | Ersatz in dieser Reihenfolge |
|---|---|---|---|
| kurz | 176–1.761 | JD, OKTA, PFE, RBRK | BIIB, SEDG, PYPL |
| mittel | 1.876–3.196 | MRVL, AXON, NU, LMT | INTC, MRNA, NET |
| lang | 3.227–8.312 | BYDDF, CRWV, ORCL, NKE | META, ALV.DE, AVGO |

Je Aktie stehen die beiden behaltenen Lesungen nebeneinander (die Median-Lesung, die auch die
Produktion behält): Zusammenfassung, Ereignisse, Thesen, Dimensionen mit Notiz, Narrativ-Score. Die
Etiketten A und B sind je Aktie zufällig verteilt; die Zuordnung liegt getrennt und wird erst nach dem
Urteil geöffnet. Die Frage: „Auf welcher Lesung würdest du lieber entscheiden?“ Antworten: A, B oder
gleich.

## Abnahme

**Hauptkriterium**, das eigentliche: Die neue Vorgabe *verbessert* die Analyse, wenn der Eigentümer bei
mindestens 7 der 12 Aktien die neue Lesung vorzieht und bei höchstens halb so vielen die alte. Umgekehrt
(mindestens 7 für alt, höchstens halb so viele für neu) *verschlechtert* sie sie. Alles dazwischen ist
*kein klarer Unterschied*.

**Leitplanken** über S1, die mit der neuen Vorgabe nicht verletzt sein dürfen:

- L1 Abdeckung: Median der Differenz neu minus alt der bewerteten Dimensionen je Symbol ≥ −0,5, und
  höchstens drei Enthaltungen mehr als alt.
- L2 Beleg: *nicht belegt* höchstens 10 % aller Thesen und Ereignisse und höchstens 3 Prozentpunkte über
  alt.
- L3 Stabilität: Median der Spanne höchstens 0,5 Punkte über alt.

Ohne Kriterium berichtet: Umfang, Verschiebung, Kursmarken in der Ausgabe.

Gesamturteil „verbessert“ nur bei erfülltem Hauptkriterium und allen drei Leitplanken. Eine verletzte
Leitplanke wird mit ihrer Ursache berichtet, nicht wegdefiniert.

## Bekannte Störgrößen

- **Fensterversatz:** Das neue rollierende Dossier deckt ein um einen Tag späteres 30-Tage-Fenster ab
  als das alte. Ein Arm „alte Vorgabe, gleiches Fenster“ kann distill nachbauen, falls das beim Vergleich
  stört.
- **Drei Änderungen auf einmal:** Vorgabe, Verdichtung ab einem Insight und Längengrenze wurden
  gemeinsam umgeschaltet; die Messung trennt sie nicht.
- **Ein Modell, eine Nacht, drei Lesungen** je Zelle.

## Kosten (geschätzt)

Etwa 830 Lesungen auf `gpt-5.4-mini` und etwa 190 Prüfer-Calls auf `claude-sonnet-5-5`, zusammen unter
25 $.

## Datenschutz

Es gelten die Regeln der `CLAUDE.md`: Die Messung liest nur `documents` der Art `distill` und die
Firmenangaben, nichts aus `trades`, `holding_prices`, `depot_checks` oder den Depot-Einträgen in
`app_state`. Die Pakete enthalten öffentliche Markt-Kommentare, keine Depotdaten.
