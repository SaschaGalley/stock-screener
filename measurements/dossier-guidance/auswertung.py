"""Auswertung der Messung in VORSCHRIFT.md. Liest nur roh/, beleg/ und den Paket-Cache, ruft kein Modell.

    python3 -I measurements/dossier-guidance/auswertung.py > measurements/dossier-guidance/auswertung-ausgabe.md
"""

import json
import os
import re
import statistics as st
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kursmarken as K  # noqa: E402

CACHE = os.environ.get("PAKET_CACHE", os.path.join(HERE, ".pakete"))
DIMS = ["demand", "position", "execution", "regulation", "product"]
ARMS = ["alt", "neu"]


def jsonl(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


eignung = {e["symbol"]: e for e in jsonl(os.path.join(HERE, "roh/eignung.jsonl"))}
rows = jsonl(os.path.join(HERE, "roh/lesungen.jsonl"))
reads = [r for r in rows if r["kind"] == "read"]
arms = {(r["symbol"], r["arm"]): r for r in rows if r["kind"] == "arm"}
beleg_path = os.path.join(HERE, "beleg/urteile.jsonl")
beleg = {(b["symbol"], b["arm"]): b for b in jsonl(beleg_path) if b.get("ok")} if os.path.exists(beleg_path) else {}

symbols = sorted({s for s, _ in arms})
schicht = {s: eignung[s]["schicht"] for s in symbols}
S1 = [s for s in symbols if schicht[s] == "S1"]
S2 = [s for s in symbols if schicht[s] == "S2"]


def package(symbol, arm):
    p = os.path.join(CACHE, f"{symbol}.{arm}.json")
    return json.load(open(p))["data"] if os.path.exists(p) else None


def package_text(b):
    parts = [b.get("company", {}) or {}] + (b.get("sectors") or [])
    out = []
    for p in parts:
        out.append(p.get("content") or "")
        for i in ((p.get("insights") or {}).get("items") or []):
            out.append(json.dumps(i, ensure_ascii=False))
    return "\n".join(out)


def output_text(o):
    dims = o.get("dimensions") or {}
    return "\n".join([o.get("summary", "")] + (o.get("events") or [])
                     + (o.get("theses", {}).get("bull") or []) + (o.get("theses", {}).get("bear") or [])
                     + [(dims.get(d) or {}).get("note", "") for d in DIMS])


def rated(o):
    dims = o.get("dimensions") or {}
    return sum(1 for d in DIMS if isinstance((dims.get(d) or {}).get("rating"), (int, float)))


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def f(x, d=2):
    if x is None:
        return "–"
    s = f"{x:.{d}f}".replace(".", ",")
    return s


def pct(a, b):
    return f"{100 * a / b:.1f} %".replace(".", ",") if b else "–"


# ── Zahlen ohne Gegenstück im Paket ─────────────────────────────────────────

NUM = re.compile(r"(?<![\w])\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|(?<![\w])\d+(?:[.,]\d+)?")


def values(token):
    """Beide Lesarten einer Zahl: englisch (1,040.5) und deutsch (1.040,5)."""
    out = set()
    for dec, thou in ((".", ","), (",", ".")):
        t = token.replace(thou, "")
        if t.count(dec) <= 1:
            try:
                out.add(round(float(t.replace(dec, ".")), 4))
            except ValueError:
                pass
    return out


def numbers_in(text):
    return {v for m in NUM.finditer(text) for v in values(m.group(0))}


def unmatched(item, pkg_numbers):
    miss = []
    for m in NUM.finditer(item):
        vs = values(m.group(0))
        if any(1900 <= v <= 2100 or v <= 10 for v in vs):
            continue
        if not vs & pkg_numbers:
            miss.append(m.group(0))
    return miss


# ── Kursmarken in der Ausgabe ───────────────────────────────────────────────

MONEY_OUT = re.compile(
    rf"(?:{K.CURRENCY})\s?({K.NUMBER}|\d+(?:,\d+)?)|(\d{{1,3}}(?:\.\d{{3}})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s?(?:US-?\$|USD|US-Dollar|Dollar|\$|€|EUR|Euro|HK\$)",
    re.IGNORECASE,
)


def money_values(text):
    out = set()
    for m in MONEY_OUT.finditer(text):
        out |= values(m.group(1) or m.group(2))
    return out


# ── Je Symbol und Arm ───────────────────────────────────────────────────────

cell = {}
for s in symbols:
    for a in ARMS:
        rs = [r for r in reads if r["symbol"] == s and r["arm"] == a]
        ok = [r for r in rs if r["ok"]]
        arm = arms[(s, a)]
        pkg = package(s, a)
        pkg_nums = numbers_in(package_text(pkg)) if pkg else set()
        levels = K.extract((pkg.get("company") or {}).get("content") or "") if pkg else []
        level_vals = K.numbers(levels)
        leaked = [len(level_vals & money_values(output_text(r["output"]))) for r in ok]
        items = [(k, t) for r in ok for k, ts in (("bull", r["output"]["theses"].get("bull") or []),
                                                    ("bear", r["output"]["theses"].get("bear") or []),
                                                    ("event", r["output"].get("events") or [])) for t in ts]
        cell[(s, a)] = {
            "reads": len(rs), "ok": len(ok),
            "dims": mean([rated(r["output"]) for r in ok]),
            "bull": mean([len(r["output"]["theses"].get("bull") or []) for r in ok]),
            "bear": mean([len(r["output"]["theses"].get("bear") or []) for r in ok]),
            "events": mean([len(r["output"].get("events") or []) for r in ok]),
            "score": arm["score"], "spread": arm["spread"], "confidence": arm["confidence"],
            "levels": len(level_vals), "leaked": mean(leaked), "leaked_any": sum(1 for x in leaked if x > 0),
            "items": len(items), "items_unmatched": sum(1 for _, t in items if unmatched(t, pkg_nums)) if pkg else None,
            "company_chars": arm["paket"]["companyChars"], "prompt_chars": mean([r["promptChars"] for r in rs]),
            "usage": [r.get("usage") or {} for r in ok],
        }


def table_arm(group, title):
    print(f"\n### {title} ({len(group)} Symbole)\n")
    print("| Metrik | alt | neu | Differenz neu − alt (Median je Symbol) |")
    print("|---|---:|---:|---:|")

    def row(name, key, agg=med, d=2):
        A = [cell[(s, "alt")][key] for s in group]
        N = [cell[(s, "neu")][key] for s in group]
        diff = [n - a for a, n in zip(A, N) if a is not None and n is not None]
        print(f"| {name} | {f(agg(A), d)} | {f(agg(N), d)} | {f(med(diff), d)} |")

    row("Länge Firmendossier (Zeichen, Median)", "company_chars", d=0)
    row("Länge Prompt (Zeichen, Median)", "prompt_chars", d=0)
    row("bewertete Dimensionen je Lesung (Median)", "dims")
    row("bewertete Dimensionen je Lesung (Mittel)", "dims", agg=mean)
    row("Bull-Thesen je Lesung (Mittel)", "bull", agg=mean)
    row("Bear-Thesen je Lesung (Mittel)", "bear", agg=mean)
    row("Ereignisse je Lesung (Mittel)", "events", agg=mean)
    row("Narrativ-Score (Median)", "score", d=1)
    row("Spanne zwischen den Lesungen (Median)", "spread", d=1)
    row("Spanne zwischen den Lesungen (Mittel)", "spread", agg=mean)
    row("Confidence (Median)", "confidence")
    row("Kursmarken im Firmendossier (Median)", "levels", d=0)
    row("Kursmarken je Lesung in der Ausgabe (Mittel)", "leaked", agg=mean)
    ab = {a: sum(1 for s in group if cell[(s, a)]["score"] is None) for a in ARMS}
    print(f"| Enthaltungen (kombinierter Score null) | {ab['alt']} | {ab['neu']} | {ab['neu'] - ab['alt']:+d} |")
    fail = {a: sum(cell[(s, a)]["reads"] - cell[(s, a)]["ok"] for s in group) for a in ARMS}
    print(f"| gescheiterte Lesungen | {fail['alt']} | {fail['neu']} | |")
    spread_all = {a: Counter(cell[(s, a)]["spread"] for s in group) for a in ARMS}
    print(f"| Spanne 0 / >0 / ≥1 / ohne | "
          + " | ".join(f"{spread_all[a][0.0]} / {sum(v for k, v in spread_all[a].items() if k)} / "
                       f"{sum(v for k, v in spread_all[a].items() if k is not None and k >= 1)} / {spread_all[a][None]}"
                       for a in ARMS) + " | |")
    lk = {a: sum(cell[(s, a)]["leaked_any"] for s in group) for a in ARMS}
    nr = {a: sum(cell[(s, a)]["ok"] for s in group) for a in ARMS}
    print(f"| Lesungen mit mindestens einer Kursmarke aus dem Dossier | {lk['alt']} von {nr['alt']} | {lk['neu']} von {nr['neu']} | |")
    um = {a: (sum(cell[(s, a)]["items_unmatched"] or 0 for s in group), sum(cell[(s, a)]["items"] for s in group)) for a in ARMS}
    print(f"| Thesen und Ereignisse mit einer Zahl, die im Paket fehlt | {pct(*um['alt'])} | {pct(*um['neu'])} | |")


print("# Auswertung: Narrative-Stufe mit altem und neuem distill-Paket\n")
print("Erzeugt von `auswertung.py` aus `roh/` und `beleg/`; ohne Modell-Calls wiederholbar.\n")

print("## Eignung\n")
grund = Counter(e["grund"] or e["schicht"] for e in eignung.values())
print("| Fall | Symbole |\n|---|---:|")
for k, v in sorted(grund.items(), key=lambda kv: -kv[1]):
    print(f"| {k} | {v} |")

table_arm(S1, "S1: Firmendossier in beiden Paketen")
table_arm(S2, "S2: nur Sektorkontext")

# ── Verschiebung ────────────────────────────────────────────────────────────

print("\n## Verschiebung des Narrativ-Scores (S1)\n")
deltas = [cell[(s, "neu")]["score"] - cell[(s, "alt")]["score"] for s in S1
          if cell[(s, "neu")]["score"] is not None and cell[(s, "alt")]["score"] is not None]
spreads = [cell[(s, a)]["spread"] for s in S1 for a in ARMS if cell[(s, a)]["spread"] is not None]
if deltas:
    absd = [abs(d) for d in deltas]
    print(f"- Symbole mit Score in beiden Armen: {len(deltas)}")
    print(f"- Δ neu − alt: Median {f(med(deltas), 2)}, Mittel {f(mean(deltas), 2)}; neu höher {sum(d > 0 for d in deltas)}, "
          f"gleich {sum(d == 0 for d in deltas)}, niedriger {sum(d < 0 for d in deltas)}")
    print(f"- |Δ|: Median {f(med(absd), 2)}, Mittel {f(mean(absd), 2)}; |Δ| ≥ 1 bei {sum(x >= 1 for x in absd)} "
          f"({pct(sum(x >= 1 for x in absd), len(absd))})")
    print(f"- Spanne innerhalb eines Arms (beide Arme): Median {f(med(spreads), 2)}, Mittel {f(mean(spreads), 2)}")
    print(f"- Urteil nach Vorschrift: {'im Rauschen' if med(absd) <= (med(spreads) or 0) else 'über dem Rauschen'}")
    print("\n| Δ | Symbole |\n|---:|---:|")
    for k, v in sorted(Counter(round(d * 2) / 2 for d in deltas).items()):
        print(f"| {f(k, 1)} | {v} |")

# ── Dimensionen einzeln ─────────────────────────────────────────────────────

print("\n## Dimensionen einzeln (S1, Anteil der Lesungen mit Bewertung statt null)\n")
print("| Dimension | alt | neu |\n|---|---:|---:|")
for d in DIMS:
    c = {}
    for a in ARMS:
        rs = [r for r in reads if r["arm"] == a and r["ok"] and r["symbol"] in S1]
        c[a] = pct(sum(1 for r in rs if isinstance(((r["output"].get("dimensions") or {}).get(d) or {}).get("rating"), (int, float))), len(rs))
    print(f"| {d} | {c['alt']} | {c['neu']} |")

print("\n## Mittlere Bewertung je Dimension (S1, nur bewertete Lesungen)\n")
print("| Dimension | alt | neu |\n|---|---:|---:|")
for d in DIMS:
    c = {}
    for a in ARMS:
        vals = [((r["output"].get("dimensions") or {}).get(d) or {}).get("rating") for r in reads
                if r["arm"] == a and r["ok"] and r["symbol"] in S1]
        c[a] = f(mean([v for v in vals if isinstance(v, (int, float))]), 2)
    print(f"| {d} | {c['alt']} | {c['neu']} |")

# ── Beleg ───────────────────────────────────────────────────────────────────

print("\n## Beleg (S1, Prüfer-Modell)\n")
if beleg:
    print("| | alt | neu |\n|---|---:|---:|")
    tally = {a: Counter() for a in ARMS}
    by_kind = {a: defaultdict(Counter) for a in ARMS}
    for (s, a), b in beleg.items():
        if s not in S1:
            continue
        kinds = {i["id"]: i["kind"] for i in b["items"]}
        for u in b["urteile"]:
            tally[a][u["urteil"]] += 1
            by_kind[a][kinds[u["id"]]][u["urteil"]] += 1
    tot = {a: sum(tally[a].values()) for a in ARMS}
    for v in ["belegt", "teilweise", "nicht belegt", None]:
        print(f"| {v or 'ohne Urteil'} | {tally['alt'][v]} ({pct(tally['alt'][v], tot['alt'])}) | {tally['neu'][v]} ({pct(tally['neu'][v], tot['neu'])}) |")
    print(f"| geprüfte Zellen | {sum(1 for (s, a) in beleg if a == 'alt' and s in S1)} | {sum(1 for (s, a) in beleg if a == 'neu' and s in S1)} |")
    print("\n| Art | alt: nicht belegt | neu: nicht belegt | alt: teilweise | neu: teilweise |\n|---|---:|---:|---:|---:|")
    for k in ["bull", "bear", "event"]:
        A, N = by_kind["alt"][k], by_kind["neu"][k]
        print(f"| {k} | {pct(A['nicht belegt'], sum(A.values()))} | {pct(N['nicht belegt'], sum(N.values()))} | "
              f"{pct(A['teilweise'], sum(A.values()))} | {pct(N['teilweise'], sum(N.values()))} |")
else:
    print("Noch keine Prüfer-Urteile.")

# ── Abnahme ─────────────────────────────────────────────────────────────────

print("\n## Leitplanken (S1)\n")
dd = [cell[(s, "neu")]["dims"] - cell[(s, "alt")]["dims"] for s in S1
      if cell[(s, "neu")]["dims"] is not None and cell[(s, "alt")]["dims"] is not None]
ab = {a: sum(1 for s in S1 if cell[(s, a)]["score"] is None) for a in ARMS}
l1 = (med(dd) or 0) >= -0.5 and ab["neu"] - ab["alt"] <= 3
print(f"- **L1 Abdeckung:** Median der Differenz {f(med(dd), 2)} (Grenze ≥ −0,5), Enthaltungen alt {ab['alt']}, "
      f"neu {ab['neu']} (höchstens 3 mehr) → {'erfüllt' if l1 else 'verletzt'}")
if beleg:
    share = {a: tally[a]["nicht belegt"] / tot[a] if tot[a] else None for a in ARMS}
    l2 = share["neu"] is not None and share["neu"] <= 0.10 and share["neu"] <= share["alt"] + 0.03
    print(f"- **L2 Beleg:** nicht belegt alt {pct(tally['alt']['nicht belegt'], tot['alt'])}, neu "
          f"{pct(tally['neu']['nicht belegt'], tot['neu'])} (höchstens 10 % und höchstens 3 Prozentpunkte über alt) → "
          f"{'erfüllt' if l2 else 'verletzt'}")
ms = {a: med([cell[(s, a)]["spread"] for s in S1]) for a in ARMS}
l3 = ms["neu"] is not None and ms["alt"] is not None and ms["neu"] <= ms["alt"] + 0.5
print(f"- **L3 Stabilität:** Median der Spanne alt {f(ms['alt'], 2)}, neu {f(ms['neu'], 2)} (höchstens 0,5 über alt) → "
      f"{'erfüllt' if l3 else 'verletzt'}")

# ── Kosten ──────────────────────────────────────────────────────────────────

print("\n## Tokens\n")
for a in ARMS:
    us = [u for s in symbols for u in cell[(s, a)]["usage"]]
    print(f"- {a}: {len(us)} Lesungen, {sum(u.get('prompt_tokens', 0) for u in us):,} Eingabe- und "
          f"{sum(u.get('completion_tokens', 0) for u in us):,} Ausgabe-Tokens".replace(",", "."))
