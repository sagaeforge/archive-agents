"""색인 대상 단위와 본문 선택(표준 라이브러리). gold의 현재 span 중 공개 범위(sensitivity <= 1, internal 이하)만 뽑는다.
secret, private은 벡터로 만들지 않는다(ADR 14.2). 키는 공개 ID다(검색 항목 id와 같은 식).

임베딩과 재순위에 쓰는 본문: 주장은 statement, 엔티티는 label, 기록은 label + 본문, 문단은 스냅샷 표시 본문의 [start_cp:end_cp]다.
gold의 content 표에는 기록 본문만 있다(주장과 문단 본문은 별도 위치)."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass

from kb.core import cas
from kb.rank import conf

MAX_SENS = 1
TEXT_CAP = 2000

KEY = "CASE WHEN s.ref_kind='document' THEN s.snapshot_id||':'||s.start_cp ELSE s.ref_id END"
_NODE = "SELECT n.{x} FROM node n WHERE n.id=s.ref_id ORDER BY n.version DESC LIMIT 1"
SELECT = f"""SELECT {KEY} AS id, s.ref_kind AS rk, s.snapshot_id AS sn, s.start_cp AS a, s.end_cp AS b,
  CASE s.ref_kind
    WHEN 'claim' THEN (SELECT c.statement FROM claim c JOIN node n ON n.vid=c.vid WHERE n.id=s.ref_id ORDER BY n.version DESC LIMIT 1)
    WHEN 'record' THEN (SELECT n.label||COALESCE(char(10)||(SELECT x.body FROM content x WHERE x.sha=n.content_sha),'')
                        FROM node n WHERE n.id=s.ref_id ORDER BY n.version DESC LIMIT 1)
    WHEN 'node' THEN ({_NODE.format(x='label')})
    ELSE NULL END AS txt
FROM span s"""

PUBLIC_WHERE = f"""s.rec_to IS NULL AND s.eff_status='active' AND s.sensitivity <= {MAX_SENS}
  AND COALESCE((SELECT h.sensitivity FROM head h WHERE h.id=s.ref_id), s.sensitivity) <= {MAX_SENS}
  AND (s.ref_kind<>'claim' OR COALESCE((SELECT h2.sensitivity FROM head h2 WHERE h2.id=s.subject),0) <= {MAX_SENS})"""


@dataclass(frozen=True)
class Unit:
    id: str
    kind: str     # c r e p
    sha: str      # 본문 sha256. 같으면 벡터를 재사용한다
    text: str


def _snapshot_text(con, sn: str, cache: dict) -> str:
    if sn not in cache:
        text = ""
        r = con.execute("SELECT props FROM node WHERE id=? ORDER BY version DESC LIMIT 1", (sn,)).fetchone()
        if r and r[0]:
            try:
                sha = json.loads(r[0]).get("text_sha")
                text = cas.get(sha).decode("utf-8") if sha else ""
            except (ValueError, TypeError, cas.CasError, OSError):
                text = ""
        cache[sn] = text
    return cache[sn]


def _fill(con, rows) -> list[tuple[str, str, str]]:
    """(id, 종류 글자, 본문). 본문이 없는 행은 뺀다. 같은 id는 첫 행만."""
    cache: dict = {}
    seen: set[str] = set()
    out = []
    for id_, rk, sn, a, b, txt in rows:
        k = conf.KIND_LETTER.get(rk)
        if k is None or id_ in seen:
            continue
        if rk == "document":
            txt = _snapshot_text(con, sn, cache)[a:b] if sn and a is not None and b is not None else ""
        if not txt or not str(txt).strip():
            continue
        seen.add(id_)
        out.append((id_, k, str(txt)))
    return out


def select_units(con: sqlite3.Connection) -> list[Unit]:
    rows = con.execute(f"{SELECT} WHERE {PUBLIC_WHERE} ORDER BY s.sid")
    return [Unit(i, k, hashlib.sha256(t.encode("utf-8")).hexdigest(), t[:TEXT_CAP]) for i, k, t in _fill(con, rows)]


def texts_for(con: sqlite3.Connection, ids: list[str]) -> dict[str, str]:
    """재순위용 본문. 필터는 호출자가 이미 걸었다(공개 ID 목록)."""
    if not ids:
        return {}
    rows = con.execute(f"{SELECT} WHERE {KEY} IN (SELECT value FROM json_each(?)) ORDER BY s.sid DESC", (json.dumps(ids),))
    return {i: t for i, _k, t in _fill(con, rows)}


def open_gold_ro(path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = None
    return con
