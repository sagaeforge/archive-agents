"""추가 전용 해시 체인 원장(ADR 7.1). 표준 라이브러리만 쓴다.

- 쓰기는 append(conn, events) 하나. BEGIN IMMEDIATE, synchronous=FULL 연결(conn.connect_rw)을 받는다.
- 체인은 event 전 열의 정규 인코딩이고 본문이 아니라 payload_sha를 묶는다. redact 뒤에도 유지된다.
- record_head, meta는 체인 밖 표다. verify_chain이 이벤트 재생으로 다시 계산해 대조한다.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from compression import zstd

from kb.core import cas, conn as _conn
from kb.core import paths, upcast
from kb.core.canon import canon_json, sha256_hex
from kb.core.gatelock import Gate
from kb.core.ids import uuid7

GENESIS = "0" * 64
LEDGER_SCHEMA = "1"
ORIGINS = ("external", "first_party", "system")
OPEN_WAIT_S = 10.0
SEAL_WAIT_S = 60.0
REDACTED_LINE = {"redacted": True}
REDACTED_LINE_SHA = sha256_hex(canon_json(REDACTED_LINE))

KINDS = (
    "record.put", "record.tombstone", "record.redact",
    "entity.put", "entity.alias", "entity.merge",
    "edge.put", "edge.expire",
    "claim.assert", "claim.confirm", "claim.supersede", "claim.withdraw", "claim.retract", "claim.review",
    "snapshot.captured", "snapshot.text",
    "series.define", "series.batch",
    "source.registered", "source.status", "gap.recorded",
    "survival.verdict",
    "extract.run", "extract.rejected",
    "ticket.open", "ticket.update", "ticket.close",
    "schema.type_defined", "schema.predicate_defined", "schema.epoch_bumped",
    "system.fp_opened", "system.projection_quarantined", "system.projection_released",
)
RECORD_KINDS = ("record.put", "record.tombstone", "record.redact")

EVENT_COLS = ("seq", "event_id", "v", "at", "actor", "on_behalf_of", "generated_by", "origin",
              "kind", "subject", "idem_key", "payload_sha", "prev_hash", "hash")

TABLES = (
    """CREATE TABLE event(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  v INT NOT NULL,
  at INT NOT NULL,
  actor TEXT NOT NULL,
  on_behalf_of TEXT, generated_by TEXT,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL, subject TEXT,
  idem_key TEXT NOT NULL UNIQUE,
  payload_sha TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)""",
    "CREATE TABLE payload(sha TEXT PRIMARY KEY, body BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE record_head(id TEXT PRIMARY KEY, version INT NOT NULL, content_sha TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID",
    "CREATE INDEX event_subject ON event(subject, seq)",
    "CREATE INDEX event_payload ON event(payload_sha)",
)
TRIGGERS = {
    "event_no_update": "CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'event는 추가 전용'); END",
    "event_no_delete": "CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'event는 추가 전용'); END",
    # INSERT OR REPLACE는 DELETE 트리거를 거치지 않고 옛 행을 지운다. 충돌할 행이 있으면 삽입 자체를 막는다
    "event_no_replace": ("CREATE TRIGGER event_no_replace BEFORE INSERT ON event WHEN EXISTS("
                         "SELECT 1 FROM event WHERE seq=NEW.seq OR event_id=NEW.event_id OR idem_key=NEW.idem_key) "
                         "BEGIN SELECT RAISE(ABORT, 'event는 추가 전용'); END"),
    "payload_no_replace": ("CREATE TRIGGER payload_no_replace BEFORE INSERT ON payload WHEN EXISTS("
                           "SELECT 1 FROM payload WHERE sha=NEW.sha) "
                           "BEGIN SELECT RAISE(ABORT, 'payload는 수정 불가'); END"),
    "payload_no_update": "CREATE TRIGGER payload_no_update BEFORE UPDATE ON payload BEGIN SELECT RAISE(ABORT, 'payload는 수정 불가'); END",
    "payload_redact_only": ("CREATE TRIGGER payload_redact_only BEFORE DELETE ON payload "
                            "WHEN coalesce((SELECT v FROM meta WHERE k='redact_gate'),'0') <> '1' "
                            "BEGIN SELECT RAISE(ABORT, 'payload는 record.redact만 지울 수 있다'); END"),
}


class LedgerError(Exception):
    pass


class IdemConflict(LedgerError):
    """같은 idem_key에 내용이 다른 이벤트."""


class VersionConflict(LedgerError):
    """expected_version 불일치."""


class RedactedPayload(LedgerError):
    """record.redact로 지운 본문과 같은 내용을 다시 쓰려 했다. 지운 비밀이 되살아나지 않게 거부한다."""


def ledger_path() -> Path:
    return paths.ledger_dir() / "ledger.db"


def _busy(e: sqlite3.Error) -> bool:
    return (getattr(e, "sqlite_errorcode", 0) or 0) & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)


@contextmanager
def _txn(c: sqlite3.Connection):
    # connect_rw의 기본값은 secure_delete=0이다. 연결 출처와 무관하게 지운 본문이 빈 쪽에 남지 않게 한다
    c.execute("PRAGMA secure_delete=ON")
    c.execute("BEGIN IMMEDIATE")
    try:
        _ensure(c)
        yield
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise


def open_ledger(path: str | Path | None = None) -> sqlite3.Connection:
    """쓰기 연결을 연다. 새 원장이면 스키마까지 만든다. 첫 기동이 겹친 WAL 전환 경합은 재시도한다.
    깨진 파일은 고치지 않고 연결을 돌려준다. 판단은 verify_chain과 integrity의 몫이다."""
    p = Path(path) if path else ledger_path()
    cas.make_dirs(p.parent)
    end = time.monotonic() + OPEN_WAIT_S
    while True:
        c = None
        try:
            c = _conn.connect_rw(p, "FULL")
            if c.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] == 0:
                with _txn(c):
                    pass
            return c
        except sqlite3.DatabaseError as e:
            if not _busy(e):
                if c is None:
                    raise
                return c
            if c is not None:
                c.close()
            if time.monotonic() > end:
                raise
            time.sleep(0.02)


def _ensure(c: sqlite3.Connection) -> None:
    if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event'").fetchone():
        return
    for ddl in TABLES:
        c.execute(ddl)
    for ddl in TRIGGERS.values():
        c.execute(ddl)
    c.executemany("INSERT INTO meta(k,v) VALUES(?,?)",
                  [("ledger_schema", LEDGER_SCHEMA), ("epoch", "0"), ("redact_gate", "0")])


def chain_hash(prev_hash: str, seq: int, event_id: str, v: int, at: int, actor: str,
               on_behalf_of: str | None, generated_by: str | None, origin: str, kind: str,
               subject: str | None, idem_key: str, payload_sha: str) -> str:
    return sha256_hex(canon_json([prev_hash, seq, event_id, v, at, actor, on_behalf_of, generated_by,
                                  origin, kind, subject, idem_key, payload_sha]))


def row_hash(row: dict | tuple) -> str:
    if not isinstance(row, dict):
        row = dict(zip(EVENT_COLS, row))
    return chain_hash(row["prev_hash"], row["seq"], row["event_id"], row["v"], row["at"], row["actor"],
                      row["on_behalf_of"], row["generated_by"], row["origin"], row["kind"],
                      row["subject"], row["idem_key"], row["payload_sha"])


def _record_version(c: sqlite3.Connection, subject: str, upto: int) -> int:
    return c.execute("SELECT count(*) FROM event WHERE subject=? AND seq<=? AND kind IN (?,?,?)",
                     (subject, upto, *RECORD_KINDS)).fetchone()[0]


def append(c: sqlite3.Connection, events: Iterable[dict], *, now_ms: int | None = None) -> list[dict]:
    """이벤트를 한 트랜잭션으로 덧붙인다. 이벤트 dict 키:
    kind, actor, origin, idem_key, payload(dict), subject, on_behalf_of, generated_by, v, event_id, expected_version, at(선택).
    반환: 이벤트마다 {seq, event_id, hash, at, replayed, version}. record.redact 줄에는 wal_cleared가 붙는다
    (redact() 참고)."""
    events = list(events)
    out: list[dict] = []
    with _txn(c):
        st = _tail(c)
        for ev in events:
            out.append(_append_one(c, ev, st, now_ms))
    redacts = [r for ev, r in zip(events, out) if ev.get("kind") == "record.redact"]
    if redacts:
        cleared = flush_wal(c)
        for r in redacts:
            r["wal_cleared"] = cleared
    return out


def _tail(c: sqlite3.Connection) -> dict:
    last = c.execute("SELECT seq, hash, at FROM event ORDER BY seq DESC LIMIT 1").fetchone()
    return {"seq": last[0], "hash": last[1], "at": last[2]} if last else {"seq": 0, "hash": GENESIS, "at": 0}


def _append_one(c: sqlite3.Connection, ev: dict, st: dict, now_ms: int | None) -> dict:
    kind = ev.get("kind")
    if kind not in KINDS:
        raise LedgerError(f"알 수 없는 kind: {kind!r}")
    actor, origin, idem = ev.get("actor"), ev.get("origin"), ev.get("idem_key")
    if not actor or not isinstance(actor, str):
        raise LedgerError("actor 필수")
    if origin not in ORIGINS:
        raise LedgerError(f"origin 오류: {origin!r}")
    if not idem or not isinstance(idem, str):
        raise LedgerError("idem_key 필수")
    payload = ev.get("payload")
    if not isinstance(payload, dict):
        raise LedgerError("payload는 객체")
    subject = ev.get("subject")
    for name in ("subject", "on_behalf_of", "generated_by", "event_id"):
        val = ev.get(name)
        if val is not None and not isinstance(val, str):
            raise LedgerError(f"{name}은 str 또는 None: {type(val).__name__}")
    if kind in RECORD_KINDS and not subject:
        raise LedgerError("record.* 는 subject(레코드 ID) 필수")
    body = canon_json(payload)
    psha = sha256_hex(body)

    row = c.execute("SELECT seq,event_id,hash,at,kind,subject,payload_sha,actor,origin,on_behalf_of,generated_by,v "
                    "FROM event WHERE idem_key=?", (idem,)).fetchone()
    if row:
        # event_id, at은 쓸 때 정해지는 값이라 내용이 아니다. v를 안 준 재시도는 코드가 정하는 기본값을 따르므로
        # 코드 판이 올라간 뒤의 재시도가 충돌로 잘못 판정되지 않게 준 경우만 비교한다
        same = row[4:11] == (kind, subject, psha, actor, origin, ev.get("on_behalf_of"), ev.get("generated_by"))
        if not same or ev.get("v") not in (None, row[11]):
            raise IdemConflict(f"idem_key에 내용이 다른 이벤트가 있음(seq={row[0]})")
        ver = _record_version(c, subject, row[0]) if kind in RECORD_KINDS else None
        return {"seq": row[0], "event_id": row[1], "hash": row[2], "at": row[3], "replayed": True, "version": ver}

    if kind in RECORD_KINDS:
        head = c.execute("SELECT version FROM record_head WHERE id=?", (subject,)).fetchone()
        cur = head[0] if head else 0
        exp = ev.get("expected_version")
        if exp is not None and exp != cur:
            raise VersionConflict(f"{subject}: expected_version={exp}, 현재={cur}")
        version = cur + 1
    else:
        version = None

    seq = st["seq"] + 1
    if ev.get("at") is not None:  # 골든 재생용 시각 지정. 단조 규칙은 그대로 적용된다
        now = int(ev["at"])
    else:
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
    at = max(st["at"], now)
    event_id = ev.get("event_id") or uuid7()
    v = ev.get("v")
    if v is None:
        v = upcast.current_v(kind)
    elif isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= upcast.current_v(kind):
        raise LedgerError(f"v 오류: {v!r} (1..{upcast.current_v(kind)})")
    h = chain_hash(st["hash"], seq, event_id, v, at, actor, ev.get("on_behalf_of"), ev.get("generated_by"),
                   origin, kind, subject, idem, psha)
    if not c.execute("SELECT 1 FROM payload WHERE sha=?", (psha,)).fetchone():
        if c.execute("SELECT 1 FROM event WHERE payload_sha=? LIMIT 1", (psha,)).fetchone():
            raise RedactedPayload(f"지운 본문과 같은 내용: {psha[:12]}")
        c.execute("INSERT INTO payload(sha, body) VALUES(?,?)", (psha, body))
    c.execute("INSERT INTO event(seq,event_id,v,at,actor,on_behalf_of,generated_by,origin,kind,subject,idem_key,"
              "payload_sha,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (seq, event_id, v, at, actor, ev.get("on_behalf_of"), ev.get("generated_by"), origin, kind,
               subject, idem, psha, st["hash"], h))
    if kind in RECORD_KINDS:
        c.execute("INSERT INTO record_head(id,version,content_sha) VALUES(?,?,?) "
                  "ON CONFLICT(id) DO UPDATE SET version=excluded.version, content_sha=excluded.content_sha",
                  (subject, version, psha))
    if kind == "schema.epoch_bumped":
        c.execute("UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='epoch'")
    elif kind == "system.fp_opened":
        c.execute("INSERT INTO meta(k,v) VALUES('fp_open',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(at),))
    elif kind == "record.redact":
        _apply_redact(c, subject, payload.get("payload_shas") or [])
    st.update(seq=seq, hash=h, at=at)
    return {"seq": seq, "event_id": event_id, "hash": h, "at": at, "replayed": False, "version": version}


def _released(c: sqlite3.Connection, subject: str, sha: str, used_seq: int) -> bool:
    """subject가 그 본문을 쓴 마지막 이벤트 뒤의 record.redact가 본문을 shared로 넘겼는가."""
    rows = c.execute("SELECT e.seq, p.body FROM event e JOIN payload p ON p.sha=e.payload_sha "
                     "WHERE e.subject=? AND e.kind='record.redact' AND e.seq>?", (subject, used_seq)).fetchall()
    return any(sha in (json.loads(r[1]).get("shared") or []) for r in rows)


def _redact_plan(c: sqlite3.Connection, record_id: str) -> tuple[list[str], list[str]]:
    """(지울 본문, 남길 공유 본문). 트랜잭션 안에서 부른다. 대상은 레코드의 이벤트 본문 중 아직 남은 것이고
    record.redact 이벤트의 본문은 삭제 증거라 대상이 아니다. 이미 redact된 다른 레코드는 공유로 세지 않는다."""
    kill, shared = [], []
    rows = c.execute("SELECT DISTINCT e.payload_sha FROM event e JOIN payload p ON p.sha=e.payload_sha "
                     "WHERE e.subject=? AND e.kind<>'record.redact'", (record_id,)).fetchall()
    for (s,) in rows:
        users = c.execute("SELECT subject, max(seq), max(kind='record.redact') FROM event "
                          "WHERE payload_sha=? GROUP BY subject", (s,)).fetchall()
        keep = any(u[2] or (u[0] != record_id and (u[0] is None or not _released(c, u[0], s, u[1])))
                   for u in users)
        (shared if keep else kill).append(s)
    return sorted(kill), sorted(shared)


def _apply_redact(c: sqlite3.Connection, subject: str, shas: list[str]) -> None:
    if not shas:
        return
    bad = set(shas) - set(_redact_plan(c, subject)[0])
    if bad:
        raise LedgerError(f"{subject}: 지울 수 없는 본문 {sorted(s[:12] for s in bad)}")
    c.execute("UPDATE meta SET v='1' WHERE k='redact_gate'")
    try:
        c.executemany("DELETE FROM payload WHERE sha=?", [(s,) for s in shas])
    finally:
        c.execute("UPDATE meta SET v='0' WHERE k='redact_gate'")


def _redact_replay(c: sqlite3.Connection, row: tuple, record_id: str) -> dict:
    body = get_payload(c, row[4]) or {}
    return {"seq": row[0], "event_id": row[1], "hash": row[2], "at": row[3], "replayed": True,
            "version": _record_version(c, record_id, row[0]), "removed": body.get("payload_shas", []),
            "shared": body.get("shared", [])}


def redact(c: sqlite3.Connection, record_id: str, reason: str, actor: str,
           idem_key: str | None = None, on_behalf_of: str | None = None) -> dict:
    """record.redact 이벤트를 쓰고 그 레코드의 남은 payload 본문을 지운다. 판정과 삭제는 한 트랜잭션이다.
    다른 레코드가 같은 본문을 쓰면 지우지 않고 shared에 보고한다.
    반환의 wal_cleared가 False이면 삭제는 확정됐지만 옛 평문이 WAL에 남아 있고, 열린 읽기 스냅샷이 지운 행을
    볼 수 있다. 읽기 연결이 끝난 뒤 redact를 같은 인수로 다시 부르거나 flush_wal을 부른다.
    지울 것이 더 없으면 직전 redact를 replayed=True로 돌려준다. redact 뒤 새 버전이 들어오면 다시 지운다.
    idem_key를 재사용했는데 지울 본문이 새로 있으면 IdemConflict다."""
    cols = "seq, event_id, hash, at, payload_sha"
    res = _redact_txn(c, record_id, reason, actor, idem_key, on_behalf_of, cols)
    res["wal_cleared"] = flush_wal(c)
    return res


def flush_wal(c: sqlite3.Connection) -> bool:
    """WAL을 본 파일에 옮기고 비운다. 비웠으면 True. 읽기 연결이 막으면 busy_timeout까지 기다린 뒤 False다.
    실패는 예외가 아니라 PRAGMA 결과 행의 busy로 온다."""
    try:
        row = c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    except sqlite3.Error:
        return False
    return row is not None and row[0] == 0 and row[1] == 0


def _redact_txn(c, record_id, reason, actor, idem_key, on_behalf_of, cols):
    with _txn(c):
        if not c.execute("SELECT 1 FROM event WHERE subject=? LIMIT 1", (record_id,)).fetchone():
            raise LedgerError(f"없는 레코드: {record_id}")
        kill, shared = _redact_plan(c, record_id)
        if not kill:
            prior = c.execute(f"SELECT {cols} FROM event WHERE subject=? AND kind='record.redact' "
                              "ORDER BY seq DESC LIMIT 1", (record_id,)).fetchone()
            if prior:
                res = _redact_replay(c, prior, record_id)
                if set(shared) <= set(res["shared"]):
                    return res
        key = idem_key or f"redact:{record_id}:{sha256_hex(canon_json([kill, shared]))[:16]}"
        old = c.execute(f"SELECT {cols} FROM event WHERE idem_key=? AND kind='record.redact'", (key,)).fetchone()
        if old:
            osub = c.execute("SELECT subject FROM event WHERE idem_key=? AND kind='record.redact'", (key,)).fetchone()
            if osub and osub[0] != record_id:
                raise IdemConflict(f"idem_key는 다른 레코드({osub[0]})에 쓰였다")
            if kill:
                raise IdemConflict("idem_key를 쓴 뒤 지울 본문이 새로 생겼다")
            return _redact_replay(c, old, record_id)
        res = _append_one(c, {
            "kind": "record.redact", "actor": actor, "on_behalf_of": on_behalf_of, "origin": "system",
            "subject": record_id, "idem_key": key,
            "payload": {"id": record_id, "reason": reason, "payload_shas": kill, "shared": shared},
        }, _tail(c), None)
    res["removed"] = kill
    res["shared"] = shared
    return res


def get_payload(c: sqlite3.Connection, sha: str) -> dict | None:
    r = c.execute("SELECT body FROM payload WHERE sha=?", (sha,)).fetchone()
    return json.loads(r[0]) if r else None


def record_head(c: sqlite3.Connection, record_id: str) -> tuple[int, str] | None:
    r = c.execute("SELECT version, content_sha FROM record_head WHERE id=?", (record_id,)).fetchone()
    return (r[0], r[1]) if r else None


def head(c: sqlite3.Connection) -> tuple[int, str]:
    r = c.execute("SELECT seq, hash FROM event ORDER BY seq DESC LIMIT 1").fetchone()
    return (r[0], r[1]) if r else (0, GENESIS)


def meta_get(c: sqlite3.Connection, k: str) -> str | None:
    r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else None


def iter_events(c: sqlite3.Connection, after: int = 0, limit: int = 1000, *, upcast_payload: bool = True) -> list[dict]:
    """seq > after 인 이벤트를 seq 순으로. payload는 지워졌으면 None, redacted=True."""
    cols = ", ".join(f"e.{n}" for n in EVENT_COLS)
    rows = c.execute(f"SELECT {cols}, p.body FROM event e LEFT JOIN payload p ON p.sha=e.payload_sha "
                     "WHERE e.seq>? ORDER BY e.seq LIMIT ?", (after, limit)).fetchall()
    out = []
    for r in rows:
        d = dict(zip(EVENT_COLS, r[:-1]))
        p = json.loads(r[-1]) if r[-1] is not None else None
        d["redacted"] = p is None
        if upcast_payload and p is not None:
            d["v_current"], p = upcast.upcast(d["kind"], d["v"], p)
        d["payload"] = p
        out.append(d)
    return out


# ---------------------------------------------------------------- 검증

@dataclass
class VerifyResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    events: int = 0
    head_seq: int = 0
    head_hash: str = GENESIS

    def __bool__(self) -> bool:
        return self.ok


_expected_master_cache: dict[str, str] | None = None


def _expected_master() -> dict[str, str]:
    global _expected_master_cache
    if _expected_master_cache is None:
        m = sqlite3.connect(":memory:")
        for ddl in (*TABLES, *TRIGGERS.values()):
            m.execute(ddl)
        _expected_master_cache = {r[0]: r[1] for r in m.execute(
            "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
        m.close()
    return _expected_master_cache


def integrity(c: sqlite3.Connection) -> list[str]:
    """PRAGMA integrity_check. 문제가 없으면 빈 목록."""
    try:
        rows = [r[0] for r in c.execute("PRAGMA integrity_check").fetchall()]
    except sqlite3.DatabaseError as e:
        return [f"integrity_check 실패: {e}"]
    return [] if rows == ["ok"] else rows


def verify_chain(c: sqlite3.Connection) -> VerifyResult:
    """체인 + record_head/meta/payload 재생 대조 + 스키마·트리거 대조. 읽다가 깨지면 실패로 돌려준다.
    전체를 한 읽기 트랜잭션(WAL 스냅샷)으로 읽는다. 쓰기가 겹쳐도 한 시점만 본다."""
    began = False
    try:
        if not c.in_transaction:
            c.execute("BEGIN")
            began = True
        return _verify_chain(c)
    except (sqlite3.DatabaseError, UnicodeError, ValueError, TypeError) as e:
        return VerifyResult(False, [f"검증 중 읽기 실패: {type(e).__name__}: {e}"])
    finally:
        if began and c.in_transaction:
            try:
                c.execute("ROLLBACK")
            except sqlite3.Error:
                pass


def _verify_chain(c: sqlite3.Connection) -> VerifyResult:
    errs: list[str] = []

    def err(m: str) -> None:
        if len(errs) < 50:
            errs.append(m)

    try:
        have = {r[0]: r[1] for r in c.execute("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
    except sqlite3.DatabaseError as e:
        return VerifyResult(False, [f"sqlite_master 읽기 실패: {e}"])
    exp = _expected_master()
    if "event" not in have:
        return VerifyResult(True) if not have else VerifyResult(False, ["스키마 불완전"])
    for n, sql in exp.items():
        if have.get(n) != sql:
            err(f"스키마/트리거 불일치: {n}")
    for n in have:
        if n not in exp:
            err(f"예상 밖 객체: {n}")

    prev, expect, prev_at = GENESIS, 1, 0
    heads: dict[str, tuple[int, str]] = {}
    epoch, fp_open = 0, None
    referenced: set[str] = set()
    redact_events: list[str] = []
    seen_ids: set[str] = set()
    n = 0
    cols = ", ".join(EVENT_COLS)
    last_hash = GENESIS
    for row in c.execute(f"SELECT {cols} FROM event ORDER BY seq"):
        d = dict(zip(EVENT_COLS, row))
        n += 1
        if d["seq"] != expect:
            err(f"seq 구멍/중복: 기대 {expect}, 실제 {d['seq']}")
            expect = d["seq"]
        expect += 1
        if d["prev_hash"] != prev:
            err(f"prev_hash 불일치 seq={d['seq']}")
        try:
            if row_hash(d) != d["hash"]:
                err(f"hash 불일치 seq={d['seq']}")
        except Exception as e:  # 형이 깨진 열
            err(f"hash 계산 불가 seq={d['seq']}: {e}")
        if not isinstance(d["at"], int) or d["at"] < prev_at:
            err(f"at 단조 위반 seq={d['seq']}")
        else:
            prev_at = d["at"]
        if d["kind"] not in KINDS:
            err(f"알 수 없는 kind seq={d['seq']}")
        if d["origin"] not in ORIGINS:
            err(f"origin 오류 seq={d['seq']}")
        if d["event_id"] in seen_ids:
            err(f"event_id 중복 seq={d['seq']}")
        seen_ids.add(d["event_id"])
        prev = last_hash = d["hash"]
        referenced.add(d["payload_sha"])
        k = d["kind"]
        if k in RECORD_KINDS:
            ver = heads.get(d["subject"], (0, ""))[0] + 1
            heads[d["subject"]] = (ver, d["payload_sha"])
            if k == "record.redact":
                redact_events.append(d["payload_sha"])
        elif k == "schema.epoch_bumped":
            epoch += 1
        elif k == "system.fp_opened":
            fp_open = str(d["at"])

    pay = {}
    for sha, body in c.execute("SELECT sha, body FROM payload"):
        pay[sha] = body
        try:
            if sha256_hex(bytes(body)) != sha:
                err(f"payload 본문 해시 불일치 {sha[:12]}")
        except Exception:
            err(f"payload 형 오류 {str(sha)[:12]}")
    covered: set[str] = set()
    for s in redact_events:
        if s not in pay:
            err(f"record.redact 본문이 없음 {s[:12]}")
            continue
        try:
            covered.update(json.loads(pay[s]).get("payload_shas") or [])
        except Exception:
            err(f"record.redact 본문 해석 불가 {s[:12]}")
    for s in pay:
        if s not in referenced:
            err(f"고아 payload {str(s)[:12]}")
    for s in referenced:
        if s not in pay and s not in covered:
            err(f"payload 소실(redact 기록 없음) {s[:12]}")
    for s in covered:
        if s in pay:
            err(f"redact로 지운 본문이 남아 있음 {s[:12]}")

    got_heads = {r[0]: (r[1], r[2]) for r in c.execute("SELECT id, version, content_sha FROM record_head")}
    if got_heads != heads:
        diff = set(got_heads.items()) ^ set(heads.items())
        err(f"record_head 재생 불일치({len(diff)}건)")
    want_meta = {"ledger_schema": LEDGER_SCHEMA, "epoch": str(epoch), "redact_gate": "0"}
    if fp_open is not None:
        want_meta["fp_open"] = fp_open
    got_meta = {r[0]: r[1] for r in c.execute("SELECT k, v FROM meta")}
    if got_meta != want_meta:
        err("meta 재생 불일치")
    seqrow = c.execute("SELECT seq FROM sqlite_sequence WHERE name='event'").fetchone()
    if n and (not seqrow or seqrow[0] != expect - 1):
        err("sqlite_sequence 불일치")
    return VerifyResult(not errs, errs, n, expect - 1, last_hash)


# ---------------------------------------------------------------- 봉인 내보내기

def export_dir() -> Path:
    return paths.ledger_dir() / "export"


def manifest_path() -> Path:
    return export_dir() / "MANIFEST.ndjson"


def manifest_rows() -> list[dict]:
    """개행으로 끝나지 않은 꼬리는 미완성 쓰기라 없는 것으로 본다. 다음 봉인이 잘라 낸다.
    완성된 줄이 깨졌으면 진짜 손상이므로 LedgerError다."""
    p = manifest_path()
    if not p.exists():
        return []
    raw = p.read_bytes()
    rows = []
    for i, x in enumerate(raw[:raw.rfind(b"\n") + 1].splitlines(), 1):
        if x.strip():
            try:
                rows.append(json.loads(x))
            except ValueError as e:
                raise LedgerError(f"MANIFEST {i}행 손상: {e}") from e
    return rows


def _repair_manifest() -> None:
    """크래시로 남은 미완성 꼬리를 잘라 낸다. 그 행의 세그먼트는 고아가 되어 _sweep_orphans가 치운다."""
    p = manifest_path()
    if not p.exists():
        return
    raw = p.read_bytes()
    keep = raw.rfind(b"\n") + 1
    if keep != len(raw):
        fd = os.open(p, os.O_WRONLY)
        try:
            os.ftruncate(fd, keep)
            os.fsync(fd)
        finally:
            os.close(fd)


def _append_manifest(row: dict) -> None:
    p = manifest_path()
    cas.make_dirs(p.parent)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        cas.write_all(fd, canon_json(row) + b"\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    cas.fsync_dir(p.parent)


def _in_ledger(c: sqlite3.Connection, f: Path) -> bool:
    """세그먼트의 모든 줄이 원장에 같은 해시로 있는가."""
    try:
        lines = _parse_segment(f.read_bytes())
    except LedgerError:
        return False
    return bool(lines) and all(
        (r := c.execute("SELECT hash FROM event WHERE seq=?", (ln["seq"],)).fetchone()) and r[0] == ln["hash"]
        for ln in lines)


def _sweep_orphans(c: sqlite3.Connection) -> None:
    """파일을 쓰고 MANIFEST 행을 쓰기 전에 죽으면 고아 세그먼트가 남는다. 재봉인이 보지 못하므로 redact 뒤에도
    평문이 남는다. 내용이 전부 원장에 있으면 다시 내보낼 수 있으니 지운다. 원장에 없는 파일은 지우지 않고 멈춘다."""
    root = export_dir()
    known = {r["file"] for r in manifest_rows()}
    for f in sorted(root.rglob("*")):
        if f.name.startswith(".tmp-"):
            cas.unlink_quiet(f)
        elif f.name.endswith(".ndjson.zst") and f.relative_to(root).as_posix() not in known:
            if not _in_ledger(c, f):
                raise LedgerError(f"MANIFEST에도 원장에도 없는 세그먼트: {f}")
            os.unlink(f)
            cas.fsync_dir(f.parent)


@contextmanager
def _sealing(c: sqlite3.Connection):
    """내보내기와 재봉인을 직렬화하고, 앞선 크래시의 흔적을 먼저 치운다."""
    cas.make_dirs(export_dir())
    gate = Gate(export_dir() / ".seal.lock")
    fd = gate.acquire(SEAL_WAIT_S)
    try:
        _repair_manifest()
        _sweep_orphans(c)
        yield
    finally:
        gate.release(fd)


def _zst(data: bytes) -> bytes:
    return zstd.compress(data, options={zstd.CompressionParameter.compression_level: 3,
                                        zstd.CompressionParameter.checksum_flag: 1})


def _parse_segment(blob: bytes) -> list[dict]:
    try:
        return [json.loads(x) for x in zstd.decompress(blob).split(b"\n") if x]
    except (zstd.ZstdError, ValueError) as e:
        raise LedgerError(f"세그먼트 해석 불가: {e}") from e


def read_segment(rel_file: str) -> list[dict]:
    return _parse_segment((export_dir() / rel_file).read_bytes())


def segment_sha(rel_file: str) -> str | None:
    sha = None
    for r in manifest_rows():
        if r.get("file") == rel_file and r.get("kind") in ("segment", "resealed"):
            sha = r["sha256"]
    return sha


def _line(e: dict) -> dict:
    d = {k: e[k] for k in EVENT_COLS}
    d["payload"] = e["payload"] if e["payload"] is not None else REDACTED_LINE
    return d


def export_segment(c: sqlite3.Connection) -> list[dict]:
    """MANIFEST 이후의 새 이벤트를 월 단위 봉인 세그먼트(NDJSON + zstd)로 쓴다. 새 이벤트가 없으면 빈 목록."""
    made: list[dict] = []
    with _sealing(c):
        segs = [r for r in manifest_rows() if r.get("kind") == "segment"]
        last = max((r["last_seq"] for r in segs), default=0)
        if segs:
            tail = max(segs, key=lambda r: r["last_seq"])
            cur = c.execute("SELECT hash FROM event WHERE seq=?", (tail["last_seq"],)).fetchone()
            if cur is None or cur[0] != tail["head_hash"]:
                raise LedgerError(f"MANIFEST와 원장이 이어지지 않는다: seq {tail['last_seq']} 해시 불일치 "
                                  "(백업 복원 뒤라면 빠진 세그먼트를 먼저 맞춘다)")
        while True:
            evs = iter_events(c, last, 5000, upcast_payload=False)
            if not evs:
                break
            groups: list[list] = []
            for e in evs:
                t = time.gmtime(e["at"] / 1000)
                key = (t.tm_year, t.tm_mon)
                if groups and groups[-1][0] == key:
                    groups[-1][1].append(e)
                else:
                    groups.append([key, [e]])
            # 마지막 묶음만 이어질 수 있으므로 한 번에 다 쓰고 다음 루프에서 이어 간다
            for key, items in groups:
                first, lastq = items[0]["seq"], items[-1]["seq"]
                rel = f"{key[0]:04d}/{key[1]:02d}/{first:012d}-{lastq:012d}.ndjson.zst"
                blob = _zst(b"".join(canon_json(_line(e)) + b"\n" for e in items))
                cas.atomic_write(export_dir() / rel, blob)
                row = {"kind": "segment", "file": rel, "first_seq": first, "last_seq": lastq, "count": len(items),
                       "sha256": sha256_hex(blob), "prev_hash": items[0]["prev_hash"],
                       "head_hash": items[-1]["hash"], "sealed_at": int(time.time() * 1000)}
                _append_manifest(row)
                made.append(row)
                last = lastq
    return made


def _marked(x: dict) -> bool:
    """redact 표지 줄인가. 진짜 본문이 표지와 같은 내용이면 해시가 맞으므로 표지가 아니다."""
    return x["payload"] == REDACTED_LINE and x["payload_sha"] != REDACTED_LINE_SHA


def _check_lines(c: sqlite3.Connection, seg: dict, lines: list[dict]) -> None:
    """봉인을 새로 찍기 전에 줄이 원본 그대로인지 본다. 변조된 파일을 재봉인으로 세탁하지 않는다.
    이벤트 열은 원장의 해시와 맞아야 하고, 본문은 해시가 맞거나 원장에서 실제로 지워진 줄의 표지여야 한다."""
    if [x.get("seq") for x in lines] != list(range(seg["first_seq"], seg["last_seq"] + 1)):
        raise LedgerError(f"세그먼트 범위 불일치: {seg['file']}")
    for x in lines:
        if set(x) != {*EVENT_COLS, "payload"}:
            raise LedgerError(f"세그먼트 줄 형식 오류 seq={x['seq']}: {seg['file']}")
        led = c.execute("SELECT hash FROM event WHERE seq=?", (x["seq"],)).fetchone()
        if led is None or led[0] != x["hash"] or row_hash(x) != x["hash"]:
            raise LedgerError(f"세그먼트 줄 변조 seq={x['seq']}: {seg['file']}")
        if _marked(x):
            if c.execute("SELECT 1 FROM payload WHERE sha=?", (x["payload_sha"],)).fetchone():
                raise LedgerError(f"살아 있는 본문이 지워진 줄 seq={x['seq']}: {seg['file']}")
        elif sha256_hex(canon_json(x["payload"])) != x["payload_sha"]:
            raise LedgerError(f"세그먼트 줄 변조 seq={x['seq']}: {seg['file']}")


def reseal_segment(c: sqlite3.Connection, seq: int) -> dict | None:
    """seq가 든 세그먼트에서 원장 payload가 지워진 줄의 본문을 {"redacted":true}로 바꿔 재봉인한다.
    MANIFEST에 resealed 행을 더한다. 파일 교체 뒤 행을 쓰기 전에 죽었으면 재호출이 그 행을 채운다
    (recovered=true). 바꿀 줄이 없고 봉인도 일치하면 None. 줄 검사를 통과한 파일만 봉인을 받는다."""
    with _sealing(c):
        seg = next((r for r in manifest_rows()
                    if r.get("kind") == "segment" and r["first_seq"] <= seq <= r["last_seq"]), None)
        if seg is None:
            raise LedgerError(f"seq {seq} 를 담은 세그먼트 없음")
        path = export_dir() / seg["file"]
        cur = path.read_bytes()
        lines = _parse_segment(cur)
        _check_lines(c, seg, lines)
        prev = segment_sha(seg["file"])
        unsealed = sha256_hex(cur) != prev  # 앞선 재봉인이 행을 쓰기 전에 죽었다
        marked = [x["seq"] for x in lines if _marked(x)]
        changed = []
        for ln in lines:
            if ln["payload"] != REDACTED_LINE and not c.execute(
                    "SELECT 1 FROM payload WHERE sha=?", (ln["payload_sha"],)).fetchone():
                ln["payload"] = REDACTED_LINE
                changed.append(ln["seq"])
        row = {"kind": "resealed", "file": seg["file"], "first_seq": seg["first_seq"], "last_seq": seg["last_seq"],
               "prev_sha256": prev, "sealed_at": int(time.time() * 1000)}
        if changed:
            blob = _zst(b"".join(canon_json(x) + b"\n" for x in lines))
            cas.atomic_write(path, blob)
            row.update(sha256=sha256_hex(blob))
        elif not unsealed:
            return None
        elif not marked:
            raise LedgerError(f"봉인 불일치, 재봉인 흔적 아님: {seg['file']}")
        else:
            row.update(sha256=sha256_hex(cur))
        if unsealed:
            row.update(lines=sorted(marked + changed), recovered=True)
        else:
            row.update(lines=changed)
        _append_manifest(row)
        return row
