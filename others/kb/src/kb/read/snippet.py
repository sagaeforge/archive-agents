"""스니펫과 하이라이트(WP-05). FTS snippet()을 쓰지 않고 표시 본문에서 질의 항을 다시 찾는다.

오프셋은 스니펫 문자열 기준 코드포인트다(앞의 `…`도 센다). 표준 라이브러리만 쓴다.
"""
from __future__ import annotations

import re

LEAD = 40
MAX_LEN = 160
MAX_HIGHLIGHTS = 20
ELLIPSIS = "…"
_SEP = "._-"
_EDGE = re.compile(r"^[^0-9a-z가-힣぀-ヿ一-鿿]+|[^0-9a-z가-힣぀-ヿ一-鿿+#]+$")


def _lower(text: str) -> str:
    """길이를 바꾸지 않는 소문자화(오프셋 보존)."""
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


def _word_pattern(word: str) -> re.Pattern | None:
    w = _EDGE.sub("", word.strip().lower())
    if not w:
        return None
    parts = []
    for i, ch in enumerate(w):
        nxt = w[i + 1] if i + 1 < len(w) else ""
        if ch in _SEP:
            parts.append(r"[._\- ]?")
        elif ch.isspace():
            parts.append(r"\s+")
        elif ch == ",":
            parts.append(r",?")
        elif ch.isdigit() and nxt.isdigit():
            parts.append(re.escape(ch) + ",?")
        else:
            parts.append(re.escape(ch))
    body = "".join(parts)
    pre = r"(?<![0-9a-z])" if w[0].isascii() and w[0].isalnum() else ""
    post = r"(?![0-9a-z])" if w[-1].isascii() and w[-1].isalnum() else ""
    try:
        return re.compile(pre + body + post)
    except re.error:
        return None


def find_spans(text: str, words: list[str], tokens: list[str]) -> list[tuple[int, int]]:
    """질의 단어(별칭 대안 포함)의 일치 구간. 하나도 없으면 토큰을 그대로 찾는다. 겹치면 합친다."""
    low = _lower(text)
    spans: list[tuple[int, int]] = []
    for w in dict.fromkeys(words):
        pat = _word_pattern(w)
        if pat:
            spans += [m.span() for m in pat.finditer(low) if m.end() > m.start()]
    if not spans:
        for t in dict.fromkeys(tokens):
            if "_" in t or not t:
                continue
            i = low.find(t)
            while i != -1:
                spans.append((i, i + len(t)))
                i = low.find(t, i + len(t))
    spans.sort()
    merged: list[list[int]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def make_snippet(text: str, words: list[str], tokens: list[str], *, lead: int = LEAD, max_len: int = MAX_LEN) -> dict:
    """{snippet, highlights:[{start,end}]}. 첫 일치 앞 lead자부터 max_len자까지."""
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    spans = find_spans(text, words, tokens)
    n = len(text)
    if not spans:
        cut = text[:max_len]
        return {"snippet": cut + (ELLIPSIS if n > max_len else ""), "highlights": []}
    a0 = spans[0][0]
    start = max(0, a0 - lead)
    end = min(n, start + max_len)
    if spans[0][1] > end:
        end = min(n, spans[0][1])
    pre = ELLIPSIS if start > 0 else ""
    post = ELLIPSIS if end < n else ""
    hl = []
    for a, b in spans:
        if a >= start and b <= end:
            hl.append({"start": a - start + len(pre), "end": b - start + len(pre)})
        if len(hl) >= MAX_HIGHLIGHTS:
            break
    return {"snippet": pre + text[start:end] + post, "highlights": hl}
