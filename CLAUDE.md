# CLAUDE.md

## Datenschutz: echte Depotdaten

Die Tabellen `trades` und `holding_prices` sind Kopien der echten Käufe, Verkäufe und Depotkurse des Eigentümers aus umsatz (`GET /integrations/stock-cli/trades` und `…/prices`, siehe `src/trades-service.ts`); die Depot-Ansicht (`/api/depot`, `#/depot`) rechnet daraus Positionen und Gewichte, der Rückblick (`/api/review`, `#/review`) misst jeden Kauf und Verkauf. Es gelten dieselben Regeln wie in umsatz: Alles, was Claude liest (Tool-Ausgaben, Dateien, Screenshots, Seitentext, Logs), wird an Anthropic übertragen.

**Niemals in den Kontext holen**, egal ob per SQL, API, Browser oder Log:

- Zeilen aus `trades` oder `holding_prices` (Datum, ISIN, Name, Stückzahl, Kurs, Gebühr), auch nicht „kurz zum Anschauen“ oder mit `LIMIT 5`
- die Antwort von `/api/trades/open`, `/api/depot`, `/api/depot/check`, `/api/review` oder von umsatz ungefiltert, auch nicht per `curl`
- die `app_state`-Einträge `depot.check.umsatz.*` (Ergebnis des Depot-Checks: Depotwerte, Gewichte, Text des Depotmanagers)
- Screenshots oder Seitentext des Journals („Ohne Begründung“), der Depot- oder der Rückblick-Seite, solange dort echte Daten stehen

**Erlaubt** sind Aggregate ohne Einzelwerte: `count(*)` und `GROUP BY` über `kind`, `asset_type` oder Datums-Buckets; API-Antworten mit `jq` auf Status oder Anzahlen reduziert.

Zum Testen einen Platzhalter-Server mit erfundenen Trades verwenden (`UMSATZ_API_URL` auf ihn zeigen lassen), nie das echte umsatz, und dazu `TRADES_SOURCE` auf eine eigene Quelle setzen (z. B. `preview`): Dann landen die erfundenen Trades unter dieser Quelle, die echte Kopie unter `umsatz` bleibt unberührt, und die Depot-Seite zeigt nur Erfundenes. Danach die Zeilen dieser Quelle aus `trades` und `holding_prices` und ihre `app_state`-Einträge (`trades.<quelle>.*`, `depot.check.<quelle>.*`) löschen. Tests, Fixtures, Kommentare und Commit-Messages enthalten nur erfundene Beispiele.

Bestände und Trades gehen nie in Prompts an ein Modell, mit einer Ausnahme, die der Eigentümer am 8.10.2026 so festgelegt und am selben Tag erweitert hat: der Text „Was ein Depotmanager tun würde“ im Depot-Check. Er bekommt je Position Name, Ticker, Anlageart und Gewicht in Prozent; bei Einzelaktien dazu Sektor, „seit Kauf“ in Prozent und die eigene Bewertung der App (Score, Urteil, Chart-Lesung, Abstände zu Stop und Trailing in Prozent); dazu die Sektorgewichte — nie Stückzahlen, Kaufkurse, Beträge, Daten, Trades oder das Journal, und kein „seit Kauf“ bei ETFs, Krypto oder Metallen. Aus „seit Kauf“ und dem öffentlichen Tageskurs lässt sich der durchschnittliche Einstand einer Aktie zurückrechnen; das ist der Preis dieser Erweiterung. Was genau hinausgeht, legt allein `managerInput` in `src/analysis/depot-check.ts` fest; ein Test (`test/depot-check.test.ts`) prüft, dass nichts anderes durchkommt. Jede weitere Erweiterung braucht seine ausdrückliche Zustimmung. Die Marktlage von Perplexity (`src/data/market-brief.ts`) fragt nur nach dem Markt, nie nach dem Depot.

Das Journal selbst (`journal_entries`) sind eigene Notizen des Eigentümers; beim Entwickeln ebenfalls nur so viel lesen, wie die Aufgabe braucht.
