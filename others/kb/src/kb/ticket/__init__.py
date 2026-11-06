"""요청 티켓 쓰기(WP-12, ADR 15.3). 공개 함수: open_ticket, list_tickets, close_ticket.

kb_request(MCP)와 kb request(CLI)가 같은 open_ticket을 부른다. 티켓은 ticket.* 이벤트이고 주장을 만들지 않는다.
세션이 알린 URL은 티켓의 urls에 쌓일 뿐이고 수집 경로의 게이트를 지나기 전에는 사실이 아니다.
병합: 정규화한 주제의 bigram Jaccard >= 0.5 그리고 별칭 엔티티 집합이 같으면 열린 티켓에 합친다.
읽기는 kb.read(WP-04), 쓰기는 kb.write.commit이다. 이 모듈은 DB를 직접 열지 않는다.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import urlsplit, urlunsplit

from kb.core import ids
from kb.write import author as _author
from kb.write.errors import WriteRejected

OPEN = ("queued", "in_progress")
CLOSING = ("done", "unanswerable", "blocked_policy")
PRIORITY = {"low": 0, "normal": 1, "high": 2}
JACCARD_MIN = 0.5
MAX_URLS = 50
MAX_TEXT = 500
MAX_URL = 2048
_WORD = re.compile(r"[0-9a-z가-힣]+")


class TicketError(WriteRejected):
    """입력 오류. code는 schema_invalid 또는 not_found."""


def _text(s, name: str) -> str:
    if not isinstance(s, str) or not s.strip():
        raise TicketError("schema_invalid", f"{name} 필수")
    t = unicodedata.normalize("NFC", " ".join(s.split()))
    if len(t) > MAX_TEXT:
        raise TicketError("schema_invalid", f"{name}는 {MAX_TEXT}자 이하")
    return t


def _priority(p) -> int:
    if p is None or p == "":
        return PRIORITY["normal"]
    if isinstance(p, bool):
        raise TicketError("schema_invalid", "priority 형식 오류")
    if isinstance(p, int):
        return p
    if isinstance(p, str) and p.lower() in PRIORITY:
        return PRIORITY[p.lower()]
    if isinstance(p, str) and p.strip().lstrip("-").isdigit():
        return int(p)
    raise TicketError("schema_invalid", f"priority는 정수 또는 low, normal, high: {p!r}")


def clean_url(u) -> str:
    """http(s)만, 사용자 정보와 조각을 지운다. 질의 문자열은 보존한다."""
    if not isinstance(u, str) or not u.strip() or len(u) > MAX_URL:
        raise TicketError("schema_invalid", "url 형식 오류")
    sp = urlsplit(u.strip())
    if sp.scheme not in ("http", "https") or not sp.hostname:
        raise TicketError("schema_invalid", "url은 http(s)만")
    host = sp.hostname if ":" not in sp.hostname else f"[{sp.hostname}]"
    netloc = host + (f":{sp.port}" if sp.port else "")
    return urlunsplit((sp.scheme, netloc, sp.path, sp.query, ""))


# ------------------------------------------------------------------ 병합 판정

def norm_topic(s: str) -> str:
    return " ".join(_WORD.findall(unicodedata.normalize("NFC", s).lower()))


def bigrams(s: str) -> set:
    t = norm_topic(s).replace(" ", "")
    if len(t) < 2:
        return {t} if t else set()
    return {t[i:i + 2] for i in range(len(t) - 1)}


def jaccard(a: str, b: str) -> float:
    x, y = bigrams(a), bigrams(b)
    if not x and not y:
        return 1.0
    return len(x & y) / len(x | y)


def entity_set(s: str) -> frozenset:
    """주제에 든 별칭 그룹의 대표 키 집합. 별칭 표(schemas/aliases)의 창 1~3단어를 본다."""
    from kb.read import aliases
    tbl = aliases.table()
    words = norm_topic(s).split()
    out = set()
    i = 0
    while i < len(words):
        hit = 0
        for n in range(min(aliases.MAX_WINDOW, len(words) - i), 0, -1):
            k = aliases.key(" ".join(words[i:i + n]))
            if k in tbl:
                out.add(min([k, *(aliases.key(a) for a in tbl[k])]))
                hit = n
                break
        i += hit or 1
    return frozenset(out)


def same_request(a: str, b: str) -> bool:
    return jaccard(a, b) >= JACCARD_MIN and entity_set(a) == entity_set(b)


# ------------------------------------------------------------------ 읽기

def _open_rows() -> list[dict]:
    """열린 티켓(queued, in_progress)의 id, topic, status, urls. gold가 아직 없으면 빈 목록."""
    from kb import read
    from kb.read.ctx import rows, visibility_sql
    from kb.read.nodes import _json
    ctx = read.ReadCtx.build(max_sensitivity="internal", types="Ticket")
    try:
        with read.reading(ctx) as con:
            w, p = visibility_sql(ctx, "n")
            out = []
            for r in rows(con, f"SELECT n.id, n.label, n.props FROM node n WHERE {w} ORDER BY n.id", p):
                pr = _json(r["props"])
                if (pr.get("status") or "queued") in OPEN:
                    out.append({"id": r["id"], "topic": r["label"], "status": pr.get("status") or "queued",
                                "urls": list(pr.get("urls") or [])})
            return out
    except read.NotReady:
        return []


def list_tickets(status: str | None = None, cursor: str | None = None, limit=None) -> dict:
    """{items:[{id,topic,status,priority,opened_at,closed_at}], next_cursor}. 읽기 코어 그대로(id 오름차순)."""
    from kb import read
    from kb.read.envelope import read as read_env
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    env = read_env(ctx, read.tickets, status=status, cursor=cursor, limit=limit)
    return {"items": env["data"]["items"], "next_cursor": (env.get("page") or {}).get("next_cursor")}


# ------------------------------------------------------------------ 쓰기

def _ev(kind: str, tid: str, actor: str, key: str, payload: dict, on_behalf_of) -> dict:
    return {"kind": kind, "actor": actor, "origin": "system", "subject": tid, "idem_key": key, "payload": payload,
            "on_behalf_of": on_behalf_of}


def open_ticket(topic: str, reason: str, priority=None, url: str | None = None, *, transport: str = "mcp",
                session: str | None = None) -> dict:
    """티켓을 열거나 열린 티켓에 합친다. 반환 {ticket, status, duplicates}.
    duplicates는 이번 요청이 합쳐진 기존 티켓 수(새 티켓이면 0, 합쳤으면 1)다."""
    from kb.write import commit
    topic, reason, pri = _text(topic, "topic"), _text(reason, "reason"), _priority(priority)
    u = clean_url(url) if url else None
    au = _author.resolve(transport, session)
    hit = next((t for t in _open_rows() if same_request(topic, t["topic"])), None)
    if hit is None:
        tid = ids.ticket_id()
        p = {"id": tid, "topic": topic, "reason": reason, "priority": pri, "requester": au.actor}
        if u:
            p["urls"] = [u]
        commit([_ev("ticket.open", tid, au.actor, f"ticket.open:{tid}", p, au.on_behalf_of)], au.actor)
        return {"ticket": tid, "status": "queued", "duplicates": 0}
    urls = list(hit["urls"])
    if u and u not in urls and len(urls) < MAX_URLS:
        urls.append(u)
    if urls != hit["urls"]:
        h = hashlib.sha256("\n".join([hit["id"], hit["status"], *urls]).encode()).hexdigest()[:20]
        commit([_ev("ticket.update", hit["id"], au.actor, f"ticket.update:{h}",
                    {"id": hit["id"], "status": hit["status"], "urls": urls}, au.on_behalf_of)], au.actor)
    return {"ticket": hit["id"], "status": hit["status"], "duplicates": 1}


def close_ticket(tid: str, status: str, note: str | None = None, *, transport: str = "mcp",
                 session: str | None = None) -> dict:
    from kb import read
    from kb.read.envelope import read as read_env
    from kb.write import commit
    if status not in CLOSING:
        raise TicketError("schema_invalid", f"status는 {', '.join(CLOSING)} 중 하나")
    try:
        ids.check_public_id(tid)
    except ValueError as e:
        raise TicketError("schema_invalid", str(e)) from e
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    try:
        cur = read_env(ctx, read.get_ticket, tid)["data"]
    except read.NotFound:
        raise TicketError("not_found", f"없는 티켓: {tid}") from None
    au = _author.resolve(transport, session)
    p = {"id": tid, "status": status}
    if note:
        p["note"] = _text(note, "note")
    h = hashlib.sha256(f"{tid}\n{status}\n{note or ''}".encode()).hexdigest()[:20]
    commit([_ev("ticket.close", tid, au.actor, f"ticket.close:{h}", p, au.on_behalf_of)], au.actor)
    return {"ticket": tid, "status": status, "was": cur["status"]}
