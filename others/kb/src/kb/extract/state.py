"""ops.db의 기존 tick_state, metric, incident 표만 쓴다(새 표 없음). 값은 JSON 문자열이다."""
from __future__ import annotations

import json
from contextlib import contextmanager

from kb.core import opsdb


_RO = [False]


@contextmanager
def readonly():
    """kb status용: ops.db를 읽기 전용으로 연다. 파일이 없으면 만들지 않고 빈 값으로 읽는다."""
    _RO[0] = True
    try:
        yield
    finally:
        _RO[0] = False


def get(k: str, default=None):
    if _RO[0]:
        from kb.core import conn as _conn
        p = opsdb.ops_path()
        if not p.exists():
            return default
        try:
            c = _conn.connect_ro(p, 2.0)
        except Exception:  # noqa: BLE001
            return default
        try:
            r = c.execute("SELECT v FROM tick_state WHERE k=?", (k,)).fetchone()
        except Exception:  # noqa: BLE001
            r = None
        finally:
            c.close()
        v = r[0] if r else None
    else:
        c = opsdb.connect()
        try:
            v = opsdb.tick_state_get(c, k, None)
        finally:
            c.close()
    if v is None:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return default


def put(k: str, v) -> None:
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, k, json.dumps(v, ensure_ascii=False, sort_keys=True))
    finally:
        c.close()


def delete(k: str) -> None:
    c = opsdb.connect()
    try:
        c.execute("DELETE FROM tick_state WHERE k=?", (k,))
    finally:
        c.close()


def keys(prefix: str) -> list:
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT k FROM tick_state WHERE k LIKE ? ESCAPE '\\'",
                                        (prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%",))]
    finally:
        c.close()


def metric(name: str, value: float, dims: dict | None = None, at: int | None = None) -> None:
    c = opsdb.connect()
    try:
        opsdb.record_metric(c, name, value, dims, at)
    finally:
        c.close()


def metrics(name: str, since_ms: int = 0) -> list:
    c = opsdb.connect()
    try:
        return [(r[0], json.loads(r[1]) if r[1] else {}, r[2]) for r in
                c.execute("SELECT at, dims, value FROM metric WHERE name=? AND at>=? ORDER BY at", (name, since_ms))]
    finally:
        c.close()


def incident(kind: str, detail: str, path: str | None = None) -> int:
    c = opsdb.connect()
    try:
        return opsdb.record_incident(c, kind, detail, path)
    finally:
        c.close()
