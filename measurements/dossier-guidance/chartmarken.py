"""Teil 2, ohne Modell: Tragen die Firmendossiers Kursmarken, und treffen sie die berechneten?

Liest die Pakete aus dem Cache des Laufs (`.pakete/`) und die Chart-Analyse der Produktion
(`GET /api/stocks/:symbol/chart`, nur `analysis` und `currency`). Schreibt `chartmarken-ausgabe.md`
auf stdout und die gezogenen Marken nach `chartmarken-roh.jsonl`.

    python3 -I measurements/dossier-guidance/chartmarken.py > measurements/dossier-guidance/chartmarken-ausgabe.md
"""

import json
import os
import re
import statistics as st
import sys
import time
import urllib.request
from collections import Counter
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kursmarken as K  # noqa: E402

API = os.environ.get("STOCKCLI_API", "https://stockcli.troop.at")
CACHE = os.environ.get("PAKET_CACHE", os.path.join(HERE, ".pakete"))
# Wie src/analysis/chart.ts: Band einer Marke und Fenster der berechneten Marken
LEVEL_BAND_ATR, LEVEL_BAND_MIN, LEVEL_RANGE = 0.6, 0.008, 0.35

CUR = [("HK$", "HKD"), ("US$", "USD"), ("C$", "CAD"), ("A$", "AUD"), ("S$", "SGD"), ("USD", "USD"), ("$", "USD"),
       ("€", "EUR"), ("EUR", "EUR"), ("£", "GBP"), ("GBP", "GBP"), ("CHF", "CHF"), ("¥", "JPY"), ("JPY", "JPY"),
       ("₩", "KRW"), ("KRW", "KRW"), ("NOK", "NOK"), ("SEK", "SEK"), ("DKK", "DKK"), ("DOLLAR", "USD"), ("EURO", "EUR")]
MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                          "september", "october", "november", "december"])}
DATE = re.compile(r"\b(?:(?P<m1>[A-Z][a-z]+)\.?\s+(?P<d1>\d{1,2})\b|(?P<d2>\d{1,2})\s+(?P<m2>[A-Z][a-z]+)\b)")


def currency_of(text):
    t = text.upper()
    for sym, code in CUR:
        if sym in t:
            return code
    return None


def sentence_date(sentence, period_end):
    for m in DATE.finditer(sentence):
        name = (m.group("m1") or m.group("m2") or "").lower()
        month = next((v for k, v in MONTHS.items() if k.startswith(name[:3]) and len(name) >= 3), None)
        if not month:
            continue
        day = int(m.group("d1") or m.group("d2"))
        year = period_end.year if month <= period_end.month else period_end.year - 1
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return None


CHARTS = os.environ.get("CHART_CACHE", os.path.join(HERE, ".charts"))


def chart_of(sym):
    """Nur `currency` und `analysis` der Produktion, einmal geholt und danach aus dem Cache."""
    os.makedirs(CHARTS, exist_ok=True)
    path = os.path.join(CHARTS, f"{sym}.json")
    if os.path.exists(path):
        return json.load(open(path))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{API}/api/stocks/{urllib.request.quote(sym)}/chart", timeout=60) as r:
                full = json.load(r)
            slim = {"currency": full.get("currency"), "analysis": full.get("analysis"), "fetched": date.today().isoformat()}
            json.dump(slim, open(path, "w"))
            time.sleep(0.3)
            return slim
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def coverage(levels, band, close):
    """Anteil des Fensters ±35 % um den Kurs, den die Bänder der berechneten Marken abdecken: der Zufallstreffer."""
    lo_w, hi_w = close * (1 - LEVEL_RANGE), close * (1 + LEVEL_RANGE)
    iv = sorted((max(lo_w, l - band), min(hi_w, l + band)) for l in levels)
    total, cur = 0.0, None
    for a, b in iv:
        if cur and a <= cur[1]:
            cur = (cur[0], max(cur[1], b))
        else:
            if cur:
                total += cur[1] - cur[0]
            cur = (a, b)
    if cur:
        total += cur[1] - cur[0]
    return total / (hi_w - lo_w)


def med(xs):
    return st.median(xs) if xs else None


def pct(a, b):
    return f"{100 * a / b:.0f} %" if b else "–"


arms = {}
for name in sorted(os.listdir(CACHE)):
    sym, arm, _ = name.rsplit(".", 2)
    arms.setdefault(sym, {})[arm] = json.load(open(os.path.join(CACHE, name)))["data"]

records, per_symbol, relative = [], [], {}
for sym, pk in sorted(arms.items()):
    chart = None
    try:
        chart = chart_of(sym)
    except Exception as e:  # noqa: BLE001
        print(f"<!-- {sym}: Chart nicht lesbar ({e}) -->", file=sys.stderr)
    an = (chart or {}).get("analysis") or {}
    close, atr, ccy = an.get("close"), an.get("atr"), (chart or {}).get("currency")
    computed = [l["price"] for l in an.get("levels") or []]
    band = max((atr or 0) * LEVEL_BAND_ATR, (close or 0) * LEVEL_BAND_MIN) if close else None
    near_sup = max((l["price"] for l in an.get("levels") or [] if l["kind"] == "support"), default=None)
    near_res = min((l["price"] for l in an.get("levels") or [] if l["kind"] == "resistance"), default=None)
    if close and computed:
        relative[sym] = ([c / close - 1 for c in computed], band / close)
    row = {"symbol": sym, "currency": ccy, "close": close, "computed": len(computed),
           "coverage": coverage(computed, band, close) if close and computed else None}
    for arm, b in pk.items():
        company = (b.get("company") or {})
        text = company.get("content") or ""
        end = date.fromisoformat((company.get("periodEnd") or "2026-10-09")[:10])
        levels = K.extract(text)
        row[f"{arm}_chars"] = len(text)
        row[f"{arm}_levels"] = len(levels)
        if arm != "neu":
            continue
        for l in levels:
            lc = currency_of(l["text"])
            d = sentence_date(l["sentence"], end)
            mid = (l["low"] + l["high"]) / 2
            rec = {"symbol": sym, "low": l["low"], "high": l["high"], "text": l["text"], "currency": lc, "close": close,
                   "chart_currency": ccy, "age_days": (end - d).days if d else None, "sentence": l["sentence"]}
            if close and lc == ccy:
                rec["distance"] = mid / close - 1
                rec["near"] = abs(rec["distance"]) <= LEVEL_RANGE
                hit = [c for c in computed if l["low"] - band <= c <= l["high"] + band]
                rec["match"] = bool(hit)
                rec["nearest_support"] = near_sup is not None and l["low"] - band <= near_sup <= l["high"] + band
                rec["nearest_resistance"] = near_res is not None and l["low"] - band <= near_res <= l["high"] + band
            records.append(rec)
    if close and "neu" in pk:
        mine = [r for r in records if r["symbol"] == sym and r.get("near")]
        row["confirmed"] = sum(1 for c in computed if any(r["low"] - band <= c <= r["high"] + band for r in mine))
        row["sup_confirmed"] = near_sup is not None and any(r["low"] - band <= near_sup <= r["high"] + band for r in mine)
        row["res_confirmed"] = near_res is not None and any(r["low"] - band <= near_res <= r["high"] + band for r in mine)
    per_symbol.append(row)

with open(os.path.join(HERE, "chartmarken-roh.jsonl"), "w") as fh:
    for r in records:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")

with_company = [r for r in per_symbol if r.get("neu_chars")]
print("# Teil 2: Kursmarken in den Firmendossiers\n")
print("Erzeugt von `chartmarken.py` (Extraktor `kursmarken.py`, ohne Modell).\n")
print("## Wie viele Firmendossiers tragen Marken?\n")
print("| | alt | neu |\n|---|---:|---:|")
n_alt = [r for r in per_symbol if r.get("alt_chars")]
n_neu = with_company
print(f"| Firmendossiers mit Text | {len(n_alt)} | {len(n_neu)} |")
print(f"| davon mit mindestens einer Marke | {sum(1 for r in n_alt if r['alt_levels'])} | {sum(1 for r in n_neu if r['neu_levels'])} |")
print(f"| mit mindestens fünf Marken | {sum(1 for r in n_alt if r['alt_levels'] >= 5)} | {sum(1 for r in n_neu if r['neu_levels'] >= 5)} |")
print(f"| Marken je Dossier, Median | {med([r['alt_levels'] for r in n_alt])} | {med([r['neu_levels'] for r in n_neu])} |")
print(f"| Marken je Dossier, Höchstwert | {max([r['alt_levels'] for r in n_alt], default=0)} | {max([r['neu_levels'] for r in n_neu], default=0)} |")

print("\n## Marken im neuen Dossier nach Länge des Dossiers\n")
print("| Länge neu | Dossiers | mit Marke | Marken, Median |\n|---|---:|---:|---:|")
for lo, hi in ((0, 2000), (2000, 4000), (4000, 6000), (6000, 10 ** 6)):
    g = [r for r in n_neu if lo <= r["neu_chars"] < hi]
    print(f"| {lo}–{hi if hi < 10 ** 6 else '…'} | {len(g)} | {sum(1 for r in g if r['neu_levels'])} | {med([r['neu_levels'] for r in g]) if g else '–'} |")

print("\n## Die Marken des neuen Dossiers\n")
print(f"- gezogen: {len(records)} Marken aus {sum(1 for r in n_neu if r['neu_levels'])} Dossiers")
cur = Counter((r["currency"] == r["chart_currency"]) if r["currency"] else None for r in records)
print(f"- Währung wie der Chart: {cur[True]}, andere Währung: {cur[False]}, ohne erkennbare Währung: {cur[None]}")
dated = [r["age_days"] for r in records if r["age_days"] is not None]
print(f"- mit Datum im Satz: {len(dated)} ({pct(len(dated), len(records))}); Alter Median {med(dated)} Tage, "
      f"höchstens 14 Tage: {sum(1 for a in dated if 0 <= a <= 14)}, älter: {sum(1 for a in dated if a > 14)}")
comparable = [r for r in records if "near" in r]
near = [r for r in comparable if r["near"]]
print(f"- vergleichbar (Währung passt, Chart vorhanden): {len(comparable)}; davon im Fenster ±35 % um den Kurs: {len(near)}")

print("\n## Treffen sie die berechneten Marken?\n")
print("Treffer: Die Zone der Dossier-Marke, um das Band des Codes erweitert (max(0,6 × ATR, 0,8 % des Kurses)), "
      "enthält eine berechnete Marke. Zufall: dieselbe Marke, relativ zum Kurs, gegen die berechneten Marken jeder "
      "anderen Aktie; berechnete Marken liegen dicht um den Kurs, dort trifft fast alles.\n")
def chance_of(r):
    """Trefferquote derselben Marke gegen die berechneten Marken aller anderen Aktien, relativ zum Kurs."""
    lo, hi = r["low"] / r["close"] - 1, r["high"] / r["close"] - 1
    others = [(rel, b) for s2, (rel, b) in relative.items() if s2 != r["symbol"]]
    return sum(1 for rel, b in others if any(lo - b <= x <= hi + b for x in rel)) / len(others) if others else None


for r in near:
    r["chance"] = chance_of(r)
hits = sum(1 for r in near if r["match"])
chance = med([r["coverage"] for r in per_symbol if r.get("coverage") is not None and any(x["symbol"] == r["symbol"] for x in near)])
print(f"- Dossier-Marken im Fenster, die eine berechnete treffen: {hits} von {len(near)} ({pct(hits, len(near))})")
print(f"- Zufall, gemessen an den berechneten Marken der jeweils anderen Aktien (relativ zum Kurs): "
      f"{pct(sum(r['chance'] for r in near), len(near))}")
print(f"- Zufall als abgedeckter Anteil des Fensters, Median je Aktie: {pct(chance or 0, 1)}")
by_sym = [r for r in per_symbol if r.get("confirmed") is not None and any(x["symbol"] == r["symbol"] for x in near)]
print(f"- Aktien mit Dossier-Marken im Fenster: {len(by_sym)}; berechnete Marken dort: {sum(r['computed'] for r in by_sym)}, "
      f"davon von einer Dossier-Marke bestätigt: {sum(r['confirmed'] for r in by_sym)}")
print(f"- nächste berechnete Unterstützung bestätigt: {sum(1 for r in by_sym if r['sup_confirmed'])} von {len(by_sym)}; "
      f"nächster Widerstand: {sum(1 for r in by_sym if r['res_confirmed'])} von {len(by_sym)}")

print("\n| Abstand zum Kurs | Marken | Treffer | Anteil | Zufall |\n|---|---:|---:|---:|---:|")
for lo, hi in ((-0.35, -0.15), (-0.15, -0.05), (-0.05, 0.05), (0.05, 0.15), (0.15, 0.35)):
    g = [r for r in near if lo <= r["distance"] < hi]
    print(f"| {lo:+.0%} bis {hi:+.0%} | {len(g)} | {sum(1 for r in g if r['match'])} | "
          f"{pct(sum(1 for r in g if r['match']), len(g))} | {pct(sum(r['chance'] for r in g), len(g))} |")

print("\n## Je Aktie (neu, nur mit Marken)\n")
print("| Aktie | Länge | Marken | im Fenster | Treffer | berechnet | bestätigt | Zufall |\n|---|---:|---:|---:|---:|---:|---:|---:|")
for r in sorted(n_neu, key=lambda r: -r["neu_levels"]):
    if not r["neu_levels"]:
        continue
    mine = [x for x in near if x["symbol"] == r["symbol"]]
    print(f"| {r['symbol']} | {r['neu_chars']} | {r['neu_levels']} | {len(mine)} | {sum(1 for x in mine if x['match'])} | "
          f"{r['computed']} | {r.get('confirmed', '–')} | {pct(r['coverage'], 1) if r.get('coverage') is not None else '–'} |")
