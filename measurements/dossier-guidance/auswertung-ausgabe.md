# Auswertung: Narrative-Stufe mit altem und neuem distill-Paket

Erzeugt von `auswertung.py` aus `roh/` und `beleg/`; ohne Modell-Calls wiederholbar.

## Eignung

| Fall | Symbole |
|---|---:|
| S1 | 93 |
| S2 | 46 |

### S1: Firmendossier in beiden Paketen (93 Symbole)

| Metrik | alt | neu | Differenz neu − alt (Median je Symbol) |
|---|---:|---:|---:|
| Länge Firmendossier (Zeichen, Median) | 2669 | 2432 | -23 |
| Länge Prompt (Zeichen, Median) | 12805 | 15011 | 2015 |
| bewertete Dimensionen je Lesung (Median) | 4,67 | 4,33 | 0,00 |
| bewertete Dimensionen je Lesung (Mittel) | 3,97 | 3,68 | 0,00 |
| Bull-Thesen je Lesung (Mittel) | 3,61 | 3,52 | 0,00 |
| Bear-Thesen je Lesung (Mittel) | 3,85 | 3,73 | 0,00 |
| Ereignisse je Lesung (Mittel) | 3,50 | 3,83 | 0,00 |
| Narrativ-Score (Median) | 6,9 | 6,6 | 0,0 |
| Spanne zwischen den Lesungen (Median) | 0,5 | 0,5 | 0,0 |
| Spanne zwischen den Lesungen (Mittel) | 0,57 | 0,49 | 0,00 |
| Confidence (Median) | 0,55 | 0,55 | 0,00 |
| Kursmarken im Firmendossier (Median) | 0 | 3 | 0 |
| Kursmarken je Lesung in der Ausgabe (Mittel) | 0,36 | 1,23 | 0,00 |
| Enthaltungen (kombinierter Score null) | 9 | 17 | +8 |
| gescheiterte Lesungen | 0 | 0 | |
| Spanne 0 / unter 1 / ab 1 / ohne (Symbole) | 26 / 32 / 26 / 9 | 22 / 40 / 14 / 17 | |
| Lesungen mit mindestens einer Kursmarke aus dem Dossier | 47 von 279 | 121 von 279 | |
| Thesen und Ereignisse mit einer Zahl, die im Paket fehlt | 0,6 % | 0,8 % | |

### S2: nur Sektorkontext (46 Symbole)

| Metrik | alt | neu | Differenz neu − alt (Median je Symbol) |
|---|---:|---:|---:|
| Länge Firmendossier (Zeichen, Median) | 0 | 0 | 0 |
| Länge Prompt (Zeichen, Median) | 7680 | 8112 | 1160 |
| bewertete Dimensionen je Lesung (Median) | 0,00 | 0,00 | 0,00 |
| bewertete Dimensionen je Lesung (Mittel) | 0,42 | 0,20 | 0,00 |
| Bull-Thesen je Lesung (Mittel) | 0,95 | 1,07 | 0,00 |
| Bear-Thesen je Lesung (Mittel) | 2,14 | 2,30 | 0,00 |
| Ereignisse je Lesung (Mittel) | 0,14 | 0,13 | 0,00 |
| Narrativ-Score (Median) | 6,6 | – | – |
| Spanne zwischen den Lesungen (Median) | 0,2 | – | – |
| Spanne zwischen den Lesungen (Mittel) | 0,20 | – | – |
| Confidence (Median) | 0,07 | 0,07 | 0,00 |
| Kursmarken im Firmendossier (Median) | 0 | 0 | 0 |
| Kursmarken je Lesung in der Ausgabe (Mittel) | 0,00 | 0,07 | 0,00 |
| Enthaltungen (kombinierter Score null) | 44 | 46 | +2 |
| gescheiterte Lesungen | 0 | 1 | |
| Spanne 0 / unter 1 / ab 1 / ohne (Symbole) | 1 / 1 / 0 / 44 | 0 / 0 / 0 / 46 | |
| Lesungen mit mindestens einer Kursmarke aus dem Dossier | 0 von 138 | 3 von 137 | |
| Thesen und Ereignisse mit einer Zahl, die im Paket fehlt | 0,2 % | 0,6 % | |

## Verschiebung des Narrativ-Scores (S1)

- Symbole mit Score in beiden Armen: 74
- Δ neu − alt: Median 0,00, Mittel -0,22; neu höher 13, gleich 31, niedriger 30
- |Δ|: Median 0,35, Mittel 0,44; |Δ| ≥ 1 bei 15 (20,3 %)
- Spanne innerhalb eines Arms (beide Arme): Median 0,50, Mittel 0,54
- Urteil nach Vorschrift: im Rauschen

| Δ | Symbole |
|---:|---:|
| -2,0 | 1 |
| -1,5 | 5 |
| -1,0 | 9 |
| -0,5 | 10 |
| 0,0 | 36 |
| 0,5 | 10 |
| 1,0 | 2 |
| 1,5 | 1 |

## Dimensionen einzeln (S1, Anteil der Lesungen mit Bewertung statt null)

| Dimension | alt | neu |
|---|---:|---:|
| demand | 78,9 % | 73,1 % |
| position | 90,0 % | 85,7 % |
| execution | 74,2 % | 74,9 % |
| regulation | 67,4 % | 50,9 % |
| product | 87,1 % | 83,9 % |

## Mittlere Bewertung je Dimension (S1, nur bewertete Lesungen)

| Dimension | alt | neu |
|---|---:|---:|
| demand | 0,86 | 0,76 |
| position | 0,64 | 0,58 |
| execution | 0,64 | 0,52 |
| regulation | 0,02 | 0,03 |
| product | 0,75 | 0,69 |

## Beleg (S1, Prüfer-Modell)

| | alt | neu |
|---|---:|---:|
| belegt | 2507 (82,0 %) | 2599 (84,0 %) |
| teilweise | 539 (17,6 %) | 487 (15,7 %) |
| nicht belegt | 12 (0,4 %) | 7 (0,2 %) |
| ohne Urteil | 0 (0,0 %) | 0 (0,0 %) |
| geprüfte Zellen | 93 | 93 |

| Art | alt: nicht belegt | neu: nicht belegt | alt: teilweise | neu: teilweise |
|---|---:|---:|---:|---:|
| bull | 0,7 % | 0,4 % | 20,4 % | 19,5 % |
| bear | 0,5 % | 0,3 % | 13,9 % | 11,4 % |
| event | 0,0 % | 0,0 % | 18,9 % | 16,5 % |

## Leitplanken (S1)

- **L1 Abdeckung:** Median der Differenz 0,00 (Grenze ≥ −0,5), Enthaltungen alt 9, neu 17 (höchstens 3 mehr) → verletzt
- **L2 Beleg:** nicht belegt alt 0,4 %, neu 0,2 % (höchstens 10 % und höchstens 3 Prozentpunkte über alt) → erfüllt
- **L3 Stabilität:** Median der Spanne alt 0,50, neu 0,50 (höchstens 0,5 über alt) → erfüllt

## Tokens

- alt: 417 Lesungen, 1.113.543 Eingabe- und 297.874 Ausgabe-Tokens
- neu: 416 Lesungen, 1.268.935 Eingabe- und 305.460 Ausgabe-Tokens
