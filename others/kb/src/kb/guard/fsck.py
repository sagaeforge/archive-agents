"""kb fsck (ADR 17.3). 단계마다 주기가 있고 결과를 ops.db tick_state의 fsck.last.<단계>, fsck.fail.<단계>에 남긴다.
watchdog.compute()가 fsck.fail.*을 읽어 치명으로 올린다. 다음 통과가 실패 기록을 지운다.

| 단계 | 검사 | 주기 |
| paths | 경로, 파일시스템, 파일 권한 | 매 tick |
| chain | 체인 전체 + record_head + meta 재생 대조 | 매일 |
| anchor | 앵커 대조(로컬) | 매일 |
| cas | CAS 객체 sha256, 해시 접두사로 30등분해 하루 한 조각 | 매일 1/30 순환 |
| integrity | PRAGMA integrity_check + 체인. 체인과 함께만 판정 | 주 1회 |
| gold_fp | gold 지문 대 재생 | 월 1회 |

8단계(사람이 다른 머신에서 복원)와 7단계(종단 훈련)는 WP-13 drill이다.
"""
from __future__ import annotations

import json
import sqlite3
import time

from kb.core import cas, ledger, opsdb, paths
from kb.core import conn as _conn

DAY_MS = 86_400_000
STEPS = ("paths", "chain", "anchor", "cas", "integrity", "gold_fp")
PERIOD_MS = {"paths": 0, "chain": DAY_MS, "anchor": DAY_MS, "cas": DAY_MS, "integrity": 7 * DAY_MS, "gold_fp": 30 * DAY_MS}
LIVE_ONLY = ("paths", "anchor")        # 실패 기록은 watchdog이 호출 때 직접 계산한다
CAS_SLICES = 30
VERIFY_DEADLINE_S = 3600.0


def _led():
    p = ledger.ledger_path()
    return _conn.connect_ro(p, VERIFY_DEADLINE_S) if p.exists() else None


def step_paths(**_) -> dict:
    from kb.guard import watchdog
    w = watchdog.W(now=watchdog.now_ms(), uptime=0.0, decisions=set())
    watchdog.check_paths(w)
    return {"ok": not w.crit, "errors": [c.get("detail", c["code"]) for c in w.crit]}


def step_chain(**_) -> dict:
    led = _led()
    if led is None:
        return {"ok": True, "skipped": "ledger_absent", "errors": []}
    try:
        r = ledger.verify_chain(led)
    finally:
        led.close()
    return {"ok": r.ok, "errors": r.errors[:20], "events": r.events, "head_seq": r.head_seq}


def step_anchor(**_) -> dict:
    from kb.guard import anchor
    led = _led()
    if led is None:
        return {"ok": True, "skipped": "ledger_absent", "errors": []}
    try:
        r = anchor.check(led)
    finally:
        led.close()
    errs = [f"앵커 불일치 seq={m['seq']}" for m in r["mismatch"]]
    if r["behind"]:
        errs.append(f"로컬 머리 {r['head_seq']}가 앵커 {r['anchor_seq']}보다 뒤")
    return {"ok": r["ok"], "errors": errs, "anchors": r["anchors"]}


def cas_slice(sha: str) -> int:
    return int(sha[:8], 16) % CAS_SLICES


def step_cas(now: int, cas_full: bool = False, **_) -> dict:
    today = (now // DAY_MS) % CAS_SLICES
    checked, bad = 0, []
    for tier in cas.TIERS:
        for sha in cas.iter_shas(tier):
            if not cas_full and cas_slice(sha) != today:
                continue
            checked += 1
            if not cas.verify(sha, tier):
                bad.append(f"{tier}/{sha}")
    return {"ok": not bad, "errors": bad[:20], "checked": checked, "slice": None if cas_full else today, "bad": len(bad)}


def _integrity(path, name: str) -> list[str]:
    if path is None or not path.exists():
        return []
    c = _conn.connect_ro(path, VERIFY_DEADLINE_S)
    try:
        return [f"{name}: {x}" for x in ledger.integrity(c)]
    finally:
        c.close()


def step_integrity(**_) -> dict:
    from kb.project import current_gold_path
    errs = _integrity(ledger.ledger_path(), "ledger") + _integrity(current_gold_path(), "gold")
    chain = step_chain()
    errs += chain["errors"]
    return {"ok": not errs, "errors": errs[:20], "chain": chain["ok"]}


def step_gold_fp(**_) -> dict:
    from kb.project import current_gold_path, verify_projection
    if current_gold_path() is None or not ledger.ledger_path().exists():
        return {"ok": True, "skipped": "gold_absent", "errors": []}
    r = verify_projection()
    return {"ok": bool(r.get("ok")), "errors": [] if r.get("ok") else [r.get("error") or "gold 지문이 재생과 다르다"],
            **{k: r[k] for k in ("applied_seq", "rebuild_pending") if k in r}}


RUNNERS = {"paths": step_paths, "chain": step_chain, "anchor": step_anchor, "cas": step_cas,
           "integrity": step_integrity, "gold_fp": step_gold_fp}


def _last(c, step: str) -> int:
    r = c.execute("SELECT v FROM tick_state WHERE k=?", (f"fsck.last.{step}",)).fetchone()
    try:
        return int(r[0]) if r else 0
    except ValueError:
        return 0


def due(now: int | None = None) -> list[str]:
    now = int(time.time() * 1000) if now is None else now
    p = opsdb.ops_path()
    if not p.exists():
        return list(STEPS)
    c = _conn.connect_ro(p, 2.0)
    try:
        return [s for s in STEPS if PERIOD_MS[s] == 0 or now - _last(c, s) >= PERIOD_MS[s]]
    except sqlite3.Error:
        return list(STEPS)
    finally:
        c.close()


def run(steps=None, *, force: bool = False, now: int | None = None, cas_full: bool = False) -> dict:
    """steps를 주면 그 단계만, force면 만기와 무관하게, 둘 다 없으면 만기 단계를 돈다."""
    now = int(time.time() * 1000) if now is None else now
    if steps:
        todo = [s for s in STEPS if s in steps]
    elif force:
        todo = list(STEPS)
    else:
        todo = due(now)
    results = []
    for s in todo:
        try:
            r = RUNNERS[s](now=now, cas_full=cas_full)
        except Exception as e:  # noqa: BLE001 단계 하나의 예외가 다음 단계를 막지 않는다
            r = {"ok": False, "errors": [f"{type(e).__name__}: {e}"[:300]]}
        r = {"step": s, **r}
        results.append(r)
    if results:
        c = opsdb.connect()
        try:
            for r in results:
                s = r["step"]
                opsdb.tick_state_set(c, f"fsck.last.{s}", now)
                if s in LIVE_ONLY:
                    continue
                bad = json.dumps({"at": now, "errors": r["errors"]}, ensure_ascii=False) if not r["ok"] else ""
                opsdb.tick_state_set(c, f"fsck.fail.{s}", bad)
        finally:
            c.close()
    return {"ok": all(r["ok"] for r in results), "steps": results, "at": now}
