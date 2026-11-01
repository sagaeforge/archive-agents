"""기록이 이미 있는지 읽기 전용으로 본다(멱등 판정). 원장은 ro 연결로만 열고 없으면 만들지 않는다.

기록 머리는 두 곳에 있다: 원장(first_party가 열린 뒤)과 spool/fp-held, spool/in(열리기 전이나 게이트 시간 초과).
내용이 같은가는 payload 전체가 아니라 props.content_sha(제목과 본문의 해시)로 본다. 원본의 수정 시각만 바뀐 경우에
새 버전을 만들지 않기 위해서다.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Iterable

from kb.core import ledger, spool
from kb.core.conn import connect_ro

KEY_PREFIX = "harvest:"


@dataclass
class Known:
    version: int = 0               # 원장 머리 버전(없으면 0)
    sha: str | None = None         # 원장 머리의 content_sha
    live: bool = True              # False: 머리가 tombstone 또는 redact. 수확이 되살리지 않는다
    held: int = 0                  # 보관 중인 harvest 이벤트 수
    held_sha: str | None = None    # 가장 늦게 쓴 보관 이벤트의 content_sha


@dataclass
class Snapshot:
    fp_open: bool = False
    known: dict[str, Known] = field(default_factory=dict)


def _ledger_part(rids: list[str], out: dict[str, Known]) -> bool:
    p = ledger.ledger_path()
    if not p.exists():
        return False
    c = connect_ro(p, 30.0)
    try:
        try:
            fp_open = ledger.meta_get(c, "fp_open") is not None
            for rid in rids:
                head = ledger.record_head(c, rid)
                if head is None:
                    continue
                version, content_sha = head
                kind = c.execute("SELECT kind FROM event WHERE subject=? AND kind IN ('record.put','record.tombstone',"
                                 "'record.redact') ORDER BY seq DESC LIMIT 1", (rid,)).fetchone()
                k = out.setdefault(rid, Known())
                k.version = version
                if not kind or kind[0] != "record.put":
                    k.live = False
                    continue
                payload = ledger.get_payload(c, content_sha)
                if payload is None:        # 본문을 지운(redact) 기록
                    k.live = False
                    continue
                k.sha = ((payload.get("props") or {}).get("content_sha"))
            return fp_open
        except sqlite3.DatabaseError:
            return False
    finally:
        c.close()


def _held_part(wanted: set[str], out: dict[str, Known]) -> None:
    best: dict[str, int] = {}
    for kind in ("fp-held", "in"):
        d = spool.dir_of(kind)
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                obj = json.loads(f.read_bytes())
            except (OSError, ValueError, RecursionError):
                continue
            if not isinstance(obj, dict):
                continue
            ns = obj.get("queued_ns") if isinstance(obj.get("queued_ns"), int) else 0
            for e in obj.get("events") or []:
                if not isinstance(e, dict) or e.get("kind") != "record.put":
                    continue
                if not str(e.get("idem_key", "")).startswith(KEY_PREFIX) or e.get("subject") not in wanted:
                    continue
                rid = e["subject"]
                k = out.setdefault(rid, Known())
                k.held += 1
                if ns >= best.get(rid, -1):
                    best[rid] = ns
                    k.held_sha = (((e.get("payload") or {}).get("props") or {}).get("content_sha"))


def lookup(rids: Iterable[str]) -> Snapshot:
    """rids의 현재 상태. 원장이나 스풀이 없으면 모두 새 기록이다."""
    rids = list(dict.fromkeys(rids))
    snap = Snapshot()
    snap.fp_open = _ledger_part(rids, snap.known)
    _held_part(set(rids), snap.known)
    return snap
