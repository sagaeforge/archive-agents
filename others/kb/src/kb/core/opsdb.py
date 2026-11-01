"""운영 DB(ops.db, ADR 7.11). WAL, NORMAL. 잃어도 지식 손실이 없다.
user_version이 코드와 다르거나 DB로 열리지 않으면(손상) 옮겨 두고 재생성한다.
잠금 대기, 파일 기술자 고갈, 디스크 오류 같은 일시 오류는 호출자에게 올린다."""
from __future__ import annotations

import functools
import json
import os
import sqlite3
import time
from pathlib import Path

from kb.core import conn as _conn
from kb.core import paths
from kb.core.gatelock import Gate

USER_VERSION = 2
OPEN_WAIT_S = 30.0
LEASE_MS = 3_600_000  # queue_take 임대 기본값. 이 안에 queue_done이 없으면 다시 꺼낼 수 있다
_DAMAGED = (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB)

DDL = (
    """CREATE TABLE source_state(source_id TEXT PRIMARY KEY, next_check_at INT, last_ok_at INT, fail_count INT NOT NULL DEFAULT 0,
  state TEXT NOT NULL, etag TEXT, last_modified TEXT, last_sha TEXT, shape TEXT)""",
    """CREATE TABLE url_state(source_id TEXT NOT NULL, url TEXT NOT NULL, next_check_at INT, last_ok_at INT, fail_count INT NOT NULL DEFAULT 0,
  state TEXT NOT NULL, etag TEXT, last_modified TEXT, last_sha TEXT, discovered_from TEXT, PRIMARY KEY(source_id, url))""",
    "CREATE TABLE robots_cache(host TEXT PRIMARY KEY, fetched_at INT NOT NULL, status INT, body TEXT)",
    """CREATE TABLE fetch_log(id INTEGER PRIMARY KEY, at INT NOT NULL, source_id TEXT, host TEXT NOT NULL, url TEXT NOT NULL,
  status INT, outcome TEXT NOT NULL, bytes INT, ms INT)""",
    """CREATE TABLE circuit(host TEXT PRIMARY KEY, state TEXT NOT NULL, opened_at INT, until_at INT, reason TEXT, trips INT NOT NULL DEFAULT 0)""",
    """CREATE TABLE queue(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, domain TEXT, priority INT NOT NULL DEFAULT 0,
  enqueued_at INT NOT NULL, next_at INT, attempts INT NOT NULL DEFAULT 0, state TEXT NOT NULL, UNIQUE(kind, ref))""",
    """CREATE TABLE candidate(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, first_seen INT NOT NULL,
  seen INT NOT NULL DEFAULT 1, UNIQUE(kind, value))""",
    """CREATE TABLE review(id INTEGER PRIMARY KEY, target TEXT NOT NULL, unit TEXT, question TEXT NOT NULL, signals TEXT, proposed TEXT,
  state TEXT NOT NULL, opened_at INT NOT NULL, closed_at INT, decided_by TEXT)""",
    """CREATE TABLE dlq(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, stage TEXT NOT NULL, error TEXT,
  attempts INT NOT NULL DEFAULT 0, next_at INT, payload_sha TEXT)""",
    "CREATE TABLE run(id INTEGER PRIMARY KEY, job TEXT NOT NULL, started_at INT NOT NULL, ended_at INT, outcome TEXT, detail TEXT)",
    "CREATE TABLE tick_state(k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    "CREATE TABLE metric(at INT NOT NULL, name TEXT NOT NULL, dims TEXT, value REAL NOT NULL)",
    """CREATE TABLE incident(id INTEGER PRIMARY KEY, at INT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, path TEXT, run_id INT,
  acked_at INT, ack_note TEXT)""",
    "CREATE TABLE query_log(at INT NOT NULL, tool TEXT NOT NULL, cards INT, tokens INT, ms INT, route TEXT, zero INT)",
    "CREATE TABLE drill(id INTEGER PRIMARY KEY, at INT NOT NULL, kind TEXT NOT NULL, target TEXT, ok INT NOT NULL, detail TEXT)",
    "CREATE TABLE boot_test(id INTEGER PRIMARY KEY, at INT NOT NULL, step INT NOT NULL, ok INT NOT NULL, note TEXT)",
)


def ops_path() -> Path:
    return paths.ops_dir() / "ops.db"


def _now() -> int:
    return int(time.time() * 1000)


def _create(p: Path) -> sqlite3.Connection:
    c = _conn.connect_rw(p, "NORMAL")
    try:
        c.execute("BEGIN IMMEDIATE")
        for d in DDL:
            c.execute(d)
        c.execute(f"PRAGMA user_version={USER_VERSION}")
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        c.close()
        raise
    return c


def _move_aside(p: Path) -> Path:
    """손상된 ops.db를 옆 이름으로 옮긴다. 호출자가 여는 잠금을 쥐고 있다.
    링크를 먼저 걸고 원래 이름을 지운다. 앞서 옮겨 둔 사본을 덮어쓰지 않는다."""
    suffixes = ("", "-wal", "-shm")
    stamp = _now()
    while any(Path(f"{p}.old-{stamp}{suf}").exists() for suf in suffixes):
        stamp += 1  # 같은 초에 다시 옮기거나 앞선 시도가 중간에 죽은 경우
    dst = p.with_name(f"{p.name}.old-{stamp}")
    for suf in suffixes:
        s = Path(str(p) + suf)
        if s.exists():
            os.link(s, Path(str(dst) + suf))
            s.unlink()
    return dst


def _open(p: Path) -> sqlite3.Connection:
    if p.exists():
        c = None
        try:
            c = _conn.connect_rw(p, "NORMAL")
            ver = c.execute("PRAGMA user_version").fetchone()[0]
            names = {r[0] for r in c.execute("SELECT name FROM sqlite_master")}
            if ver == USER_VERSION and "run" in names:
                return c
            c.close()
            if ver == 0 and not names:  # 생성 도중 죽은 빈 파일
                return _create(p)
        except sqlite3.DatabaseError as e:
            if c is not None:
                c.close()
            if (getattr(e, "sqlite_errorcode", 0) or 0) & 0xff not in _DAMAGED:
                raise  # 일시 오류는 손상이 아니다. 옮기면 미확인 사고 기록을 잃는다
        _move_aside(p)
    return _create(p)


def connect() -> sqlite3.Connection:
    """ops.db 연결. 버전이 다르거나 손상됐으면 옮겨 두고 새로 만든다.
    여는 단계(WAL 전환, 생성, 옮기기)는 파일 잠금으로 직렬화한다. 첫 기동이 겹쳐도 경합하지 않는다."""
    p = ops_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    gate = Gate(p.with_name(p.name + ".lock"))
    fd = gate.acquire(OPEN_WAIT_S)
    try:
        return _open(p)
    finally:
        gate.release(fd)


def _with_conn(fn):
    """첫 인수가 연결이 아니면 연결을 열어 쓰고 닫는다."""
    @functools.wraps(fn)
    def w(*a, **kw):
        if a and isinstance(a[0], sqlite3.Connection):
            return fn(*a, **kw)
        c = connect()
        try:
            return fn(c, *a, **kw)
        finally:
            c.close()
    return w


@_with_conn
def record_run(c, job: str, started_at: int | None = None, *, run_id: int | None = None,
               ended_at: int | None = None, outcome: str | None = None, detail=None) -> int:
    """run_id가 없으면 새 행을 열고, 있으면 그 행을 마감한다."""
    d = detail if detail is None or isinstance(detail, str) else json.dumps(detail, ensure_ascii=False, sort_keys=True)
    if run_id is None:
        cur = c.execute("INSERT INTO run(job, started_at, ended_at, outcome, detail) VALUES(?,?,?,?,?)",
                        (job, started_at or _now(), ended_at, outcome, d))
        return cur.lastrowid
    c.execute("UPDATE run SET ended_at=?, outcome=?, detail=coalesce(?, detail) WHERE id=?",
              (ended_at or _now(), outcome, d, run_id))
    return run_id


@_with_conn
def record_incident(c, kind: str, detail: str, path: str | None = None, run_id: int | None = None) -> int:
    cur = c.execute("INSERT INTO incident(at, kind, detail, path, run_id) VALUES(?,?,?,?,?)",
                    (_now(), kind, detail, path, run_id))
    return cur.lastrowid


@_with_conn
def ack_incident(c, incident_id: int, note: str) -> bool:
    cur = c.execute("UPDATE incident SET acked_at=?, ack_note=? WHERE id=? AND acked_at IS NULL",
                    (_now(), note, incident_id))
    return cur.rowcount == 1


@_with_conn
def record_metric(c, name: str, value: float, dims: dict | str | None = None, at: int | None = None) -> None:
    d = dims if dims is None or isinstance(dims, str) else json.dumps(dims, ensure_ascii=False, sort_keys=True)
    c.execute("INSERT INTO metric(at, name, dims, value) VALUES(?,?,?,?)", (at or _now(), name, d, float(value)))


@_with_conn
def queue_put(c, kind: str, ref: str, *, domain: str | None = None, priority: int = 0,
              next_at: int | None = None) -> bool:
    """(kind, ref)가 이미 있으면 넣지 않는다. 새로 넣었으면 True."""
    cur = c.execute("INSERT OR IGNORE INTO queue(kind, ref, domain, priority, enqueued_at, next_at, state) "
                    "VALUES(?,?,?,?,?,?,'queued')", (kind, ref, domain, priority, _now(), next_at))
    return cur.rowcount == 1


@_with_conn
def queue_take(c, kind: str, n: int, *, lease_ms: int = LEASE_MS) -> list[dict]:
    """만기된 항목 n개를 꺼내 state='taken'으로 표시한다. 도메인을 순환하고 도메인 안에서는 우선순위, 오래된 순.
    taken 행의 next_at은 임대 기한이다. 작업자가 죽어 queue_done이 없으면 기한 뒤 다시 꺼낼 수 있다(attempts 증가).
    처리는 멱등이어야 하고, 임대를 넘긴 작업자의 queue_done도 안전해야 한다."""
    now = _now()
    c.execute("BEGIN IMMEDIATE")
    try:
        rows = c.execute("SELECT id, kind, ref, domain, priority, attempts FROM queue "
                         "WHERE kind=? AND state IN ('queued','taken') AND (next_at IS NULL OR next_at<=?) "
                         "ORDER BY priority DESC, enqueued_at, id", (kind, now)).fetchall()
        buckets: dict[str, list] = {}
        for r in rows:
            buckets.setdefault(r[3] or "", []).append(r)
        picked: list = []
        keys = list(buckets)
        while len(picked) < n and any(buckets[k] for k in keys):
            for k in keys:
                if buckets[k] and len(picked) < n:
                    picked.append(buckets[k].pop(0))
        for r in picked:
            c.execute("UPDATE queue SET state='taken', attempts=attempts+1, next_at=? WHERE id=?", (now + lease_ms, r[0]))
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    return [{"id": r[0], "kind": r[1], "ref": r[2], "domain": r[3] or None, "priority": r[4],
             "attempts": r[5] + 1} for r in picked]


@_with_conn
def queue_done(c, kind: str, ref: str, *, requeue_at: int | None = None) -> None:
    """처리 끝. requeue_at이 있으면 그 시각에 다시 만기가 되게 되돌린다. 없으면 행을 지운다."""
    if requeue_at is None:
        c.execute("DELETE FROM queue WHERE kind=? AND ref=?", (kind, ref))
    else:
        c.execute("UPDATE queue SET state='queued', next_at=? WHERE kind=? AND ref=?", (requeue_at, kind, ref))


@_with_conn
def queue_reclaim(c, kind: str | None = None) -> int:
    """taken 항목을 임대 기한과 무관하게 되돌린다. 작업자가 없음을 아는 호출자(복구 단계)가 쓴다."""
    cur = c.execute("UPDATE queue SET state='queued', next_at=NULL WHERE state='taken' AND (? IS NULL OR kind=?)",
                    (kind, kind))
    return cur.rowcount


@_with_conn
def tick_state_set(c, k: str, v) -> None:
    c.execute("INSERT INTO tick_state(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


@_with_conn
def tick_state_get(c, k: str, default: str | None = None) -> str | None:
    r = c.execute("SELECT v FROM tick_state WHERE k=?", (k,)).fetchone()
    return r[0] if r else default
