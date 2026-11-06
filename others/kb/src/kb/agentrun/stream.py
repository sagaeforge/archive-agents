"""claude -p stream-json 해석. 표준 라이브러리만 쓴다."""
from __future__ import annotations

import json
import re
from typing import Iterable, Iterator

_INC_LINE = re.compile(r"INCIDENT\s+(\{.*\})")
_TEXT_KEYS = ("result", "summary", "output", "message", "text", "content", "data")
KINDS = {"external_send", "global_file_change", "data_loss", "agent_lost", "other"}


def parse_lines(lines: Iterable[str]) -> Iterator[dict]:
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            o = json.loads(ln)
        except ValueError:
            continue
        if isinstance(o, dict):
            yield o


def _texts(o, depth=0) -> Iterator[str]:
    if depth > 6:
        return
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            if k in _TEXT_KEYS or isinstance(v, (dict, list)):
                yield from _texts(v, depth + 1)
    elif isinstance(o, list):
        for v in o:
            yield from _texts(v, depth + 1)


def _norm(i) -> dict | None:
    if not isinstance(i, dict) or not i.get("detail"):
        return None
    kind = i.get("kind") if i.get("kind") in KINDS else "other"
    out = {"kind": kind, "detail": str(i["detail"])[:500]}
    for k in ("path", "at"):
        if i.get(k):
            out[k] = str(i[k])
    return out


def _from_json(v) -> list[dict]:
    got: list[dict] = []
    if isinstance(v, dict):
        if isinstance(v.get("incidents"), list):
            got += [x for x in map(_norm, v["incidents"]) if x]
        for k, w in v.items():
            if k != "incidents" and isinstance(w, (dict, list)):
                got += _from_json(w)
    elif isinstance(v, list):
        for w in v:
            got += _from_json(w)
    return got


def incidents_in(event: dict) -> list[dict]:
    """한 이벤트에서 사고를 꺼낸다: 워크플로우 반환 JSON의 incidents 배열, log의 `INCIDENT {json}` 줄."""
    out: list[dict] = []
    for t in _texts(event):
        t = t.strip()
        for m in _INC_LINE.finditer(t):
            try:
                x = _norm(json.loads(m.group(1)))
            except ValueError:
                x = None
            if x:
                out.append(x)
        if t[:1] in "{[":
            try:
                out += _from_json(json.loads(t))
            except ValueError:
                pass
    seen, uniq = set(), []
    for i in out:  # 같은 이벤트 안 중복(result가 두 키로 반복)을 합친다
        k = json.dumps(i, sort_keys=True)
        if k not in seen:
            seen.add(k)
            uniq.append(i)
    return uniq
