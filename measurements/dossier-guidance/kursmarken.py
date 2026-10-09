"""Kursmarken aus Dossier-Prosa ziehen, ohne Modell.

Eine Kursmarke ist ein Geldbetrag in einem Satz mit Chartvokabular, der kein Volumen (»$50 billion«)
und keine Kennzahl (»EPS of $5.20«) ist. Spannen (»$228–230«) ergeben eine Zone mit zwei Enden.
Regel und Kalibrierung: CHARTMARKEN.md.
"""

import re

CURRENCY = r"(?:US\$|USD|HK\$|C\$|A\$|S\$|\$|€|EUR|£|GBP|CHF|¥|JPY|₩|KRW|NOK|SEK|DKK)"
NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
DASH = r"\s*(?:–|—|-|to|bis)\s*"
SCALE = r"(?:\s*|-)(?:billion|bn|million|mn|mio|mrd|trillion|thousand|[bmtk])\b"

# Betrag mit Währung davor, optional als Spanne: $228–230, $260–$265, USD 1,040, € 95
PREFIXED = re.compile(
    rf"(?P<cur>{CURRENCY})\s?(?P<a>{NUMBER})(?:{DASH}(?:{CURRENCY})?\s?(?P<b>{NUMBER}))?",
    re.IGNORECASE,
)
# Betrag mit Währung danach: 132 $, 75 HK$, 1.040 USD, 215–230 dollars
SUFFIXED = re.compile(
    rf"(?<![\w.,$])(?P<a>{NUMBER})(?:{DASH}(?P<b>{NUMBER}))?\s?(?P<cur>US\$|USD|HK\$|\$|€|EUR|dollars?|euros?)(?!\w)",
    re.IGNORECASE,
)

CHART = re.compile(
    r"support|resistance|break(?:s|ing)?\s*(?:out|down|above|below|through)|breakout|breakdown|"
    r"target|channel|\bareas?\b|(?:up|down)side (?:target|area|zone|level|risk to|toward)|trend\s?line|uptrend|downtrend|\blevel|zone|floor|ceiling|re-?test|\b(?:back)?test|pullback|"
    r"moving average|\d+-(?:day|week)|fibonacci|\bgap\b|neckline|pivot|stop|buy area|entry|bounce|"
    r"reclaim|close[sd]? (?:above|below)|hold(?:s|ing)? (?:above|at|the)?|toward|upside to|downside to|"
    r"wedge|triangle|flag|head and shoulders|double (?:top|bottom)|cup and handle|swing|"
    r"unterstützung|widerstand|kursziel|ausbruch|\bmarken?\b|"
    # Ziele und abgeleitete Kurse ohne Chartwort: »projecting $300–350«, »DCF estimate was $527«
    r"project(?:s|ed|ing)?|forecast|price objective|fair value|\bdcf\b|impl(?:y|ies|ied)|valuation of|"
    # Eine Marke als Schwelle: »fall below $227«, »recover above $229«
    r"(?:fall|falls|fell|falling|drop|drops|dropped|slip|slips|break|breaks|broke|move|moves|moved|rise|rises|rose|"
    r"climb|climbs|close|closes|closed|stay|stays|stayed|hold|holds|held|recover|recovers|recovered|push|pushes|"
    r"trade|trades|traded|trading|remain|remains|remained|back|rally|decline|dip|sustained|buy|buying|sell|selling)\s+(?:\w+\s+){0,2}?"
    rf"(?:above|below|under|over|beneath)\s+(?:roughly\s+|about\s+|around\s+)?{CURRENCY}",
    re.IGNORECASE,
)
# Kennzahlen, die wie Kurse aussehen: unmittelbar davor genannt
METRIC_BEFORE = re.compile(
    r"(?:eps|earnings per share|per-share earnings|dividend|revenue|sales|capex|cash flow|book value|"
    r"free cash|net income|profit|backlog|cost|price of (?:oil|gold|crude|brent|wti))\W+"
    r"(?:(?:of|at|was|is|were|to|around|about|roughly|nearly|approximately|near|a|an|the|its|per|share|"
    r"quarterly|annual|expected|estimated|target|consensus|guidance|forecast|fiscal|\d{4})\W+){0,4}$",
    re.IGNORECASE,
)
# ... oder unmittelbar danach: »$30 earnings per share«, »$1.25 dividend«
METRIC_AFTER = re.compile(
    r"\s*(?:(?:19|20)\d\d\s+)?(?:in\s+|of\s+)?(?:earnings|eps|dividend|revenue|sales|free cash|net income|a share in)", re.IGNORECASE)
# Kursverlauf statt Marke: »peaked at $495«, »an all-time high of $240.09«
HISTORY_BEFORE = re.compile(
    r"(?:peaked|bottomed|topped|closed|opened|traded|ended|finished|settled|plunged|soared|jumped|fell|rose)"
    r"\s+(?:at|near|around|to)\s+(?:about\s+|roughly\s+|around\s+)?$|"
    r"(?:all-time|record|52-week|intraday)\s+(?:high|low|close)\s+(?:of|at|near)\s+(?:about\s+|roughly\s+)?$|"
    r"(?:rise|rose|rallied|climbed|surged|jumped|fell|dropped|declined|slid)\s+from\s+[^.]{0,60}?\bto\s+"
    r"(?:almost\s+|nearly\s+|about\s+|around\s+)?$|"
    # »rallied to $18.83«, »has fallen … to $12.61«, »rose sharply from €66 to a peak of €71«
    r"(?:rallied|risen|fallen|dropped|declined|climbed|surged|plunged|tumbled|slumped|slid)\s+(?:[\w’'-]+\s+){0,5}?to\s+$|"
    r"(?:rose|rallied|climbed|surged|jumped|fell|dropped|declined|slid|risen|fallen)\s+(?:\w+\s+)?from\s+$|"
    r"\bto a (?:peak|high|record) of\s+$",
    re.IGNORECASE,
)
# Der Kurs selbst statt einer Marke: »shares were about $350«, »AbbVie’s $260 share price«
PRICE_BEFORE = re.compile(
    r"(?:shares?|stock|ADRs?|(?<!dcf )(?<!fair )(?<!target )(?<!implied )price)\s+"
    r"(?:were|was|is|are|stood|sat|traded|trading|trade)\s+"
    r"(?:at\s+|near\s+|around\s+|about\s+|roughly\s+|approximately\s+)*$|"
    r"(?:trading|traded|trades)\s+(?:at|around|near|about)\s+$|"
    r"share price\s+(?:of|at)\s+(?:about\s+|around\s+|roughly\s+)?$",
    re.IGNORECASE,
)
PRICE_AFTER = re.compile(r"\s*(?:share price|(?:per share|a share)\s*,?\s*(?:with|giving|for) a market)", re.IGNORECASE)
# Beträge je Einheit: »$17 per active customer«, »$20 to $100 per month«
UNIT_AFTER = re.compile(
    r"\s*(?:per|a|each)\s+(?:month|year|quarter|customer|active customer|user|subscriber|unit|seat|ton|tonne|barrel|"
    r"ounce|kwh|mwh|gpu|chip|vehicle|car|square)", re.IGNORECASE)
# Das Chartwort muss nah am Betrag stehen, nicht irgendwo im Satz.
NEAR_BEFORE, NEAR_AFTER = 110, 70


def _num(s: str) -> float:
    return float(s.replace(",", ""))


def sentences(text: str) -> list[str]:
    # Kein Schnitt an Dezimalpunkten oder Abkürzungen wie »U.S.«
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z„\"(])", text) if s.strip()]


def extract(text: str) -> list[dict]:
    out = []
    for sent in sentences(text):
        if not CHART.search(sent):
            continue
        spans = []
        for rx in (PREFIXED, SUFFIXED):
            for m in rx.finditer(sent):
                if any(m.start() < e and s < m.end() for s, e in spans):
                    continue
                tail = sent[m.end():m.end() + 14]
                if re.match(SCALE, tail, re.IGNORECASE):
                    continue
                if re.match(r"\s*(?:%|percent|per cent|x\b|times)", tail, re.IGNORECASE):
                    continue
                before = sent[max(0, m.start() - 80):m.start()]
                if METRIC_BEFORE.search(before) or HISTORY_BEFORE.search(before) or PRICE_BEFORE.search(before):
                    continue
                after = sent[m.end():m.end() + 40]
                if METRIC_AFTER.match(after) or PRICE_AFTER.match(after) or UNIT_AFTER.match(after):
                    continue
                if not CHART.search(sent[max(0, m.start() - NEAR_BEFORE):m.end() + NEAR_AFTER]):
                    continue
                spans.append((m.start(), m.end()))
                a = _num(m.group("a"))
                b = _num(m.group("b")) if m.group("b") else None
                # »$1,040–50« ist 1.040–1.050
                if b is not None and b < a and len(m.group("b").replace(",", "")) < len(m.group("a").replace(",", "")):
                    digits = len(str(int(a))) - len(str(int(b)))
                    b = float(str(int(a))[:digits] + str(int(b)))
                # »cut its target from $20 to $18« ist ein neues Ziel, keine Zone
                if b is not None and re.search(r"\bfrom\s+$", before, re.IGNORECASE) and re.search(r"\bto\b", m.group(0)):
                    a, b = b, None
                lo, hi = (a, b) if b is None or a <= b else (b, a)
                out.append({"low": lo, "high": hi if b is not None else lo, "text": m.group(0), "sentence": sent})
    return out


def numbers(levels: list[dict]) -> set[float]:
    """Alle genannten Zahlen, die Enden einer Zone einzeln."""
    return {x for l in levels for x in (l["low"], l["high"])}
