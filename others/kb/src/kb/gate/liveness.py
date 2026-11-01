"""9단계 생존 입장. G 단위 주어의 liveness가 없으면(kind=event 주장은 호출 쪽이 뺀다) 보류(R_LIVENESS_UNKNOWN)하고 queue(kind=live)에 넣는다.
TTL이 지났으면 같은 큐에만 넣는다. 저장값을 주장에 복사하지 않는다(eff_status가 반영한다)."""
from __future__ import annotations

import time

from kb.gate.model import G_ONLY_TYPES, G_UNIT_TYPES

CODE = "R_LIVENESS_UNKNOWN"
QUEUE_KIND = "live"
TTL_DAYS = 30


def type_of(subject: str, node_type: str | None = None) -> str:
    """e:<type>:<slug>에서 타입을 읽는다. 노드가 있으면 노드 타입이 우선이다."""
    if node_type:
        return node_type.lower()
    p = subject.split(":", 2)
    return p[1].lower() if len(p) == 3 and p[0] == "e" else ""


def is_g_unit(type_: str, domains) -> bool:
    d = set(domains or ())
    t = (type_ or "").lower()
    if t not in G_UNIT_TYPES:
        return False
    return "G" in d if d else t in G_ONLY_TYPES


def _gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    p = current_gold_path()
    return connect_ro(p) if p else None


def lookup(con, subject: str) -> dict:
    """gold에서 주어의 type, liveness, recorded_at, domains. 없으면 빈 dict."""
    if con is None:
        return {}
    r = con.execute("SELECT type, liveness, recorded_at FROM node WHERE id=? AND expired_at IS NULL", (subject,)).fetchone()
    if not r:
        return {}
    doms = [x[0] for x in con.execute("SELECT domain FROM node_domain WHERE node_id=?", (subject,))]
    return {"type": r[0], "liveness": r[1], "recorded_at": r[2], "domains": doms}


def liveness_stance(subject: str, *, con=None, domains=None, node_type: str | None = None, now_ms: int | None = None,
                    ttl_days: int | None = None, enqueue: bool = True) -> str | None:
    """보류 코드(R_LIVENESS_UNKNOWN) 또는 None. G 단위가 아니면 None. 큐 적재는 enqueue=False로 끈다(검증 전용)."""
    own = con is None
    if own:
        con = _gold()
    try:
        info = lookup(con, subject)
    finally:
        if own and con is not None:
            con.close()
    t = type_of(subject, info.get("type") or node_type)
    doms = info.get("domains") or domains or []
    if not is_g_unit(t, doms):
        return None
    now = now_ms or int(time.time() * 1000)
    ttl_ms = (TTL_DAYS if ttl_days is None else ttl_days) * 86400_000
    live = info.get("liveness")
    if live and now - int(info.get("recorded_at") or 0) <= ttl_ms:
        return None
    if enqueue:
        from kb.core import opsdb
        opsdb.queue_put(QUEUE_KIND, subject, domain="G", priority=1)
    return CODE if not live else None
