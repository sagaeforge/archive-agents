"""4단계: 값 토큰. 숫자는 인용구에서만 찾고, 문장의 숫자·단위·비교어·부정어는 인용구에 있어야 한다.
전부 정규식이고 결정적이다. 프로토타입 gate2_fix.py의 check를 정리했다."""
from __future__ import annotations

import re

WORDNUM = {"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
           "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
           "fifteen": "15", "twenty": "20", "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60",
           "seventy": "70", "eighty": "80", "ninety": "90"}
MONTHS = {"jan": "1", "feb": "2", "mar": "3", "apr": "4", "jun": "6", "jul": "7", "aug": "8", "sep": "9", "oct": "10",
          "nov": "11", "dec": "12", "january": "1", "february": "2", "march": "3", "april": "4", "june": "6",
          "july": "7", "august": "8", "september": "9", "october": "10", "november": "11", "december": "12"}
_WORD_RE = re.compile(r"\b(" + "|".join(sorted(WORDNUM, key=len, reverse=True)) + r")\b", re.I)
_MONTH_RE = re.compile(r"\b(" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\b\.?(?=\s+\d)|(?<=\d\s)\b("
                       + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\b", re.I)
NUM = re.compile(r"\d[\d,\.]*\d|\d")
HANGUL = re.compile("[가-힣]")
PAIR = re.compile(r"(\d[\d,.]*)\s*([가-힣%]{1,2})")


def spell(s: str) -> str:
    """철자 수(five)와 영어 월 이름을 숫자로 바꾼 사본. 대조용이다."""
    s = _WORD_RE.sub(lambda m: WORDNUM[m.group(1).lower()], s)
    return _MONTH_RE.sub(lambda m: MONTHS[(m.group(1) or m.group(2)).lower()], s)


def _norm_num(x: str) -> str:
    x = x.replace(",", "").rstrip(".")
    return x.lstrip("0") or "0" if x.isdigit() else x


def nums(s: str) -> set:
    return {_norm_num(x) for x in NUM.findall(spell(s))}


def pairs(s: str) -> set:
    return {(_norm_num(n), u[0]) for n, u in PAIR.findall(s)}


_N = r"\d[\d,.]*\s*(?:년|월|일|시간|분|주|개월|회|명|달러|원|%|억|만|천|포인트|단계|개|건|초|배)?\s*"
_NUMLIKE = r"(?:v?\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)"
CONCEPT = {
    "ge": [_N + "이상", r"at least", r"or more", r"최소", r"minimum", r"more than"],
    "le": [_N + r"(?:이하|미만|이내)", r"at most", r"or less", r"최대", r"maximum", r"up to", r"less than",
           rf"\bwithin\s+{_NUMLIKE}"],
    "after": [_N + r"(?:부터|이후)", rf"\b(?:after|from|since|starting)\s+(?:on\s+|in\s+|the\s+)?{_NUMLIKE}"],
    "before": [_N + r"(?:까지|이전)", rf"\b(?:before|until|by|within)\s+(?:the\s+)?(?:next\s+|last\s+)?{_NUMLIKE}"],
    "usd": [r"달러", r"\$", r"USD"], "krw": [r"\d\s*원", r"KRW", r"₩"],
    "hour": [r"\d\s*시간", r"\d[\s-]*hours?\b"], "min": [r"\d\s*분", r"\d[\s-]*minutes?\b"],
    "day": [r"\d\s*일\b", r"\d\s*일\s", r"\d[\s-]*days?\b"], "week": [r"\d\s*주", r"\d[\s-]*weeks?\b"],
    "month": [r"\d\s*개월", r"\d[\s-]*months?\b"], "year": [r"\d\s*년", r"\d[\s-]*years?\b"],
    "pct": [r"%", r"퍼센트", r"percent"], "eok": [r"\d\s*억", r"billion"], "man": [r"\d\s*만", r"million"],
}
_CRE = {k: [re.compile(p, re.I) for p in ps] for k, ps in CONCEPT.items()}
EQUIV = {"after": {"ge"}, "le": {"before"}, "before": {"le"}}
NEGW = [re.compile(p, re.I) for p in (
    r"않", r"없", r"(?<![가-힣])못(?![가-힣]*된)", r"불가", r"금지", r"아니", r"\bnot\b", r"\bno\b", r"\bnever\b",
    r"cannot", r"can't", r"n't\b", r"without", r"unless", r"neither")]


def concepts(s: str) -> set:
    s = spell(s)
    return {k for k, ps in _CRE.items() if any(p.search(s) for p in ps)}


def has_neg(s: str) -> bool:
    return any(p.search(s) for p in NEGW)


def value_issues(statement: str, quote: str) -> list:
    """문장이 인용구에 없는 값을 말하면 사유 목록. 비면 통과."""
    why = []
    extra = nums(statement) - nums(quote)
    if extra:
        why.append("num:" + ",".join(sorted(extra)))
    if HANGUL.search(quote):
        px = pairs(statement) - pairs(quote)
        if px:
            why.append("pair:" + ",".join(f"{n}{u}" for n, u in sorted(px)))
    sc, qc = concepts(statement), concepts(quote)
    miss = {c for c in sc if c not in qc and not (EQUIV.get(c, set()) & qc)}
    if miss:
        why.append("concept:" + ",".join(sorted(miss)))
    if has_neg(statement) != has_neg(quote):
        why.append("neg")
    return why
