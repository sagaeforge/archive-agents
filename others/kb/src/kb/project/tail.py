"""project_tail: 원장 꼬리를 gold에 투영한다(ADR 8장). 호출 프로세스가 게이트를 쥐고 있어야 한다."""
from __future__ import annotations

import errno
import json
import sqlite3
from dataclasses import dataclass, field

from kb.core import cas, ledger
from kb.project import apply as ap
from kb.project.db import check_schema, meta_get, meta_set

QKIND, RKIND = "system.projection_quarantined", "system.projection_released"
ENV_SQLITE = {sqlite3.SQLITE_FULL, sqlite3.SQLITE_IOERR, sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED,
              sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_NOMEM, sqlite3.SQLITE_READONLY}
ENV_ERRNO = {errno.ENOSPC, errno.EIO, errno.EDQUOT, errno.ENOMEM, errno.EROFS, errno.EMFILE, errno.ENFILE, errno.EBUSY}
ENV_WORDS = ("disk is full", "disk i/o", "unable to open", "readonly", "read-only", "database is locked", "out of memory")


def is_env_error(ex: BaseException) -> bool:
    """디스크 부족 같은 환경 실패. 이벤트 탓이 아니므로 격리하지 않는다."""
    if isinstance(ex, (cas.CasMissing, cas.CasCorrupt, ap.MissingObject)):
        return False
    if isinstance(ex, MemoryError):
        return True
    if isinstance(ex, sqlite3.Error):
        code = (getattr(ex, "sqlite_errorcode", 0) or 0) & 0xFF
        return code in ENV_SQLITE or any(w in str(ex).lower() for w in ENV_WORDS)
    if isinstance(ex, OSError):
        return ex.errno in ENV_ERRNO
    return False


@dataclass
class TailResult:
    applied: int = 0
    skipped: int = 0
    last_seq: int = 0
    caught_up: bool = False
    paras: int = 0
    quarantined: list = field(default_factory=list)
    env_error: str | None = None
    missing: list = field(default_factory=list)
    stopped: str | None = None


def skip_set(g: sqlite3.Connection, led: sqlite3.Connection, after: int, until: int | None = None) -> set[int]:
    """건너뛸 seq 집합: gold의 격리 표 + 꼬리의 quarantined - 꼬리의 released."""
    q = {r[0] for r in g.execute("SELECT seq FROM quarantine")}
    rel: set[int] = set()
    sql = ("SELECT e.kind, p.body FROM event e LEFT JOIN payload p ON p.sha=e.payload_sha "
           "WHERE e.seq>? AND e.kind IN (?,?)" + (" AND e.seq<=?" if until else "") + " ORDER BY e.seq")
    args = [after, QKIND, RKIND] + ([until] if until else [])
    for kind, body in led.execute(sql, args):
        if body is None:
            continue
        s = json.loads(body).get("seq")
        if isinstance(s, int):
            (q if kind == QKIND else rel).add(s)
    return q - rel


def project_tail(led: sqlite3.Connection, gold: sqlite3.Connection, limit: int | None = None,
                 para_budget: int = 200, *, missing: str = "quarantine", until: int | None = None,
                 batch: int = 500, write_quarantine: bool = True) -> TailResult:
    """applied_seq 뒤 이벤트를 적용한다. missing: quarantine | fatal | skip(CAS 객체가 없을 때)."""
    check_schema(gold)
    gold.execute("PRAGMA synchronous=NORMAL")
    res = TailResult()
    gold.execute("BEGIN IMMEDIATE")
    try:
        applied = int(meta_get(gold, "applied_seq") or 0)
        res.last_seq = cursor = applied
        c = ap.Ctx(gold, led, missing)
        c.skip = skip_set(gold, led, applied, until)
        spent = 0
        done = False
        while not done:
            evs = ledger.iter_events(led, cursor, batch)
            if until is not None:
                evs = [e for e in evs if e["seq"] <= until]
            if not evs:
                res.caught_up = True
                break
            for e in evs:
                if limit is not None and res.applied + res.skipped >= limit:
                    res.stopped, done = "limit", True
                    break
                seq = e["seq"]
                if seq in c.skip:
                    cursor = seq
                    res.skipped += 1
                    continue
                est = ap.estimate(c, e)
                if res.applied and spent + est > para_budget:
                    res.stopped, done = "budget", True
                    break
                outcome = _apply_guarded(c, e, led if write_quarantine else None, res)
                if outcome == "env":
                    done = True
                    break
                cursor = seq
                if outcome == "ok":
                    res.applied += 1
                    spent += c.cost
                else:
                    res.skipped += 1
                if spent >= para_budget:
                    res.stopped, done = "budget", True
                    break
        res.paras, res.last_seq = spent, cursor
        meta_set(gold, "applied_seq", cursor)
        gold.execute("COMMIT")
    except BaseException:
        if gold.in_transaction:
            gold.execute("ROLLBACK")
        raise
    res.missing = sorted(set(c.missing))
    return res


def _apply_guarded(c: ap.Ctx, e: dict, led, res: TailResult) -> str:
    g = c.g
    err = None
    for attempt in (1, 2):
        g.execute("SAVEPOINT ev")
        try:
            ap.apply_event(c, e)
            g.execute("RELEASE ev")
            return "ok"
        except ap.MissingObject:
            g.execute("ROLLBACK TO ev")
            g.execute("RELEASE ev")
            raise
        except Exception as ex:  # noqa: BLE001 - 이벤트 하나의 실패는 격리 대상이다
            g.execute("ROLLBACK TO ev")
            g.execute("RELEASE ev")
            if is_env_error(ex):
                res.env_error = f"{type(ex).__name__}: {ex}"
                res.stopped = "env"
                return "env"
            err = ex
    reason = f"{type(err).__name__}: {err}"[:500]
    if led is not None:
        ledger.append(led, [{
            "kind": QKIND, "actor": "system", "origin": "system", "idem_key": f"projection-quarantine:{e['seq']}",
            "subject": str(e["seq"]), "payload": {"seq": e["seq"], "error": reason}}])
    c.skip.add(e["seq"])
    res.quarantined.append(e["seq"])
    return "quarantined"
