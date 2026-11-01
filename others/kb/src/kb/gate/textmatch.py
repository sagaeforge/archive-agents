"""3단계: 인용구 위치 찾기. NFC와 공백 접기만 허용하고 결과는 표시 본문의 코드포인트 오프셋이다."""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache

MIN_QUOTE = 8
MAX_HITS = 64


class QuoteError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


@dataclass(frozen=True)
class Loc:
    start: int
    end: int


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def fold(s: str) -> str:
    """NFC + 공백 압축 + 앞뒤 공백 제거."""
    return " ".join(nfc(s).split())


@lru_cache(maxsize=8)
def _folded(text: str) -> tuple[str, tuple]:
    """접힌 본문과 접힌 위치 -> 원문 위치 표."""
    out, idx, prev_sp = [], [], False
    for i, ch in enumerate(text):
        if ch.isspace():
            if not prev_sp:
                out.append(" ")
                idx.append(i)
                prev_sp = True
        else:
            out.append(ch)
            idx.append(i)
            prev_sp = False
    return "".join(out), tuple(idx)


def locate(text: str, quote: str, prefix: str = "", suffix: str = "") -> Loc:
    """인용구의 원문 오프셋 [start, end). 실패는 QuoteError(E_QUOTE_SHORT | E_QUOTE_NOT_FOUND | E_QUOTE_AMBIGUOUS)."""
    q = fold(quote or "")
    if len(q) < MIN_QUOTE:
        raise QuoteError("E_QUOTE_SHORT", f"인용구 {len(q)}자 < {MIN_QUOTE}")
    folded, idx = _folded(text)
    hits, i = [], folded.find(q)
    while i >= 0 and len(hits) < MAX_HITS:
        hits.append(i)
        i = folded.find(q, i + 1)
    if not hits:
        raise QuoteError("E_QUOTE_NOT_FOUND", "표시 본문에 인용구가 없다")
    if len(hits) > 1:
        p, s = fold(prefix or ""), fold(suffix or "")
        if not (p or s):
            raise QuoteError("E_QUOTE_AMBIGUOUS", f"{len(hits)}곳에 있다. prefix, suffix가 필요하다")
        hits = [h for h in hits
                if (not p or folded[:h].rstrip().endswith(p)) and (not s or folded[h + len(q):].lstrip().startswith(s))]
        if len(hits) != 1:
            raise QuoteError("E_QUOTE_AMBIGUOUS", f"prefix, suffix로 좁혀도 {len(hits)}곳이다")
    h = hits[0]
    return Loc(idx[h], idx[h + len(q) - 1] + 1)
