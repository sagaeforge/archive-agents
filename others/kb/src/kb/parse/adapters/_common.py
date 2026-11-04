"""어댑터 공용 도우미."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urljoin, urlsplit

from kb.core import ids
from kb.parse.model import Edge, Entity, slugify

VERSION_RE = re.compile(r"(\d+(?:\.\d+){1,3})")


def doc_slug(url: str) -> str:
    sp = urlsplit(url)
    h = hashlib.sha256(ids.normalize_url(url).encode()).hexdigest()[:10]
    return f"{slugify(sp.hostname or 'x', 30)}-{h}"


def doc_entity(url: str, label: str | None, source: str | None = None, **props) -> Entity:
    p = {"url": ids.normalize_url(url)}
    if source:
        p["source"] = source
    p.update({k: v for k, v in props.items() if v is not None})
    return Entity(ids.entity_id("document", doc_slug(url)), "Document", (label or url).strip()[:300] or url, p)


def entity_from_cfg(cfg: dict, key: str, default: Entity) -> Entity:
    """소스의 parse.<key> 설정({slug, label, type})을 엔티티로. 설정이 없으면 default."""
    c = (cfg or {}).get(key)
    if not c:
        return default
    t = str(c.get("type", default.type))
    return Entity(ids.entity_id(t.lower(), c["slug"]), t, c.get("label", default.label), c.get("props"))


def version_key(v: str) -> tuple:
    m = VERSION_RE.search(v or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def link_list(items, index_url: str, source: str | None, limit: int, label: str | None = None):
    """(제목, URL) 목록 -> 색인 문서 엔티티, 항목 문서 엔티티, LINKS_TO 엣지."""
    idx = doc_entity(index_url, label, source)
    ents, edges, seen = [idx], [], set()
    for title, href in items:
        u = urljoin(index_url, href)
        if urlsplit(u).scheme not in ("http", "https") or u in seen or u == index_url:
            continue
        seen.add(u)
        e = doc_entity(u, title, source)
        ents.append(e)
        edges.append(Edge(idx.id, "LINKS_TO", e.id))
        if len(seen) >= limit:
            break
    return ents, edges, len(seen)


def day_points(ctx, value, unit=None) -> list:
    from kb.parse.model import day_ms
    s = day_ms(ctx.day)
    return [{"period_key": ctx.day, "period_start": s, "period_end": s + 86400_000, "value": str(value), "unit": unit}]


def jdump(v) -> str:
    return json.dumps(v, ensure_ascii=False)


# ---------------------------------------------------------------- 산문 구간 선언(ADR-0004 D1, `l2: declared`)

def _ptr_match(pats: list, path: tuple) -> bool:
    return any(len(p) == len(path) and all(a == "*" or a == b for a, b in zip(p, path)) for p in pats)


_WS = re.compile(r"[ \t\n\r]*")


def json_string_spans(text: str, patterns) -> list | None:
    """JSON 본문에서 포인터 패턴에 맞는 비지 않은 문자열 값의 코드포인트 구간(따옴표 포함).
    패턴은 `/info/description`, `/hits/*/story_text`처럼 쓰고 `*`는 한 단계 아무 키다.
    표시 본문이 `json-canon@1`(보기 좋게 다시 찍은 JSON)이든 원본 JSON 그대로(`raw_file@1` 시절의 text 표시 본문)든 같다.
    JSON으로 읽을 수 없으면 None(판정 불가)."""
    from json.decoder import scanstring
    pats = [tuple(p.split("/")[1:]) for p in patterns]
    dec = json.JSONDecoder()
    n = len(text)
    spans: list = []

    def ws(i: int) -> int:
        return _WS.match(text, i).end()

    def value(i: int, path: tuple) -> int:
        i = ws(i)
        ch = text[i]
        if ch in "{[":
            close = "}" if ch == "{" else "]"
            i = ws(i + 1)
            if text[i] == close:
                return i + 1
            k = 0
            while True:
                i = ws(i)
                if ch == "{":
                    if text[i] != '"':
                        raise ValueError("key")
                    key, i = scanstring(text, i + 1)
                    i = ws(i)
                    if text[i] != ":":
                        raise ValueError("colon")
                    i += 1
                else:
                    key = str(k)
                    k += 1
                i = ws(value(i, path + (key,)))
                if text[i] == ",":
                    i += 1
                    continue
                if text[i] == close:
                    return i + 1
                raise ValueError("sep")
        if ch == '"':
            v, j = scanstring(text, i + 1)
            if v.strip() and _ptr_match(pats, path):
                spans.append((i, j))
            return j
        _, j = dec.raw_decode(text, i)          # 수, true, false, null
        return j

    try:
        if ws(value(0, ())) != n:
            return None
    except (ValueError, IndexError, RecursionError):
        return None
    return spans


def json_prose(*patterns):
    """어댑터의 prose 선언: JSON 표시 본문에서 patterns 위치의 문자열 값이 산문이다."""
    def prose(text: str, fmt: str, cfg: dict | None = None) -> list | None:
        return json_string_spans(text, patterns)
    prose.spec = "json:" + ",".join(patterns)
    return prose


def csv_cells(text: str) -> list | None:
    """CSV 표시 본문의 칸 목록 [[(start_cp, end_cp, 값), ...], ...](빈 줄은 뺀다). 구간은 따옴표를 포함한다.
    `csv.reader` 기본 방언과 같은 값을 내지 않으면 None(판정 불가)."""
    import csv
    import io
    rows: list = []
    row: list = []
    i, n = 0, len(text)
    while i < n:
        a = i
        if text[i] == '"':
            j, buf = i + 1, []
            while j < n:
                if text[j] == '"':
                    if j + 1 < n and text[j + 1] == '"':
                        buf.append('"')
                        j += 2
                        continue
                    break
                buf.append(text[j])
                j += 1
            j += 1
            while j < n and text[j] not in ",\n" and not (text[j] == "\r" and text[j + 1:j + 2] == "\n"):
                buf.append(text[j])           # 닫는 따옴표 뒤의 글자는 csv 모듈처럼 값에 붙인다
                j += 1
            row.append((a, j, "".join(buf)))
        else:
            j = i
            while j < n and text[j] not in ",\n" and not (text[j] == "\r" and text[j + 1:j + 2] == "\n"):
                j += 1
            row.append((a, j, text[a:j]))
        if j < n and text[j] == ",":
            i = j + 1
            crlf = text[i:i + 2] == "\r\n"
            if i == n or text[i] == "\n" or crlf:
                row.append((i, i, ""))
                if i < n:
                    rows.append(row)
                    row = []
                    i += 2 if crlf else 1
            continue
        rows.append(row)
        row = []
        i = j + (2 if text[j:j + 2] == "\r\n" else 1)
    if row:
        rows.append(row)
    rows = [r for r in rows if not (len(r) == 1 and r[0][2] == "" and r[0][0] == r[0][1])]
    try:
        want = [r for r in csv.reader(io.StringIO(text)) if r]
    except csv.Error:
        return None
    if [[c[2] for c in r] for r in rows] != want:
        return None
    return rows


def csv_prose(text: str, fmt: str, cfg: dict | None = None) -> list | None:
    """csv 어댑터의 prose 선언: 소스 `parse.prose`에 적은 열(이름, 대소문자 무시)의 비지 않은 칸이 산문이다. 설정이 없으면 산문 없음."""
    want = {str(x).strip().lower() for x in ((cfg or {}).get("prose") or [])}
    if not want:
        return []
    rows = csv_cells(text)
    if rows is None:
        return None
    if not rows:
        return []
    cols = {i for i, c in enumerate(rows[0]) if c[2].strip().lower() in want}
    return [(c[0], c[1]) for r in rows[1:] for i, c in enumerate(r) if i in cols and c[2].strip()]


csv_prose.spec = "csv:parse.prose"
