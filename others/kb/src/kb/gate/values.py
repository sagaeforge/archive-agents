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
# 날짜 표기만. concepts()는 spell() 뒤에 돌므로 "August 24"는 "8 24"로 온다(may만 남는다). through, beginning은 이 뒤에서만 비교어다.
_DATE = r"(?:\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+\d{1,2}\b|may\s+\d)"
CONCEPT = {
    "ge": [_N + "이상", r"at least", r"or more", r"최소", r"minimum", r"more than",
           r"approx_traffic>\d[\d,]*\+<"],                # Google Trends RSS의 값 표기만. S24+, Python 3+ 같은 이름의 +는 비교어가 아니다
    "le": [_N + r"(?:이하|미만|이내)", r"at most", r"or less", r"\d\s*seconds?\s+or\s+shorter", r"최대", r"maximum", r"up to", r"less than",
           rf"\bwithin\s+{_NUMLIKE}"],
    "after": [_N + r"(?:부터|이후)", rf"\b(?:after|from|since|starting)\s+(?:on\s+|in\s+|the\s+)?{_NUMLIKE}",
              rf"\bbeginning\s+(?:on\s+)?{_DATE}"],
    "before": [_N + r"(?:까지|이전)", rf"\b(?:before|until|by|within)\s+(?:the\s+)?(?:next\s+|last\s+)?{_NUMLIKE}",
               rf"\bthrough\s+{_DATE}"],
    "usd": [r"달러", r"\$", r"USD"], "krw": [r"\d\s*원", r"KRW", r"₩"],
    "hour": [r"\d\s*시간", r"\d[\s-]*hours?\b", r"\d\s+(?:(?:qualified|public)\s+){0,2}watch[\s-]hours?\b"], "min": [r"\d\s*분", r"\d[\s-]*minutes?\b"],
    "day": [r"\d\s*일\b", r"\d\s*일\s", r"\d[\s-]*days?\b"], "week": [r"\d\s*주", r"\d[\s-]*weeks?\b"],
    "month": [r"\d\s*개월", r"\d[\s-]*months?\b"], "year": [r"\d\s*년", r"\d[\s-]*years?\b"],
    "pct": [r"%", r"퍼센트", r"percent"], "eok": [r"\d\s*억", r"billion"], "man": [r"\d\s*만", r"million"],
}
_CRE = {k: [re.compile(p, re.I) for p in ps] for k, ps in CONCEPT.items()}
EQUIV = {"after": {"ge"}, "le": {"before"}, "before": {"le"}}
NEGW = [re.compile(p, re.I) for p in (
    r"않", r"없", r"(?<![가-힣])못(?![가-힣]*된)", r"불가", r"금지", r"아니", r"누락", r"\bnot\b", r"\bno\b", r"\bnever\b",
    r"cannot", r"can't", r"n't\b", r"without", r"unless", r"neither", r"\bnothing\b", r"\bnone\b", r"\binstead of\b",
    r"\bunable\b", r"\bunbound\b", r"\bunset\b", r"\bunavailable\b")]
# 부정이 아닌 가산 구문: "A뿐 아니라 B", "not only/just". 부정어 검사 전에 지운다.
_ADDITIVE = re.compile(r"뿐(?:만)?\s*아니라|\bnot\s+(?:only|just|merely)\b", re.I)
# 순번 표기 "No. 2"의 No.는 부정어가 아니다. 같은 줄에서 숫자가 뒤따르고 문장 첫머리가 아닐 때만 지운다.
# 문장 첫머리(글 시작, . ! ? : ; 줄바꿈 뒤)의 "No. 3"은 질문에 대한 답 "No."와 구별되지 않으므로 부정으로 둔다(의심이면 검사가 걸린다).
_ORDINAL_NO = re.compile(r"\bno\.[ \t]*\d", re.I)
_SENT_START = ".!?:;\n\"\u201c\u2018(\u2014\u2013"


def _drop_ordinal_no(s: str) -> str:
    def f(m):
        pre = s[:m.start()].rstrip(" \t")
        return m.group(0) if not pre or pre[-1] in _SENT_START else " "
    return _ORDINAL_NO.sub(f, s)


# 부정어 동등 표현은 문장 표현과 인용구 표현이 짝으로 있을 때만 지운다.
# "instead of B"는 문장의 "B 대신"과 바로 앞뒤 낱말이 같아야 한다. A와 B가 뒤바뀐 문장은 그대로 걸린다.
_INSTEAD_ST = re.compile(r"(\S+)\s+대신")
_INSTEAD_Q = re.compile(r"\binstead of\s+([\w.-]+)", re.I)
# 광고 형식 이름 Non-skippable. 인용구에 이 이름이 있으면 문장에도 같은 이름이 있어야 한다. 짝을 지운 뒤 남은 부분의 부정을 비교한다.
_NONSKIP_ST = re.compile(r"건너뛸\s+수\s+없는|\bnon-skippable\b", re.I)
_NONSKIP_Q = re.compile(r"\bnon-skippable\b", re.I)
# "0.6%포인트"와 "0.6 share points". 문장의 %가 모두 %포인트일 때만 맞는다. "0.6%"는 share points와 다른 값이다.
_SHARE_PT = re.compile(r"\d\s+share\s+points?\b", re.I)
_PCT_PLAIN = re.compile(r"%(?!\s*포인트)|퍼센트(?!\s*포인트)|percent(?!age\s+points?)", re.I)
# 생략 연도 "’24년 79.2%". 아포스트로피와 바로 뒤의 % 값이 함께 있을 때만 20YY로 본다(00~29). "’30년 전통", "경력 24년", "(24년)"은 넓히지 않는다.
_APOS_YY = re.compile(r"[’‘'](?=[0-2]\d\s*년\s+\d[\d.]*\s*%)")
_YEAR_ST = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*년")
_ISO_DATE = re.compile(r"(?<!\d)(?:19|20)\d{2}-\d{2}-\d{2}")
_ISO_TIME = re.compile(r"(?<!\d)\d{1,2}:\d{2}")
_EN_DATE = re.compile(r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b", re.I)
def concepts(s: str) -> set:
    s = spell(s)
    return {k for k, ps in _CRE.items() if any(p.search(s) for p in ps)}


def quote_concepts(q: str) -> set:
    """인용구의 개념. 날짜·시각 표기(ISO, 영어 월 이름)는 년·일·분·시간 개념을 함께 제공한다(한국어 문장이 이를 풀어 쓴 경우)."""
    out = concepts(q)
    if _ISO_DATE.search(q):
        out |= {"year", "day"}
    if _EN_DATE.search(q) or _ISO_DATE.search(q):
        out |= {"day"}
    if _ISO_TIME.search(q):
        out |= {"min", "hour"}
    return out


def has_neg(s: str) -> bool:
    s = _drop_ordinal_no(_ADDITIVE.sub(" ", s.replace("\u2019", "'")))
    return any(p.search(s) for p in NEGW)


def _neg_differs(statement: str, quote: str) -> bool:
    """부정어 동등성. 양쪽에 같은 뜻으로 있는 짝만 지운다. 문장에 부정이 없는데 인용구에 not이 있으면 걸린다."""
    s, q = statement, quote
    if _NONSKIP_Q.search(q):
        if not _NONSKIP_ST.search(s):
            return True
        s, q = _NONSKIP_ST.sub(" ", s), _NONSKIP_Q.sub(" ", q)
    if has_neg(s) == has_neg(q):
        return False
    a, b = _INSTEAD_ST.search(s), _INSTEAD_Q.search(q)
    if a and b and a.group(1).lower() == b.group(1).lower():
        s, q = _INSTEAD_ST.sub(" ", s), _INSTEAD_Q.sub(" ", q)
    return has_neg(s) != has_neg(q)


def value_issues(statement: str, quote: str, subject_forms=()) -> list:
    """문장이 인용구에 없는 값을 말하면 사유 목록. 비면 통과.
    subject_forms: 주어의 라벨·별칭. 주어 식별자에 든 숫자(게시물 번호 등)는 인용구에 없어도 된다."""
    why = []
    own = set()
    for f in subject_forms or ():
        own |= nums(f)
    full = _APOS_YY.sub("20", quote)                              # 인용구 값만 넓힌다. 원래 값도 그대로 남긴다
    qnums = nums(quote) | nums(full)
    extra = nums(statement) - qnums - own
    if extra:
        why.append("num:" + ",".join(sorted(extra)))
    if HANGUL.search(quote):
        qpairs = pairs(quote) | pairs(full)
        qn = {n for n, _ in qpairs}
        bare = qnums - qn                                        # 단위 없이 나온 숫자(순위 표 등)는 단위 불일치로 보지 않는다
        px = {(n, u) for n, u in pairs(statement) - qpairs if n not in bare}
        if px:
            why.append("pair:" + ",".join(f"{n}{u}" for n, u in sorted(px)))
    sc, qc = concepts(statement), quote_concepts(quote)
    if "year" in sc and "year" not in qc:                         # 'YYYY년'이 인용구에 YYYY로 있으면 년 개념을 가졌다고 본다
        ys = _YEAR_ST.findall(spell(statement))
        if ys and all(y in nums(quote) for y in ys):
            qc = qc | {"year"}
    if "pct" in sc and "pct" not in qc and _SHARE_PT.search(spell(quote)) and not _PCT_PLAIN.search(statement):
        qc = qc | {"pct"}
    miss = {c for c in sc if c not in qc and not (EQUIV.get(c, set()) & qc)}
    if miss:
        why.append("concept:" + ",".join(sorted(miss)))
    if _neg_differs(statement, quote):
        why.append("neg")
    return why
