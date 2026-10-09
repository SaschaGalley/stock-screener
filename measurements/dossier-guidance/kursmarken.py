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
    r"target|channel|trend\s?line|uptrend|downtrend|\blevel|zone|floor|ceiling|re-?test|\btest|pullback|"
    r"moving average|\d+-(?:day|week)|fibonacci|\bgap\b|neckline|pivot|stop|buy area|entry|bounce|"
    r"reclaim|close[sd]? (?:above|below)|hold(?:s|ing)? (?:above|at|the)?|toward|upside to|downside to|"
    r"wedge|triangle|flag|head and shoulders|double (?:top|bottom)|cup and handle|swing|"
    r"unterstützung|widerstand|kursziel|ausbruch|marke|"
    # Ziele und abgeleitete Kurse ohne Chartwort: »projecting $300–350«, »DCF estimate was $527«
    r"project(?:s|ed|ing)?|forecast|price objective|fair value|\bdcf\b|impl(?:y|ies|ied)|valuation of|"
    # Eine Marke als Schwelle: »fall below $227«, »recover above $229«
    r"(?:above|below|under|over|beneath)\s+(?:roughly\s+|about\s+|around\s+)?(?:US|HK|C|A)?\$",
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
    r"(?:all-time|record|52-week|intraday)\s+(?:high|low|close)\s+(?:of|at|near)\s+(?:about\s+|roughly\s+)?$",
    re.IGNORECASE,
)


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
                if METRIC_BEFORE.search(before) or HISTORY_BEFORE.search(before):
                    continue
                if METRIC_AFTER.match(sent[m.end():m.end() + 24]):
                    continue
                spans.append((m.start(), m.end()))
                a = _num(m.group("a"))
                b = _num(m.group("b")) if m.group("b") else None
                # »$1,040–50« ist 1.040–1.050
                if b is not None and b < a and len(m.group("b").replace(",", "")) < len(m.group("a").replace(",", "")):
                    digits = len(str(int(a))) - len(str(int(b)))
                    b = float(str(int(a))[:digits] + str(int(b)))
                lo, hi = (a, b) if b is None or a <= b else (b, a)
                out.append({"low": lo, "high": hi if b is not None else lo, "text": m.group(0), "sentence": sent})
    return out


def numbers(levels: list[dict]) -> set[float]:
    """Alle genannten Zahlen, die Enden einer Zone einzeln."""
    return {x for l in levels for x in (l["low"], l["high"])}
