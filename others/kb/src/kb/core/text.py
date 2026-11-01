"""NFC와 토큰화(ADR 14.1, F5 규칙). 색인과 질의가 같은 코드를 쓴다. 표준 라이브러리만 쓴다.

색인 토큰
- 한글 런: 문자 bigram. 1음절 런은 그대로. 3음절 이하 런(어절)은 첫 음절을 더한다.
- 질의는 첫 음절을 더하지 않는다(bigram만). 색인에 첫 음절이 있는 3음절 이하 어절만 1음절 질의로 찾힌다.
- 라틴과 숫자: 소문자. `8,000` -> `8000`. 구분 기호(`.`, `_`, `-`)로 이어진 식별자는 결합형 + 부분 토큰
  (`search.list` -> `searchlist search list`). 숫자만으로 된 버전은 `_` 결합형 + 부분 토큰(`2.1.314` -> `2_1_314 2 1 314`).
- `c++`, `c#`, `.net`은 고정 치환(`cplusplus`, `csharp`, `dotnet`).
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

_SUBS = (
    (re.compile(r"(?<![a-z0-9_])c\+\+"), " cplusplus "),
    (re.compile(r"(?<![a-z0-9_])c#"), " csharp "),
    (re.compile(r"(?<![a-z0-9_])\.net(?![a-z0-9_])"), " dotnet "),
)
_GROUP = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _is_hangul(ch: str) -> bool:
    return "가" <= ch <= "힣"


def _is_latin(ch: str) -> bool:
    # ASCII 영숫자와 라틴 확장 글자(분음 부호를 지우지 않는다: unicode61 remove_diacritics 0과 같다)
    return (ch.isascii() and ch.isalnum()) or (ord(ch) < 0x250 and ch.isalpha())


@lru_cache(maxsize=65536)  # 문자 하나의 순수 함수이고 색인 투영이 게이트 안에서 부른다
def _kind(ch: str) -> str:
    if _is_hangul(ch):
        return "h"
    if _is_latin(ch):
        return "l"
    if ch in "._-":
        return "s"
    if ch.isalpha() or ch.isdigit():
        return "o"  # 한자, 가나 등. 한글처럼 bigram
    return "x"


def _runs(s: str):
    """(종류, 문자열) 런. 라틴 런은 안쪽 구분 기호(.,_,-)를 포함한다."""
    out: list[tuple[str, str]] = []
    i, n = 0, len(s)
    while i < n:
        k = _kind(s[i])
        if k in ("x", "s"):
            i += 1
            continue
        j = i
        if k == "l":
            while j < n:
                kj = _kind(s[j])
                if kj == "l":
                    j += 1
                elif kj == "s" and j + 1 < n and _kind(s[j + 1]) == "l" and _kind(s[j - 1]) == "l":
                    j += 1
                else:
                    break
        else:
            while j < n and _kind(s[j]) == k:
                j += 1
        out.append((k, s[i:j]))
        i = j
    return out


def _latin(run: str) -> list[str]:
    parts = [p for p in re.split(r"[._-]", run) if p]
    if len(parts) <= 1:
        return parts
    if all(p.isdigit() for p in parts):
        return ["_".join(parts), *parts]
    return ["".join(parts), *parts]


def _tokens(s: str, first_syllable: bool) -> list[str]:
    s = nfc(s).lower()
    for pat, rep in _SUBS:
        s = pat.sub(rep, s)
    s = _GROUP.sub("", s)
    out: list[str] = []
    for k, run in _runs(s):
        if k == "l":
            out.extend(_latin(run))
        else:
            if len(run) == 1:
                out.append(run)
                continue
            out.extend(run[i : i + 2] for i in range(len(run) - 1))
            if first_syllable and k == "h" and len(run) <= 3:
                out.append(run[0])
    return out


def index_tokens(s: str) -> list[str]:
    """색인용 토큰(등장 순서). 중복을 남긴다: bm25의 TF와 구문 일치의 위치가 이 순서에서 나온다."""
    return _tokens(s, True)


def query_tokens(s: str) -> list[str]:
    """질의용 토큰(중복 제거, 등장 순서). 첫 음절을 더하지 않는다. 별칭 확장과 AND/OR 조합은 호출자가 한다."""
    return list(dict.fromkeys(_tokens(s, False)))
