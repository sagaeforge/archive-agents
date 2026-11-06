"""문단 색인(ADR 7.7). 표시 본문을 빈 줄과 제목으로 나누고 500자를 넘으면 문장 경계로 나눈다.
오프셋은 표시 본문의 코드포인트(start 포함, end 미포함). 표 행은 머리 줄과 절 제목을 문맥으로 함께 둔다."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from kb.core import cas
from kb.core.canon import canon_json, sha256_hex

MAX_CHARS = 500
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t#]*$")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_SENT_END = re.compile(r"(?<=[.!?。！？])[\"')\]”’]*\s+|(?<=다\.)\s+|(?<=요\.)\s+")


@dataclass
class Para:
    para_sha: str
    start_cp: int
    end_cp: int
    heading_path: list = field(default_factory=list)
    table_header: list | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _cells(line: str) -> list[str]:
    s = line.strip()
    s = s[1:] if s.startswith("|") else s
    s = s[:-1] if s.endswith("|") else s
    return [c.strip() for c in s.split("|")]


def _split_long(text: str, a: int, b: int, fmt: str) -> list[tuple[int, int]]:
    """[a,b) 구간이 MAX_CHARS를 넘으면 경계에서 나눈다. 경계: json은 줄, 그 밖은 문장 끝, 줄, 공백, 마지막은 글자 수."""
    if b - a <= MAX_CHARS:
        return [(a, b)]
    out, cur = [], a
    while b - cur > MAX_CHARS:
        window = text[cur:cur + MAX_CHARS]
        cut = None
        if fmt != "json":
            ends = [m.end() for m in _SENT_END.finditer(window)]
            ends = [e for e in ends if e >= MAX_CHARS // 4]
            cut = ends[-1] if ends else None
        if cut is None:
            i = window.rfind("\n")
            cut = i + 1 if i >= MAX_CHARS // 4 else None
        if cut is None:
            i = window.rfind(" ")
            cut = i + 1 if i >= MAX_CHARS // 4 else MAX_CHARS
        out.append((cur, cur + cut))
        cur += cut
    if cur < b:
        out.append((cur, b))
    return out


def _trim(text: str, a: int, b: int) -> tuple[int, int]:
    while a < b and text[a].isspace():
        a += 1
    while b > a and text[b - 1].isspace():
        b -= 1
    return a, b


def paragraphs(text: str, fmt: str = "markdown") -> list[Para]:
    """결정적. 같은 입력은 같은 목록. 한 글자가 바뀌면 그 문단의 para_sha만 바뀐다."""
    lines: list[tuple[int, int]] = []
    pos = 0
    for ln in text.split("\n"):
        lines.append((pos, pos + len(ln)))
        pos += len(ln) + 1
    out: list[Para] = []
    path: list[tuple[int, str]] = []
    block: list[tuple[int, int]] = []
    in_code = False
    table_hdr: list[str] | None = None

    def emit(a: int, b: int, hdr=None) -> None:
        a, b = _trim(text, a, b)
        if a >= b:
            return
        hp = [h for _, h in path]
        for s, e in _split_long(text, a, b, fmt):
            s, e = _trim(text, s, e)
            if s < e:
                out.append(Para(sha256_hex(text[s:e].encode("utf-8")), s, e, list(hp), list(hdr) if hdr else None))

    def flush() -> None:
        nonlocal block
        if block:
            emit(block[0][0], block[-1][1])
        block = []

    i = 0
    while i < len(lines):
        a, b = lines[i]
        ln = text[a:b]
        if fmt != "json" and ln.lstrip().startswith(("```", "~~~")):
            if not in_code:
                flush()
            in_code = not in_code
            block.append((a, b))
            if not in_code:
                flush()
            i += 1
            continue
        if in_code:
            block.append((a, b))
            i += 1
            continue
        if not ln.strip():
            flush()
            table_hdr = None
            i += 1
            continue
        h = _HEADING.match(ln) if fmt != "json" else None
        if h:
            flush()
            table_hdr = None
            lvl = len(h.group(1))
            while path and path[-1][0] >= lvl:
                path.pop()
            path.append((lvl, h.group(2).strip()))
            emit(a, b)
            i += 1
            continue
        if fmt != "json" and _TABLE_ROW.match(ln):
            if table_hdr is None and i + 1 < len(lines) and _TABLE_SEP.match(text[lines[i + 1][0]:lines[i + 1][1]]):
                flush()
                table_hdr = _cells(ln)
                emit(a, b, table_hdr)              # 머리 줄도 한 문단
                i += 2                              # 구분선은 문단이 아니다
                continue
            if table_hdr is not None:
                flush()
                emit(a, b, table_hdr)
                i += 1
                continue
        table_hdr = None
        block.append((a, b))
        if fmt == "json" and sum(y - x + 1 for x, y in block) >= MAX_CHARS // 2:
            flush()
        i += 1
    flush()
    return out


def store(paras: list[Para], tier: str = "objects") -> str:
    """문단 목록을 CAS 객체로 저장하고 paras_sha를 돌려준다(schemas/events/objects/paras.schema.json)."""
    return cas.put(canon_json([p.as_dict() for p in paras]), tier=tier)
