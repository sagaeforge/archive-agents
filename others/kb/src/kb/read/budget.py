"""토큰 추정과 카드 예산(WP-04). 추정식은 1.5×한글 + 0.5×기타이고 chars/4를 쓰지 않는다(ADR 15.2).

카드는 통째로 넣거나 통째로 뺀다. 문장 중간을 자르지 않는다. 점수와 관련도 수치를 만들지 않는다.
"""
from __future__ import annotations

import math
import re
import unicodedata

DEFAULT_BUDGET = 6000
WARN_TOKENS = 10_000
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁠-⁤﻿]+")
_WS = re.compile(r"[  ]+")


def is_hangul(ch: str) -> bool:
    o = ord(ch)
    return 0xAC00 <= o <= 0xD7A3 or 0x1100 <= o <= 0x11FF or 0x3130 <= o <= 0x318F or 0xA960 <= o <= 0xA97F or 0xD7B0 <= o <= 0xD7FF


def est_tokens(text: str) -> int:
    """1.5×한글 + 0.5×기타를 올림한다."""
    h = sum(1 for c in text if is_hangul(c))
    return math.ceil(1.5 * h + 0.5 * (len(text) - h))


def clean(text) -> str:
    """탭, 개행, 제어 문자를 지우고 공백을 하나로 모은다. 비신뢰 입력을 카드 한 칸에 넣기 전에 쓴다."""
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text))
    s = _CTRL.sub(" ", s)
    return _WS.sub(" ", s).strip()


def take(card_tokens: list[int], available: int) -> int:
    """앞에서부터 예산 안에 드는 카드 수. 카드는 통째로 넣는다."""
    used = 0
    for i, t in enumerate(card_tokens):
        if used + t > available:
            return i
        used += t
    return len(card_tokens)
