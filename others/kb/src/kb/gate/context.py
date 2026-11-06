"""5단계: 주어 문맥. 주어 별칭이 인용구, 같은 문단, 표 머리, 절 제목, 문서 제목 중 하나에 있어야 하고,
문장에 나온 다른 등록 엔티티 별칭은 주어의 별칭이거나 인용구·문맥에 있어야 한다."""
from __future__ import annotations

import re
import unicodedata

_ASCII = re.compile(r"[a-z0-9]")
_SPLIT = re.compile(r"[./_]+")


def norm(s: str) -> str:
    return " ".join(unicodedata.normalize("NFC", s or "").lower().split())


def _bounded(a: str, hay: str) -> bool:
    """ASCII 영숫자로 시작하거나 끝나는 별칭은 단어 경계를 요구한다(짧은 별칭이 단어 안에서 맞는 것을 막는다)."""
    start = 0
    while True:
        i = hay.find(a, start)
        if i < 0:
            return False
        b = hay[i - 1] if i else " "
        e = hay[i + len(a)] if i + len(a) < len(hay) else " "
        ok_l = not (_ASCII.fullmatch(a[0]) and _ASCII.fullmatch(b))
        ok_r = not (_ASCII.fullmatch(a[-1]) and _ASCII.fullmatch(e))
        if ok_l and ok_r:
            return True
        start = i + 1


def alias_in(alias: str, hay: str) -> bool:
    """alias, hay는 norm 처리된 문자열. captions.list 같은 점·슬래시 별칭은 모든 부분이 있으면 맞는다
    (표에서 `| captions | list |`로 흩어진 경우)."""
    a = norm(alias)
    if len(a) < 2 and not (len(a) == 1 and "가" <= a <= "힣"):
        return False
    if _bounded(a, hay):
        return True
    parts = [p for p in _SPLIT.split(a) if p]
    return len(parts) >= 2 and all(len(p) >= 2 and _bounded(p, hay) for p in parts)


def build_hay(quote: str, para_text: str, table_header, heading_path, doc_title: str, source_names=()) -> str:
    """source_names: 소스 이름·발행처·레지스트리 별칭. 문서 제목이 일반어일 때 주어를 소스 문맥에서 찾는다."""
    bits = [quote, para_text, " ".join(table_header or []), " ".join(heading_path or []), doc_title or "",
            " ".join(x for x in (source_names or ()) if x)]
    return norm(" ".join(bits))


def _prefixes(alias: str) -> list:
    """3단어 이상 라벨의 앞쪽 단어열(2단어 이상, 6자 이상). 'Hacker News 게시물 1019360'의 'Hacker News'처럼
    라벨 끝의 식별자·수식어가 문맥에 없어도 주어의 이름 부분이 있으면 맞는 것으로 본다."""
    toks = norm(alias).split()
    out = []
    for k in range(len(toks) - 1, 1, -1):
        p = " ".join(toks[:k]).rstrip(":,;-")
        if len(p) >= 6:
            out.append(p)
    return out


def subject_in_context(aliases, hay: str) -> bool:
    return any(alias_in(a, hay) or any(_bounded(p, hay) for p in _prefixes(a)) for a in aliases if a)


def alias_conflicts(statement: str, subject_id: str, subject_aliases, known: dict, hay: str) -> list:
    """문장에 나온 등록 엔티티 별칭 중 주어와 무관하고 근거 문맥에도 없는 것."""
    st = norm(statement)
    sub = [norm(a) for a in subject_aliases if a]
    found = [a for a in known if len(a) >= 2 and a in st and known[a] != subject_id and _bounded(a, st)]
    found.sort(key=len, reverse=True)
    kept: list = []
    for a in found:
        if any(a in k for k in kept):
            continue                                  # 더 긴 별칭의 일부
        kept.append(a)
    bad = []
    for a in kept:
        if any(a in s or s in a for s in sub):
            continue                                  # 주어 별칭과 겹침
        if _bounded(a, hay):
            continue
        bad.append(a)
    return bad
