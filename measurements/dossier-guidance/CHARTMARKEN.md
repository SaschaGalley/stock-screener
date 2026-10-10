# Kursmarken aus den distill-Dossiers: Messung und Entwurf

Teil 2 des Auftrags aus der distill-Sitzung „Dossiers und Briefings Status“, ohne Modell-Calls. Gemessen
am 10.10.2026 an den Paketen des nächtlichen Abrufs (01:30 Wien) und der Chart-Analyse der Produktion
vom selben Morgen. Zahlen: `chartmarken-ausgabe.md`, gezogene Marken: `chartmarken-roh.jsonl`.

**Ergebnis:** Seit der neuen Vorgabe tragen 60 von 94 Firmendossiers Kursmarken, 35 davon fünf oder mehr
(vorher 7). Die Zahlen lassen sich aus der Prosa gut ziehen, ihr Drumherum nicht: Art, Datum, Quelle und
ob eine Marke gebrochen ist, stehen nur unregelmäßig da. Ein Abgleich mit den berechneten Marken sagt
nahe am Kurs nichts: Dort trifft schon der Zufall in drei von vier Fällen. Der Entwurf zeigt die Marken
deshalb als eigene Ebene mit Quelle und Datum, statt Übereinstimmung zu behaupten, und bittet distill um
eine strukturierte Liste.

## Extraktion

`kursmarken.py` nimmt einen Geldbetrag als Marke, wenn ein Chartwort in seiner Nähe steht und er kein
Volumen, keine Kennzahl, kein Betrag je Einheit, kein Kursverlauf und nicht der Kurs selbst ist.
Spannen werden Zonen.

| Prüfung | Daten | Präzision | Trefferquote |
|---|---|---:|---:|
| Abstimmung | distill F1, F2 (sechs dicke Firmen) gegen `chartmarken.json` | 128/128 | 128/128 |
| Abstimmung | 80 Treffer aus alten Produktionsdossiers, von Hand beurteilt | 3 Fehler übrig | keine echte Marke verloren |
| Prüfung | distill F3, nicht abgestimmt | 65/67 | 65/65 |
| Prüfung | 40 Treffer aus den neuen Produktionsdossiers, von Hand | 39/40 | – |
| Prüfung | 30 von 62 nicht gezogenen Beträgen der neuen Dossiers, von Hand | – | 10 davon wären Marken, hochgerechnet ≈ 94 % |

Die Abstimmung endete, bevor eine Ausgabe des Laufs aus Teil 1 vorlag; die neuen Dossiers waren für den
Extraktor ungesehen. Was er auslässt: Spannen ohne Chartwort (»seitwärts zwischen 32 $ und 46 $«), eine
Marke am Satzanfang (»Above $240, …«), »potential bottom«, »limiting risk below«, und eine Zone, die
»earnings-low zone« heißt. Was er fälschlich nimmt: den Kurs in »reported shares at about $350«, Ziele
anderer Firmen in Sätzen über mehrere Firmen (Deutsche Bank über SpaceX).

## Wie viele Dossiers tragen Marken?

| | alt (8.10.) | neu (9.10.) |
|---|---:|---:|
| Firmendossiers mit Text | 94 | 94 |
| mit mindestens einer Marke | 41 | 60 |
| mit mindestens fünf | 7 | 35 |
| Median je Dossier | 0 | 3 |

Die alten Zahlen enthalten Fehltreffer des Extraktors; auf alten Dossiers lag seine Präzision vor der
Abstimmung bei 72–78 %. Marken tragen vor allem lange Dossiers: unter 2.000 Zeichen 13 von 41, ab 4.000
Zeichen 26 von 27. Bei dünnen Firmen gibt es nichts zu ziehen.

## Was an den Marken hängt

- **Datum:** 230 von 416 Marken (55 %) stehen in einem Satz mit Datum. Von den 138 Marken in einem Satz,
  der mit »On September …/On October …« beginnt, sind 40 (29 %, in 11 Aktien) älter als 14 Tage gemessen
  am Ende des Dossier-Fensters. Die 14-Tage-Regel der Vorgabe hält in der Produktion also nicht so wie im
  Messlauf von distill (3 % alte Marken in Arm F).
- **Währung:** 21 von 416 Marken stehen in einer anderen Währung als der Chart, etwa Dollar-Marken bei
  Airbus oder Nike (Euro-Kursziel bei einer Dollar-Notierung).
- **Art und Quelle:** Unterstützung, Widerstand, Ziel oder Ausbruch steht nur als Wort im Satz; die Quelle
  oft im Satz davor. Beides aus der Prosa zu ziehen, wäre eine zweite Heuristik über der ersten.

## Treffen sie die berechneten Marken?

Treffer heißt: Die Zone der Dossier-Marke, erweitert um das Band, das `analysis/chart.ts` selbst für
eine Marke nutzt (max(0,6 × ATR, 0,8 % des Kurses)), enthält eine berechnete Marke. Zufall heißt:
dieselbe Marke, relativ zum Kurs, gegen die berechneten Marken jeder anderen Aktie.

| Abstand zum Kurs | Marken | Treffer | Zufall |
|---|---:|---:|---:|
| −35 bis −15 % | 50 | 50 % | 25 % |
| −15 bis −5 % | 79 | 86 % | 65 % |
| −5 bis +5 % | 117 | 79 % | 76 % |
| +5 bis +15 % | 44 | 52 % | 58 % |
| +15 bis +35 % | 40 | 50 % | 24 % |
| zusammen | 330 | 69 % | 57 % |

Die berechneten Marken liegen zu viert auf jeder Seite im Fenster ±35 %, also dicht um den Kurs. Ein
Satz »Kommentatoren nennen 132 $, das deckt sich mit der berechneten Zone« wäre dort meist Zufall. Über dem
Zufall liegen nur Unterstützungen 5 bis 15 % unter dem Kurs und die fernen Marken, wo auch die
berechneten oft das Jahreshoch oder -tief sind, das Kommentatoren ebenfalls nennen. Ein Widerspruch
lässt sich gar nicht sauber fassen: Kommentatoren nennen mehr Marken als der Code (330 gegen 379 bei
57 Aktien), und eine Marke ohne berechnetes Gegenstück widerspricht keiner.

## Was Teil 1 dazu zeigt

Die Narrative-Stufe soll keine Kursmarken verwenden. Mit den neuen Paketen stehen sie trotzdem in 121 von
279 Lesungen (alt 47), vor allem als *Ereignis*: 19 % der Ereignisse sind jetzt Chartkommentar (alt 6 %),
etwa »Am 7. Oktober nannte ZipTrader 235 $ als Ausbruchsmarke«. Laut Prompt sind Ereignisse Aufträge,
Zulassungen, Rückrufe, keine Einschätzungen. Über die Thesen erreichen die Marken heute schon den Bull-
und Bear-Case, ungeordnet und ohne Abgleich.

## Entwurf (nicht gebaut)

1. **Keine Übereinstimmungssätze.** Nahe am Kurs sagen sie nichts, fern vom Kurs selten etwas Neues.
2. **Eine eigene Ebene auf der Chartseite:** »Marken aus den Quellen«, getrennt von den berechneten, als
   kurze Striche an der Preisachse und darunter eine Liste: Preis oder Zone, Art, wer, wann. Älter als
   14 Tage blass, in fremder Währung ausgeblendet. Kein Einfluss auf Score, Urteil oder Timing; die
   Ebene sagt, was gesagt wird, nicht was stimmt.
3. **Auslöser im Bull- und Bear-Case:** Die Synthese darf eine Quellenmarke als beobachtbaren Auslöser
   nennen, nur mit Urheber und Datum (»Schluss unter 220 $, die Marke, die 10xTrading am 1.10. als
   Grenze nannte«). Vorher und nachher messen, ob die Auslöser konkreter werden, ohne dass mehr erfunden
   wird.
4. **Die Narrative-Stufe von den Marken freihalten:** entweder die Chart-Sätze aus ihrem Prompt nehmen
   oder ausdrücklich sagen, dass Kursmarken und Chartkommentare keine Ereignisse und keine Thesen sind.
   Gehört zu Teil 1 und ist dort zu messen, nicht hier.
5. **Datenweg: strukturiert von distill.** Die Zahlen gehen aus der Prosa, Art, Datum, Quelle, Währung und
   Status (gebrochen oder nicht) nicht verlässlich. Statt einer zweiten Heuristik in stock-cli: distill
   liefert je Firmendossier eine Liste
   `{ low, high, currency, kind: support|resistance|target|breakout|stop, date, source, status }`
   neben dem Text. Das ist eine Änderung auf distill-Seite und wird dort gemeldet, nicht hier gebaut.
6. Bis die Liste da ist, reicht der Extraktor für eine Vorschau der Ebene in Punkt 2 (Präzision 39/40),
   dann ohne Art und mit Datum nur, wo es im Satz steht.

## Für die distill-Sitzung, und ihre Antwort (10.10.)

- **14-Tage-Regel:** 40 von 138 klar datierten Marken sind älter (29 %, 11 Aktien), im Messlauf 3 %.
  distill bestätigt: Die Regel hält in der Produktion nicht verlässlich. Deutlichstes Beispiel ist AMD,
  dessen Dossier die ganze Markenliste einer Quelle vom 22.09. trägt und eine Zone doppelt führt. Die 29 %
  sind eine Obergrenze: Einige der markierten Sätze sind keine Chartmarken (PayPal-Offerte, BABA,
  SNDK), andere Zonen wurden später erneut genannt und verletzen dann die Regel »nur die jüngste je
  Zone«. Die 3 % des Messlaufs waren anders gemessen (Handliste, Alter nach letzter Nennung in den
  Eingaben). Der Fix wartet auf den Eigentümer.
- **Leerformeln:** bestätigt; rein leer sind JNJ und PFE, bei BMW, Mastercard und Boeing hängt der Satz
  an einem Fakt. Ursprung ist eine Tageskachel aus einem einzigen Insight über eine andere Firma.
  Vorschlag von distill: ein Satz in der Vorgabe, leer zu antworten statt das Fehlen zu beschreiben;
  dann meldet die API `state: empty` und liefert die rohen Insights trotzdem. Vom Eigentümer
  freigegeben und von distill an 60 protokollierten Calls gemessen (ai-troop/distill#412): reine
  Leerformeln in 97 von 99 Läufen leer (vorher 19), angehängte Leerformeln in allen 45 Läufen weg,
  normale Dossiers nie leer und im Median 0,94-mal so lang. Bei Sektoren ersetzt dieselbe Regel
  »keep the dossier short«. Die 14-Tage-Regel löst das nicht; dafür steht ai-troop/distill#413 und
  wartet auf die Entscheidung zu strukturierten Kursmarken.
  **Am 10.10. eingeschaltet und wieder zurückgenommen:** Die Regel leerte auch knappe Dossiers mit echtem
  Inhalt (Tageskacheln von Microsoft, Nebius, Oracle und Sea Limited, rollierend Snowflake und Lockheed
  Martin), und weil eine leere Tageskachel als wiedergegeben zählt, kamen deren Insights auch nicht roh
  nach (ai-troop/distill#419). Die Messung hatte nur sehr kurze Leerformeln und dicke Kontrollen. Die
  Vorgabe ist wieder Fassung 4, 126 Tages- und 58 rollierende Dossiers sind neu gebaut; Johnson &
  Johnson und Pfizer tragen wieder ihre Leerformel. stock-cli hat in dieser Zeit nichts abgerufen
  (letzter Abruf 09.10., 23:30 UTC). Eine nächste Fassung nur nach einer Messung mit knappen, echten
  Dossiers als Kontrolle, auf Entscheidung des Eigentümers.
- **Strukturierte Marken**, Einschätzung von distill:
  - *A, aus dem fertigen Dossiertext:* ein bis zwei Tage, gewinnt gegenüber dem Extraktor nur Art,
    Status und Währung; Datum und Quelle bleiben so lückenhaft wie im Text. Abgeraten.
  - *B, aus den Insights je Firma und Tag:* rund 70 Calls pro Nacht. Datum und Quelle kommen
    verlässlich aus der Periodenachse, Zone, jüngste Marke je Zone, 14-Tage-Grenze und Status rechnet
    Code. Braucht einen allgemeinen Mechanismus für projektdefinierte Felder (eigene ADR), eine neue,
    ausgeschaltet startende Stufe, Tabelle, Nachlauf, Aggregation, API-Feld und Messung: eher eine
    Woche. Empfohlen, falls die Ebene kommt.
  - *C, Text und Marken in einem Call:* abgeraten.
- Nebenbei: Im Dossier der Bank of America stehen Broadcom-Marken. Laut distill kein aktuelles
  Problem: Das Dossier stammt vom 19.08., noch mit der alten Vorgabe, und wird nicht neu gebaut, weil
  die Bank of America nicht eingeschaltet ist; stock-cli bekommt dafür `not_enabled` und keinen Text.
