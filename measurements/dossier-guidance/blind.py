"""Blindvergleich für das Urteil des Eigentümers (VORSCHRIFT.md, Abschnitt »Urteil des Eigentümers«).

Baut eine Seite mit den behaltenen Lesungen beider Arme je ausgeloster Aktie, Etiketten A und B je Aktie
zufällig verteilt. Die Zuordnung geht in eine eigene Datei außerhalb der Seite und wird erst nach dem
Urteil geöffnet.

    python3 -I measurements/dossier-guidance/blind.py <seite.html> <zuordnung.json>
"""

import html
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261010
# Aus VORSCHRIFT.md: je Drittel vier, Ersatz in dieser Reihenfolge
DRITTEL = [
    (["JD", "OKTA", "PFE", "RBRK"], ["BIIB", "SEDG", "PYPL"]),
    (["MRVL", "AXON", "NU", "LMT"], ["INTC", "MRNA", "NET"]),
    (["BYDDF", "CRWV", "ORCL", "NKE"], ["META", "ALV.DE", "AVGO"]),
]
DIMS = [("demand", "Nachfrage"), ("position", "Position"), ("execution", "Umsetzung"),
        ("regulation", "Regulierung"), ("product", "Produkt")]


def jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


eignung = {e["symbol"]: e for e in jsonl(os.path.join(HERE, "roh/eignung.jsonl"))}
rows = jsonl(os.path.join(HERE, "roh/lesungen.jsonl"))
arms = {(r["symbol"], r["arm"]): r for r in rows if r["kind"] == "arm"}
reads = {(r["symbol"], r["arm"], r["read"]): r for r in rows if r["kind"] == "read" and r["ok"]}


def usable(s):
    return eignung.get(s, {}).get("schicht") == "S1" and all(
        arms.get((s, a)) and arms[(s, a)]["keptRead"] for a in ("alt", "neu"))


chosen, ersetzt = [], []
for wahl, ersatz in DRITTEL:
    pool = [s for s in wahl + ersatz if usable(s)]
    chosen += pool[:4]
    ersetzt += [s for s in wahl if s not in pool[:4]]

rng = random.Random(SEED)
stocks, mapping = [], {}
for s in chosen:
    a_is_neu = rng.random() < 0.5
    order = ("neu", "alt") if a_is_neu else ("alt", "neu")
    mapping[s] = {"A": order[0], "B": order[1]}
    sides = []
    for arm in order:
        cell = arms[(s, arm)]
        r = reads[(s, arm, cell["keptRead"])]["output"]
        sides.append({
            "score": cell["score"],
            "summary": r.get("summary", ""),
            "events": r.get("events") or [],
            "bull": (r.get("theses") or {}).get("bull") or [],
            "bear": (r.get("theses") or {}).get("bear") or [],
            "dims": [{"label": lbl, "rating": ((r.get("dimensions") or {}).get(k) or {}).get("rating"),
                      "note": ((r.get("dimensions") or {}).get(k) or {}).get("note", "")} for k, lbl in DIMS],
        })
    pk = os.path.join(os.environ.get("PAKET_CACHE", os.path.join(HERE, ".pakete")), f"{s}.alt.json")
    name = ((json.load(open(pk))["data"].get("company") or {}).get("displayName") if os.path.exists(pk) else None) or s
    stocks.append({"symbol": s, "name": name, "sides": sides})

page_path, map_path = sys.argv[1], sys.argv[2]
with open(map_path, "w") as f:
    json.dump({"seed": SEED, "zuordnung": mapping, "ersetzt": ersetzt}, f, indent=1)

data = json.dumps(stocks, ensure_ascii=False).replace("</", "<\\/")
template = open(os.path.join(HERE, "blind.template.html")).read()
open(page_path, "w").write(template.replace("__DATA__", data).replace("__COUNT__", str(len(stocks))))
print(f"{len(stocks)} Aktien, ersetzt: {ersetzt or 'keine'}")
