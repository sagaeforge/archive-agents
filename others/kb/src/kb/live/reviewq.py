"""사람 판단 대기열(H01~H11). ops.db의 review 표를 쓴다. 에이전트 제안은 proposed에 후보로만 남고 상태를 확정하지 않는다.
상한 30(ADR 13장): 넘으면 오래된 stale_suspect부터, 그 다음 오래된 순으로 'demoted'로 내린다. 판정 상태는 그대로다."""
from __future__ import annotations

import json
import time

from kb.core import opsdb
from kb.live.model import REVIEW_CAP, Item

OPEN = "open"


def _now() -> int:
    return int(time.time() * 1000)


def _conn(c=None):
    return c if c is not None else opsdb.connect()


def open_item(target: str, unit: str, item: Item, signals: list, *, c=None, now: int | None = None) -> int:
    """같은 (target, question)이 열려 있으면 근거를 갱신한다. 새로 열면 상한을 맞춘다. 항목 id를 돌려준다."""
    own = c is None
    c = _conn(c)
    try:
        now = now or _now()
        sig = json.dumps([s.event() if hasattr(s, "event") else s for s in signals], ensure_ascii=False, sort_keys=True)
        prop = json.dumps({"liveness": item.proposed, "successor": item.successor, "by": "rules"}, ensure_ascii=False, sort_keys=True)
        q = f"{item.question}:{item.text}"[:400]
        r = c.execute("SELECT id FROM review WHERE target=? AND state=? AND question LIKE ?", (target, OPEN, item.question + ":%")).fetchone()
        if r:
            c.execute("UPDATE review SET question=?, signals=?, proposed=?, unit=? WHERE id=?", (q, sig, prop, unit, r[0]))
            return r[0]
        cur = c.execute("INSERT INTO review(target, unit, question, signals, proposed, state, opened_at) VALUES(?,?,?,?,?,?,?)",
                        (target, unit, q, sig, prop, OPEN, now))
        rid = cur.lastrowid
        enforce_cap(c=c, now=now)
        return rid
    finally:
        if own:
            c.close()


def enforce_cap(cap: int = REVIEW_CAP, *, c=None, now: int | None = None) -> list:
    """열린 항목이 cap을 넘으면 오래된 stale_suspect부터 내린다(state='demoted'). 내린 id 목록."""
    own = c is None
    c = _conn(c)
    try:
        demoted = []
        while True:
            n = c.execute("SELECT count(*) FROM review WHERE state=?", (OPEN,)).fetchone()[0]
            if n <= cap:
                return demoted
            row = c.execute("SELECT id FROM review WHERE state=? AND (question LIKE 'H04:%' OR question LIKE 'H02:%' "
                            "OR proposed LIKE '%stale_suspect%') ORDER BY opened_at, id LIMIT 1", (OPEN,)).fetchone()
            if not row:
                row = c.execute("SELECT id FROM review WHERE state=? ORDER BY opened_at, id LIMIT 1", (OPEN,)).fetchone()
            c.execute("UPDATE review SET state='demoted', closed_at=?, decided_by='cap' WHERE id=?", (now or _now(), row[0]))
            demoted.append(row[0])
    finally:
        if own:
            c.close()


def list_open(limit: int | None = None, *, c=None) -> list:
    own = c is None
    c = _conn(c)
    try:
        rows = c.execute("SELECT id, target, unit, question, signals, proposed, opened_at FROM review WHERE state=? "
                         "ORDER BY opened_at, id" + (f" LIMIT {int(limit)}" if limit else ""), (OPEN,)).fetchall()
        return [{"id": r[0], "target": r[1], "unit": r[2], "question": r[3], "signals": json.loads(r[4] or "[]"),
                 "proposed": json.loads(r[5] or "{}"), "opened_at": r[6]} for r in rows]
    finally:
        if own:
            c.close()


def get(rid: int, *, c=None) -> dict | None:
    for it in list_open(c=c):
        if it["id"] == rid:
            return it
    return None


def close(rid: int, state: str, decided_by: str, *, c=None) -> bool:
    own = c is None
    c = _conn(c)
    try:
        cur = c.execute("UPDATE review SET state=?, closed_at=?, decided_by=? WHERE id=? AND state=?", (state, _now(), decided_by, rid, OPEN))
        return cur.rowcount == 1
    finally:
        if own:
            c.close()


def propose(rid: int, liveness: str, by: str, *, successor: str | None = None, c=None) -> bool:
    """에이전트 제안. 후보만 갱신하고 상태를 확정하지 않는다."""
    own = c is None
    c = _conn(c)
    try:
        cur = c.execute("UPDATE review SET proposed=? WHERE id=? AND state=?",
                        (json.dumps({"liveness": liveness, "successor": successor, "by": by}, ensure_ascii=False, sort_keys=True), rid, OPEN))
        return cur.rowcount == 1
    finally:
        if own:
            c.close()
