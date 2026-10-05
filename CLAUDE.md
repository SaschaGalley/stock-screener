# CLAUDE.md

## Datenschutz: echte Depotdaten

Die Tabellen `trades` und `holding_prices` sind Kopien der echten Käufe, Verkäufe und Depotkurse des Eigentümers aus umsatz (`GET /integrations/stock-cli/trades` und `…/prices`, siehe `src/trades-service.ts`); die Depot-Ansicht (`/api/depot`, `#/depot`) rechnet daraus Positionen und Gewichte. Es gelten dieselben Regeln wie in umsatz: Alles, was Claude liest (Tool-Ausgaben, Dateien, Screenshots, Seitentext, Logs), wird an Anthropic übertragen.

**Niemals in den Kontext holen**, egal ob per SQL, API, Browser oder Log:

- Zeilen aus `trades` oder `holding_prices` (Datum, ISIN, Name, Stückzahl, Kurs, Gebühr), auch nicht „kurz zum Anschauen“ oder mit `LIMIT 5`
- die Antwort von `/api/trades/open`, `/api/depot` oder von umsatz ungefiltert, auch nicht per `curl`
- Screenshots oder Seitentext des Journals („Ohne Begründung“) oder der Depot-Seite, solange dort echte Daten stehen

**Erlaubt** sind Aggregate ohne Einzelwerte: `count(*)` und `GROUP BY` über `kind`, `asset_type` oder Datums-Buckets; API-Antworten mit `jq` auf Status oder Anzahlen reduziert.

Zum Testen einen Platzhalter-Server mit erfundenen Trades verwenden (`UMSATZ_API_URL` auf ihn zeigen lassen), nie das echte umsatz. Tests, Fixtures, Kommentare und Commit-Messages enthalten nur erfundene Beispiele. Bestände und Trades gehen nie in Prompts an ein Modell.

Das Journal selbst (`journal_entries`) sind eigene Notizen des Eigentümers; beim Entwickeln ebenfalls nur so viel lesen, wie die Aufgabe braucht.
