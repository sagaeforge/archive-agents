"""gold 읽기 도우미. 판정 코드가 gold를 읽는 곳은 여기뿐이다."""
from __future__ import annotations

import json
import re


def open_gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    p = current_gold_path()
    return connect_ro(p) if p else None


def _js(b):
    if not b:
        return {}
    try:
        return json.loads(b if isinstance(b, str) else bytes(b).decode("utf-8"))
    except (ValueError, TypeError):
        return {}


def node(con, nid: str) -> dict | None:
    if con is None:
        return None
    r = con.execute("SELECT id, type, label, liveness, status, eff_status, props, recorded_at, version FROM node "
                    "WHERE id=? AND expired_at IS NULL", (nid,)).fetchone()
    if not r:
        return None
    return {"id": r[0], "type": r[1], "label": r[2], "liveness": r[3], "status": r[4], "eff_status": r[5],
            "props": _js(r[6]), "recorded_at": r[7], "version": r[8]}


def g_nodes(con, types) -> list:
    """생존 판정 대상(G 단위 타입) 노드 목록."""
    if con is None:
        return []
    q = ",".join("?" * len(types))
    rows = con.execute(f"SELECT id, type, label, liveness, props, recorded_at FROM node WHERE expired_at IS NULL AND status='active' "
                       f"AND lower(type) IN ({q}) ORDER BY id", [t.lower() for t in types]).fetchall()
    return [{"id": r[0], "type": r[1].lower(), "label": r[2], "liveness": r[3], "props": _js(r[4]), "recorded_at": r[5]} for r in rows]


def snapshot_source(con, sid: str) -> dict | None:
    """스냅샷 노드의 source, url, 소스 trust."""
    n = node(con, sid)
    if not n or n["type"] != "Snapshot":
        return None
    p = n["props"]
    src = node(con, p.get("source") or "")
    return {"id": sid, "url": p.get("url"), "source": p.get("source"), "trust": (src["props"].get("trust") if src else None) or "unknown",
            "raw_sha": p.get("raw_sha")}


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s or "x"
