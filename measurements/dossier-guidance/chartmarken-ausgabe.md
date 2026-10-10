# Teil 2: Kursmarken in den Firmendossiers

Erzeugt von `chartmarken.py` (Extraktor `kursmarken.py`, ohne Modell).

## Wie viele Firmendossiers tragen Marken?

| | alt | neu |
|---|---:|---:|
| Firmendossiers mit Text | 94 | 94 |
| davon mit mindestens einer Marke | 41 | 60 |
| mit mindestens fünf Marken | 7 | 35 |
| Marken je Dossier, Median | 0.0 | 3.0 |
| Marken je Dossier, Höchstwert | 12 | 21 |

## Marken im neuen Dossier nach Länge des Dossiers

| Länge neu | Dossiers | mit Marke | Marken, Median |
|---|---:|---:|---:|
| 0–2000 | 41 | 13 | 0 |
| 2000–4000 | 26 | 21 | 3.5 |
| 4000–6000 | 20 | 20 | 8.5 |
| 6000–… | 7 | 6 | 7 |

## Die Marken des neuen Dossiers

- gezogen: 416 Marken aus 60 Dossiers
- Währung wie der Chart: 395, andere Währung: 21, ohne erkennbare Währung: 0
- mit Datum im Satz: 230 (55 %); Alter Median 9.0 Tage, höchstens 14 Tage: 170, älter: 60
- vergleichbar (Währung passt, Chart vorhanden): 395; davon im Fenster ±35 % um den Kurs: 330

## Treffen sie die berechneten Marken?

Treffer: Die Zone der Dossier-Marke, um das Band des Codes erweitert (max(0,6 × ATR, 0,8 % des Kurses)), enthält eine berechnete Marke. Zufall: dieselbe Marke, relativ zum Kurs, gegen die berechneten Marken jeder anderen Aktie; berechnete Marken liegen dicht um den Kurs, dort trifft fast alles.

- Dossier-Marken im Fenster, die eine berechnete treffen: 229 von 330 (69 %)
- Zufall, gemessen an den berechneten Marken der jeweils anderen Aktien (relativ zum Kurs): 57 %
- Zufall als abgedeckter Anteil des Fensters, Median je Aktie: 35 %
- Aktien mit Dossier-Marken im Fenster: 57; berechnete Marken dort: 379, davon von einer Dossier-Marke bestätigt: 161
- nächste berechnete Unterstützung bestätigt: 36 von 57; nächster Widerstand: 24 von 57

| Abstand zum Kurs | Marken | Treffer | Anteil | Zufall |
|---|---:|---:|---:|---:|
| -35% bis -15% | 50 | 25 | 50 % | 25 % |
| -15% bis -5% | 79 | 68 | 86 % | 65 % |
| -5% bis +5% | 117 | 93 | 79 % | 76 % |
| +5% bis +15% | 44 | 23 | 52 % | 58 % |
| +15% bis +35% | 40 | 20 | 50 % | 24 % |

## Je Aktie (neu, nur mit Marken)

| Aktie | Länge | Marken | im Fenster | Treffer | berechnet | bestätigt | Zufall |
|---|---:|---:|---:|---:|---:|---:|---:|
| AMD | 6949 | 21 | 20 | 12 | 5 | 5 | 34 % |
| RKLB | 5389 | 19 | 14 | 13 | 8 | 5 | 71 % |
| NOW | 5378 | 18 | 14 | 11 | 8 | 6 | 45 % |
| BABA | 4078 | 16 | 13 | 8 | 8 | 5 | 35 % |
| IONQ | 4646 | 16 | 7 | 6 | 7 | 4 | 73 % |
| NVO | 4549 | 15 | 10 | 5 | 8 | 4 | 30 % |
| GOOGL | 6843 | 14 | 14 | 11 | 8 | 5 | 29 % |
| NBIS | 4297 | 13 | 12 | 8 | 6 | 4 | 70 % |
| NKE | 3696 | 13 | 10 | 2 | 5 | 3 | 25 % |
| ORCL | 5462 | 13 | 13 | 12 | 8 | 7 | 51 % |
| AIR.PA | 1530 | 12 | 3 | 3 | 8 | 3 | 28 % |
| AXON | 2623 | 11 | 10 | 7 | 8 | 5 | 47 % |
| PYPL | 2301 | 11 | 7 | 5 | 8 | 2 | 34 % |
| SMCI | 3533 | 11 | 7 | 7 | 7 | 4 | 56 % |
| AVGO | 5809 | 10 | 6 | 5 | 8 | 5 | 32 % |
| MELI | 2179 | 10 | 10 | 8 | 8 | 5 | 39 % |
| QBTS | 2675 | 10 | 9 | 6 | 8 | 5 | 70 % |
| CRWD | 3857 | 9 | 7 | 2 | 5 | 2 | 33 % |
| CRWV | 5503 | 9 | 8 | 7 | 8 | 3 | 62 % |
| INTC | 4150 | 9 | 9 | 8 | 6 | 5 | 56 % |
| AMZN | 5770 | 8 | 8 | 7 | 8 | 5 | 25 % |
| PEP | 4256 | 8 | 8 | 1 | 6 | 1 | 18 % |
| MSFT | 6669 | 7 | 5 | 3 | 6 | 3 | 21 % |
| NVDA | 7984 | 7 | 7 | 5 | 6 | 3 | 21 % |
| ADBE | 6879 | 6 | 6 | 5 | 8 | 3 | 36 % |
| CRM | 3939 | 6 | 6 | 4 | 8 | 2 | 46 % |
| META | 5523 | 6 | 5 | 4 | 6 | 3 | 34 % |
| MU | 5187 | 6 | 4 | 4 | 6 | 3 | 44 % |
| NFLX | 4930 | 6 | 6 | 4 | 8 | 7 | 27 % |
| PATH | 1967 | 6 | 6 | 2 | 8 | 3 | 52 % |
| WDC | 2544 | 6 | 6 | 5 | 6 | 4 | 62 % |
| MRVL | 4458 | 5 | 4 | 3 | 4 | 2 | 34 % |
| PANW | 5082 | 5 | 4 | 2 | 6 | 2 | 38 % |
| SNDK | 3208 | 5 | 0 | 0 | 5 | 0 | 42 % |
| WKL.AS | 1876 | 5 | 3 | 3 | 7 | 4 | 32 % |
| DELL | 2770 | 4 | 4 | 2 | 4 | 1 | 30 % |
| MCD | 3945 | 4 | 3 | 1 | 5 | 1 | 16 % |
| UBER | 4030 | 4 | 3 | 1 | 8 | 1 | 26 % |
| VST | 2807 | 4 | 3 | 2 | 8 | 2 | 43 % |
| AAPL | 4173 | 3 | 3 | 1 | 5 | 1 | 16 % |
| ASML | 739 | 3 | 0 | 0 | 7 | 0 | 29 % |
| ASTS | 785 | 3 | 2 | 2 | 7 | 2 | 74 % |
| BYDDF | 2180 | 3 | 0 | 0 | 8 | 0 | 29 % |
| ENR.DE | 3246 | 3 | 3 | 2 | 8 | 1 | 44 % |
| JD | 651 | 3 | 3 | 2 | 8 | 2 | 24 % |
| KO | 3827 | 3 | 3 | 2 | 5 | 1 | 12 % |
| LLY | 1442 | 3 | 3 | 3 | 7 | 3 | 35 % |
| LULU | 518 | 3 | 1 | 0 | 3 | 0 | 18 % |
| SE | 6842 | 3 | 1 | 1 | 8 | 1 | 34 % |
| SOFI | 3689 | 3 | 3 | 3 | 8 | 2 | 41 % |
| TSM | 2385 | 3 | 3 | 1 | 6 | 1 | 22 % |
| NET | 2202 | 2 | 2 | 1 | 5 | 1 | 37 % |
| SEDG | 771 | 2 | 2 | 1 | 6 | 2 | 59 % |
| TTD | 1108 | 2 | 1 | 1 | 4 | 1 | 24 % |
| ISRG | 1954 | 1 | 1 | 1 | 8 | 1 | 33 % |
| MRNA | 1363 | 1 | 1 | 1 | 3 | 1 | 35 % |
| NU | 2102 | 1 | 1 | 1 | 8 | 2 | 46 % |
| RBRK | 1850 | 1 | 1 | 0 | 5 | 0 | 31 % |
| SKHY | 4962 | 1 | 1 | 1 | 6 | 1 | 39 % |
| ZETA | 3810 | 1 | 1 | 1 | 6 | 1 | 42 % |
