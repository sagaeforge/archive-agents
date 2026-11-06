"""first_party 게이트(ADR 8장). ledger.meta fp_open이 없으면 first_party 항목은 spool/fp-held/에 남는다.

kb fp open은 7일 안의 머신 밖 복원 훈련 통과 기록(ops.db drill, kind=restore_offsite, ok=1)이 있을 때만
system.fp_opened를 쓰고 보관 항목을 멱등 적재한다. --accept-single-copy는 TTY와 결정 2 승인을 요구한다.
같은 UID 앞에서 TTY 확인은 실수 방지이고 보안 경계가 아니다.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from kb.core import config, ledger, opsdb, spool
from kb.write import engine as _commit
from kb.write import tty as _tty
from kb.write.errors import IdemConflict, RedactedPayload, VersionConflict, WriteRejected

DRILL_KINDS = ("restore_offsite", "offsite_restore")
DRILL_MAX_AGE_MS = 7 * 24 * 3600 * 1000
ACCEPT_PHRASE = "단일 사본 위험을 수용합니다"
WARNING_TEXT = (
    "경고: 머신 밖 사본 없이 first_party 쓰기를 엽니다. 디스크가 하나 고장나면 사용자 기록을 되살릴 수 없습니다.\n"
    f"계속하려면 다음 문장을 그대로 입력하세요: {ACCEPT_PHRASE}"
)


@dataclass
class OpenResult:
    ok: bool
    mode: str | None = None
    already_open: bool = False
    drained: int = 0
    failed: int = 0
    error: str | None = None
    detail: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "mode": self.mode, "already_open": self.already_open, "drained": self.drained,
                "failed": self.failed, "error": self.error, **self.detail}


def _order_key(item: tuple) -> tuple[int, str]:
    p, obj = item
    ns = obj.get("queued_ns") if isinstance(obj, dict) else None
    if not isinstance(ns, int):  # 손으로 넣었거나 queued_ns가 없는 파일
        try:
            ns = p.stat().st_mtime_ns
        except FileNotFoundError:
            ns = 0
    return ns, p.name


def ordered(kind: str) -> list[tuple]:
    """스풀 항목을 쓴 순서로 낸다. 파일 이름은 해시라 쓴 순서와 무관하다."""
    return sorted(spool.iter_items(kind), key=_order_key)


def is_open() -> bool:
    led = ledger.open_ledger()
    try:
        return _commit.fp_is_open(led)
    finally:
        led.close()


def held_items() -> list[tuple]:
    return ordered("fp-held")


def status() -> dict:
    return {"open": is_open(), "held": len(held_items())}


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield str(k)
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


def list_held(grep: str | None = None) -> list[dict]:
    """보관 중인 항목. grep은 대소문자 무시 부분 문자열이고 여러 단어는 모두 들어 있어야 한다."""
    words = [w.casefold() for w in (grep or "").split() if w]
    out = []
    for p, obj in held_items():
        for e in obj.get("events", []):
            if e.get("kind") != "record.put":
                continue
            pl = e["payload"]
            text = "\n".join(_strings({k: pl.get(k) for k in ("title", "body", "props", "links")})).casefold()
            if all(w in text for w in words):
                out.append({"id": pl.get("id"), "title": pl.get("title"), "type": pl.get("type"),
                            "sensitivity": pl.get("sensitivity"), "authored_at": pl.get("authored_at"),
                            "idem_key": e["idem_key"], "file": p.name})
    return out


def recent_drill(now_ms: int | None = None) -> dict | None:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    c = opsdb.connect()
    try:
        marks = ",".join("?" * len(DRILL_KINDS))
        r = c.execute(f"SELECT id, at FROM drill WHERE kind IN ({marks}) AND ok=1 AND at>=? ORDER BY at DESC LIMIT 1",
                      (*DRILL_KINDS, now - DRILL_MAX_AGE_MS)).fetchone()
        return {"id": r[0], "at": r[1]} if r else None
    finally:
        c.close()


def _fail_item(path, err: Exception, first_party: bool) -> None:
    """재적재가 거부된 항목은 지우지 않고 .failed/로 옮기고 dlq에 넣는다. first_party면 치명 경보다."""
    try:
        dst = spool.mark_failed(path)
    except FileNotFoundError:  # 동시에 돈 drain이 먼저 옮겼고 dlq도 그쪽이 넣었다
        return
    kind = "spool_reload"
    c = opsdb.connect()
    try:
        c.execute("INSERT INTO dlq(kind, ref, stage, error, attempts, payload_sha) VALUES(?,?,?,?,1,?)",
                  (kind, path.name, "recover", f"{type(err).__name__}: {err}"[:500], path.stem))
        sev = "치명" if first_party else "경고"
        opsdb.record_incident(c, "spool_reload_failed", f"{sev}: {path.name} {type(err).__name__}: {str(err)[:300]}", str(dst))
    finally:
        c.close()


def drain(kind: str = "fp-held", *, timeout: float = _commit.GATE_TIMEOUT_S, limit: int | None = None) -> dict:
    """spool/<kind>/ 항목을 쓴 순서대로 원장에 적재한다. 멱등이다. 충돌로 거부된 항목은 .failed/와 dlq로 간다."""
    done = failed = left = 0
    for p, obj in ordered(kind):
        if limit is not None and done + failed >= limit:
            break
        evs = obj.get("events") if isinstance(obj, dict) else None
        if not evs:
            _fail_item(p, ValueError("events 없음"), True)
            failed += 1
            continue
        fp = any(e.get("origin") == "first_party" for e in evs)
        try:
            r = _commit.commit(evs, None, timeout=timeout, spool_on_timeout=False, stored=True)
        except TimeoutError:
            left += 1
            break
        except (ledger.LedgerError, WriteRejected) as e:
            _fail_item(p, e, fp)
            failed += 1
            continue
        if getattr(r, "held", False) or getattr(r, "spooled", False):
            left += 1  # 다시 보관됐다. 파일을 지우면 승인된 기록이 사라진다
            continue
        spool.remove(p)
        done += 1
        time.sleep(_commit.BATCH_SLEEP_S)
    return {"loaded": done, "failed": failed, "left": left}


def open_fp(accept_single_copy: bool = False, *, tty: bool | None = None, confirm=None,
            now_ms: int | None = None) -> OpenResult:
    """first_party 쓰기를 연다. 이미 열려 있으면 보관 항목만 마저 적재한다."""
    if is_open():
        d = drain("fp-held")
        return OpenResult(True, already_open=True, drained=d["loaded"], failed=d["failed"])
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if accept_single_copy:
        if not (_tty.is_tty() if tty is None else tty):
            return OpenResult(False, error="--accept-single-copy는 TTY에서만 동작한다")
        if not config.decision_ok(2):
            return OpenResult(False, error="결정 2 승인이 없다(decisions.toml)")
        print(WARNING_TEXT)
        answer = (confirm or input)()
        if (answer or "").strip() != ACCEPT_PHRASE:
            return OpenResult(False, error="확인 문장이 맞지 않는다")
        payload = {"mode": "accept_single_copy", "authored_before": now}
        key = "fp-opened:accept_single_copy"
        mode = "accept_single_copy"
    else:
        d = recent_drill(now)
        if d is None:
            return OpenResult(False, error="7일 안의 머신 밖 복원 훈련 통과 기록이 없다(kb drill restore --offsite)")
        payload = {"mode": "drill", "drill_at": int(d["at"]), "authored_before": now}
        key = f"fp-opened:drill:{d['id']}"
        mode = "drill"
    r = _commit.commit([{"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system", "subject": "fp",
                         "idem_key": key, "payload": payload}], "user:sagae")
    if r.spooled or not is_open():
        return OpenResult(False, error=f"first_party 개방을 원장에 쓰지 못했다({r.reason or 'not_open'}). 보관 항목은 그대로다. 다시 실행한다")
    dr = drain("fp-held")
    if dr["left"]:
        return OpenResult(False, mode=mode, drained=dr["loaded"], failed=dr["failed"],
                          error=f"보관 항목 {dr['left']}건이 남았다. 다시 실행한다")
    return OpenResult(True, mode=mode, drained=dr["loaded"], failed=dr["failed"])
