"""워치독(ADR 12장 표). 침묵을 실패로 드러낸다. 사실만 내고 점수나 순위를 만들지 않는다(지침 5).

compute()는 호출할 때 계산한다. `kb status`와 tick 8단계가 같은 함수를 부르므로 tick이 멈춰도 검사가 돈다.
무거운 검사(체인 전체, CAS 표본, integrity_check)는 fsck.py가 돌리고 결과를 ops.db tick_state의
`fsck.fail.<단계>`에 남긴다. 여기서는 그 결과를 읽어 치명으로 올린다.

tick_state에 쓰는 키(WP-04 envelope.degraded가 읽는다): boot_path_unverified, stale_build,
ledger_head_seq, behind_since_ms. 쓰기는 write_vector()만 한다.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path

from kb.core import config, ledger, opsdb, paths
from kb.core import conn as _conn

# ---- 임계값 (ADR 12장 표)
TICK_STALE_S = 2 * 3600            # last_tick_at 나이
LOCK_HELD_S = 20 * 60              # tick.lock 보유 시간
SILENCE_S = 24 * 3600              # 활성 소스 신규 0, PC 가동 24시간 기준
LAG_WARN_S = 300                   # head > applied_seq 지속
DISK_MIN_FRAC = 0.10
DISK_MIN_BYTES = 50 * 10**9
WAL_LIMIT = {"ledger": 64 << 20, "gold": 256 << 20}
L2_AGE_S = 7 * 86400
DRILL_AGE_S = 35 * 86400
CIRCUIT_LONG_MS = 7 * 86400 * 1000
FAIL_STATES = ("failed", "broken", "blocked", "gone", "suspect")
L2_KINDS = ("l2", "l2s")           # WP-19 큐: 공개 범위 l2, 민감 범위 l2s. ADR 7.11의 l2_para는 이 둘을 가리킨다
DRILL_KINDS = ("restore_full", "restore_offsite")
BOOT_STEPS = (1, 2, 3, 4, 5, 6)    # docs/runbooks/boot-test.md 1~6번
PING_KEYS = {"tick": "HC_PING_TICK", "ship": "HC_PING_SHIP", "drill": "HC_PING_DRILL"}

FSCK_CODES = {"chain": "ledger_chain", "cas": "cas_mismatch", "integrity": "integrity_check",
              "gold_fp": "gold_fingerprint", "paths": "path_error"}


def now_ms() -> int:
    return int(time.time() * 1000)


def uptime_s() -> float:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def disk_usage(path: Path):
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p)


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# ---------------------------------------------------------------- 입력 스냅샷

@dataclass
class W:
    now: int
    uptime: float
    decisions: set
    ts: dict = field(default_factory=dict)
    ops: sqlite3.Connection | None = None
    crit: list = field(default_factory=list)
    warn: list = field(default_factory=list)
    note: list = field(default_factory=list)
    vector: dict = field(default_factory=dict)
    freshness: dict = field(default_factory=dict)

    def ts_int(self, k: str) -> int | None:
        try:
            return int(self.ts[k])
        except (KeyError, TypeError, ValueError):
            return None

    def q(self, sql: str, args=()) -> list:
        if self.ops is None:
            return []
        try:
            return self.ops.execute(sql, args).fetchall()
        except sqlite3.Error:
            return []


def ops_ro():
    p = opsdb.ops_path()
    if not p.exists():
        return None
    try:
        return _conn.connect_ro(p, 2.0)
    except sqlite3.Error:
        return None


def _ro(path: Path | None, deadline: float = 3.0):
    if path is None or not Path(path).exists():
        return None
    return _conn.connect_ro(path, deadline)


def gold_ro():
    from kb.project import current_gold_path
    return _ro(current_gold_path())


def ledger_ro():
    return _ro(ledger.ledger_path())


def item(code: str, **kw) -> dict:
    return {"code": code, **kw}


# ---------------------------------------------------------------- 검사

def check_paths(w: W) -> None:
    try:
        paths.check_fs(paths.kb_home())
    except paths.FsRejected as e:
        w.crit.append(item("path_error", detail=str(e)))
    except OSError:
        pass
    sec = paths.config_dir() / "secrets.env"
    try:
        if sec.exists() and sec.stat().st_mode & 0o077:
            w.crit.append(item("secrets_permission", detail="secrets.env 권한이 넓다(0600이어야 한다)"))
    except OSError:
        pass


def check_tick(w: W) -> None:
    last = w.ts_int("last_tick_at")
    age = (w.now - last) // 1000 if last else None
    lock_pid, since = w.ts.get("lock_pid") or "", w.ts_int("lock_since")
    held = 0
    if lock_pid and since:
        try:
            if pid_alive(int(lock_pid)):
                held = max(0, (w.now - since) // 1000)
        except ValueError:
            pass
    w.freshness.update(last_tick_at=last, last_tick_age_s=age, lock_held_s=held)
    if 3 not in w.decisions:
        w.note.append(item("schedule_missing", detail="타이머가 없다. 수집은 사람이 부를 때만 돈다(결정 3 전)"))
        return
    if age is None or age > TICK_STALE_S:
        w.crit.append(item("tick_stalled", age_s=age, limit_s=TICK_STALE_S))
    if held > LOCK_HELD_S:
        w.crit.append(item("tick_lock_held", held_s=held, limit_s=LOCK_HELD_S))


def _registry():
    from kb.collect import registry
    try:
        return registry.load_registry(validate=False), registry
    except Exception:  # noqa: BLE001 레지스트리 오류는 status 전체를 막지 않는다
        return [], registry


def source_states(w: W) -> dict[str, dict]:
    """source_id -> {states:set, last_ok:int|None}. source_state와 url_state를 합친다."""
    out: dict[str, dict] = {}
    for tbl in ("source_state", "url_state"):
        for sid, state, ok in w.q(f"SELECT source_id, state, last_ok_at FROM {tbl}"):
            d = out.setdefault(sid, {"states": set(), "last_ok": None})
            d["states"].add(state)
            if ok and (d["last_ok"] is None or ok > d["last_ok"]):
                d["last_ok"] = ok
    return out


def check_sources(w: W) -> None:
    srcs, registry = _registry()
    states = source_states(w)
    classes = (registry.load_classes().get("classes") or {}) if srcs else {}
    broken, denied, stale = [], [], []
    for s in srcs:
        if not s.enabled:
            continue
        st = states.get(s.id)
        if not st:
            continue
        if "broken" in st["states"]:
            broken.append(s.id)
        if "robots_denied" in st["states"]:
            denied.append(s.id)
        lim = (classes.get(s.class_ or "") or {}).get("stale_s")
        ok_ = registry.runnable(s)[0]
        if ok_ and lim and st["last_ok"] and w.now - st["last_ok"] > float(lim) * 1000:
            stale.append(s.id)
    w.freshness["stale_sources"] = len(stale)
    if broken:
        w.warn.append(item("source_broken", count=len(broken), sources=sorted(broken)[:20]))
    if denied:
        w.warn.append(item("source_robots_denied", count=len(denied), sources=sorted(denied)[:20]))
    if stale:
        w.warn.append(item("source_stale", count=len(stale), sources=sorted(stale)[:20]))
    long_ = [h for h, state, op, until in w.q("SELECT host, state, opened_at, until_at FROM circuit")
             if state == "open" and until and until > w.now and op and until - op >= CIRCUIT_LONG_MS]
    if long_:
        w.warn.append(item("circuit_7d", count=len(long_), hosts=sorted(long_)[:20]))


def check_silence(w: W) -> None:
    """활성 소스가 있고 전에 수집한 적이 있는데, PC가 24시간 넘게 켜져 있으면서 성공 수집이 24시간 없다."""
    srcs, registry = _registry()
    active = [s for s in srcs if s.enabled and registry.runnable(s)[0]]
    if not active:
        return
    states = source_states(w)
    oks = [d["last_ok"] for sid, d in states.items() if d["last_ok"] and sid in {s.id for s in active}]
    if not oks:
        w.note.append(item("collect_never_ran", detail="활성 소스는 있으나 성공한 수집이 아직 없다", sources=len(active)))
        return
    idle = (w.now - max(oks)) // 1000
    if idle > SILENCE_S and w.uptime >= SILENCE_S:
        w.crit.append(item("collect_silence", idle_s=idle, uptime_s=int(w.uptime), sources=len(active)))


def check_incidents(w: W) -> None:
    rows = w.q("SELECT id FROM incident WHERE acked_at IS NULL ORDER BY id")
    if rows:
        ids = [r[0] for r in rows]
        w.crit.append(item("incident_open", count=len(ids), ids=ids[:20], detail="kb incident ack <id> --note 로 닫는다"))


def check_projection(w: W) -> None:
    head = hh = None
    led = ledger_ro()
    if led is not None:
        try:
            head, hh = ledger.head(led)
        except sqlite3.Error:
            pass
        finally:
            led.close()
    applied = quarantined = None
    g = gold_ro()
    if g is not None:
        try:
            r = g.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()
            applied = int(r[0]) if r else 0
            quarantined = [x[0] for x in g.execute("SELECT seq FROM quarantine ORDER BY seq")]
        except (sqlite3.Error, ValueError):
            pass
        finally:
            g.close()
    w.vector.update(seq=head, head=(hh or "")[:16] or None, applied=applied)
    if quarantined:
        w.crit.append(item("projection_quarantine", count=len(quarantined), seqs=quarantined[:20]))
    if head is None:
        return
    if applied is not None and applied > head:
        w.crit.append(item("gold_ahead", applied_seq=applied, head=head))
    elif head > (applied or 0):
        since = w.ts_int("behind_since_ms")
        prev = w.ts_int("ledger_head_seq")
        if not since or not prev or prev <= (applied or 0):
            since = w.now
        lag = (w.now - since) // 1000
        w.vector["behind_since_ms"] = since
        if lag > LAG_WARN_S:
            w.warn.append(item("projection_lag", head=head, applied_seq=applied or 0, lag_s=lag))


def check_wal(w: W) -> None:
    from kb.project import current_gold_path
    for name, p in (("ledger", ledger.ledger_path()), ("gold", current_gold_path())):
        if p is None:
            continue
        try:
            n = os.path.getsize(str(p) + "-wal")
        except OSError:
            continue
        if n > WAL_LIMIT[name]:
            w.warn.append(item("wal_size", db=name, bytes=n, limit=WAL_LIMIT[name]))


def check_disk(w: W) -> None:
    try:
        du = disk_usage(paths.kb_home())
    except OSError:
        return
    w.vector["disk_free_bytes"] = du.free
    if du.total and (du.free < du.total * DISK_MIN_FRAC or du.free < DISK_MIN_BYTES):
        w.crit.append(item("disk_low", free_bytes=du.free, total_bytes=du.total))


def check_l2(w: W) -> None:
    ph = ",".join("?" * len(L2_KINDS))
    rows = w.q(f"SELECT count(*), min(enqueued_at) FROM queue WHERE kind IN ({ph})", L2_KINDS)
    n, oldest = (rows[0] if rows else (0, None))
    w.vector["queue_l2"] = n or 0
    on = 11 in w.decisions
    if n and oldest and w.now - oldest > L2_AGE_S * 1000:
        age = (w.now - oldest) // 1000
        if on:
            w.warn.append(item("l2_queue_age", age_s=age, count=n))
        else:
            w.note.append(item("l2_not_running", age_s=age, count=n, detail="L2 미가동(결정 11 전)"))
    if on and w.ts.get("l2.canary_ok") == "0":
        w.warn.append(item("l2_canary_failed"))


def check_anchor(w: W) -> None:
    from kb.guard import anchor
    led = ledger_ro()
    if led is None:
        return
    try:
        r = anchor.check(led)
    finally:
        led.close()
    if r.get("mismatch"):
        w.crit.append(item("anchor_mismatch", mismatches=r["mismatch"][:5]))
    if r.get("behind"):
        w.crit.append(item("anchor_behind", head_seq=r["head_seq"], anchor_seq=r["anchor_seq"], lost=r["lost"]))


def check_offsite(w: W) -> None:
    from kb.guard import ship
    try:
        targets = ship.load_targets()
    except ship.ShipError as e:
        w.warn.append(item("targets_invalid", detail=str(e)[:200]))
        return
    off = [t for t in targets if t.offsite]
    if not off:
        w.note.append(item("offsite_missing", detail="머신 밖 사본 대상이 없다(결정 2 전)"))
        if 3 not in w.decisions:
            w.note.append(item("single_copy", detail="데이터 사본이 ext4.vhdx 1벌뿐이다"))
        return
    h = ship.health(w.now)
    w.crit.extend(h.get("critical") or [])
    w.note.extend(h.get("notices") or [])


def check_notices(w: W) -> None:
    steps = {}
    for step, ok in w.q("SELECT step, ok FROM boot_test ORDER BY id"):
        steps[step] = ok       # 단계별 최신 결과
    verified = 3 in w.decisions and all(steps.get(s) == 1 for s in BOOT_STEPS)
    w.vector["boot_path_unverified"] = not verified
    if not verified:
        w.note.append(item("boot_path_unverified", detail="WSL 재부팅 뒤 catch-up 입회 시험을 통과하지 않았다"))
    if 7 not in w.decisions:
        w.note.append(item("mcp_unregistered", detail="kb-mcp가 사용자 범위에 등록되지 않았다(결정 7 전)"))


def check_drill(w: W) -> None:
    ph = ",".join("?" * len(DRILL_KINDS))
    rows = w.q(f"SELECT at, ok FROM drill WHERE kind IN ({ph}) ORDER BY at", DRILL_KINDS)
    if not rows:
        return
    oks = [a for a, ok in rows if ok]
    age = (w.now - max(oks)) // 1000 if oks else None
    if age is None or age > DRILL_AGE_S:
        w.crit.append(item("drill_age", age_s=age, limit_s=DRILL_AGE_S))


def check_fsck_results(w: W) -> None:
    for k, v in sorted(w.ts.items()):
        if not k.startswith("fsck.fail.") or not v:
            continue
        step = k[len("fsck.fail."):]
        try:
            d = json.loads(v)
        except ValueError:
            d = {"errors": [v]}
        w.crit.append(item(FSCK_CODES.get(step, "fsck_" + step), at=d.get("at"), errors=(d.get("errors") or [])[:5]))


CHECKS = (check_paths, check_tick, check_sources, check_silence, check_incidents, check_projection, check_wal,
          check_disk, check_l2, check_anchor, check_offsite, check_notices, check_drill, check_fsck_results)


def compute(now: int | None = None, *, uptime: float | None = None, decisions: set | None = None) -> dict:
    """상태 벡터. 읽기만 한다. {critical, warnings, notices, freshness, vector}."""
    w = W(now=now_ms() if now is None else now, uptime=uptime_s() if uptime is None else uptime,
          decisions=config.decisions() if decisions is None else set(decisions))
    w.ops = ops_ro()
    try:
        w.ts = {k: v for k, v in w.q("SELECT k, v FROM tick_state")}
        for chk in CHECKS:
            try:
                chk(w)
            except Exception as e:  # noqa: BLE001 한 검사의 오류가 다른 검사를 가리지 않는다
                w.warn.append(item("check_error", check=chk.__name__, error=f"{type(e).__name__}: {e}"[:200]))
    finally:
        if w.ops is not None:
            w.ops.close()
    w.vector.update(critical=len(w.crit), warnings=len(w.warn), stale=w.freshness.get("stale_sources", 0))
    w.freshness.setdefault("last_tick_at", None)
    w.freshness.setdefault("last_tick_age_s", None)
    w.freshness.setdefault("stale_sources", 0)
    return {"critical": w.crit, "warnings": w.warn, "notices": w.note, "freshness": w.freshness,
            "vector": w.vector, "at": w.now}


# ---------------------------------------------------------------- tick 기록

def write_vector(res: dict | None = None, now: int | None = None) -> dict:
    """tick 8단계가 부른다. WP-04 envelope.degraded가 읽는 키와 요약을 ops.db tick_state에 남긴다."""
    res = res or compute(now)
    v = res["vector"]
    at = res["at"]
    head, applied = v.get("seq"), v.get("applied")
    behind = head is not None and head > (applied or 0)
    c = opsdb.connect()
    try:
        def put(k, val):
            opsdb.tick_state_set(c, k, val)
        put("watch.at", at)
        put("watch.critical", v["critical"])
        put("watch.warnings", v["warnings"])
        put("boot_path_unverified", "1" if v.get("boot_path_unverified", True) else "0")
        if behind:
            put("ledger_head_seq", head)
            put("behind_since_ms", v.get("behind_since_ms") or at)
            stale = any(x["code"] == "projection_lag" for x in res["warnings"])
            put("stale_build", "1" if stale else "0")
        else:
            put("ledger_head_seq", "")
            put("behind_since_ms", "")
            put("stale_build", "0")
    finally:
        c.close()
    return res


# ---------------------------------------------------------------- 체크포인트 유지

def checkpoint_if_needed(connect=_conn.connect_rw) -> dict:
    """WAL이 임계를 넘은 DB마다 게이트 밖 전용 연결로 RESTART를 한 번 시도한다. 실패하면 다음 tick으로 넘긴다.
    busy_timeout=100이라 쓰기를 막지 않는다."""
    from kb.project import current_gold_path
    out: dict = {}
    for name, p, sync in (("ledger", ledger.ledger_path(), "FULL"), ("gold", current_gold_path(), "NORMAL")):
        if p is None:
            continue
        try:
            size = os.path.getsize(str(p) + "-wal")
        except OSError:
            continue
        if size <= WAL_LIMIT[name]:
            continue
        r = {"wal_bytes": size, "ok": False}
        c = None
        try:
            c = connect(p, sync)
            c.execute("PRAGMA busy_timeout=100")
            r["busy_timeout"] = c.execute("PRAGMA busy_timeout").fetchone()[0]
            row = c.execute("PRAGMA wal_checkpoint(RESTART)").fetchone()
            r["busy"] = row[0] if row else None
            r["ok"] = bool(row) and row[0] == 0
        except sqlite3.Error as e:
            r["error"] = f"{type(e).__name__}: {e}"[:200]
        finally:
            if c is not None:
                c.close()
        out[name] = r
    return out


# ---------------------------------------------------------------- healthchecks 핑

def ping_url(kind: str = "tick") -> str | None:
    from kb.guard import ship
    try:
        return ship.load_secrets().get(PING_KEYS[kind]) or None
    except ship.ShipError:
        return None


def ping_body(res: dict) -> str:
    """상태 벡터만 담는다. 경로, 호스트명, 이메일 등 개인 정보를 넣지 않는다."""
    from kb.core.canon import canon_json
    v = res["vector"]
    return canon_json({"seq": v.get("seq"), "head": v.get("head"), "stale": v.get("stale", 0),
                       "critical": v.get("critical", 0), "warnings": v.get("warnings", 0)}).decode()


def ping(res: dict, kind: str = "tick", fetch=None) -> dict:
    """URL이 없으면 호출 0회. 응답 본문이 정확히 OK가 아니면 실패다(hc-ping.com은 없는 UUID에도 200을 준다)."""
    url = ping_url(kind)
    if not url:
        return {"sent": False, "reason": "no_url"}
    if fetch is None:
        from kb.collect.fetch import safe_fetch as fetch
    body = ping_body(res)
    try:
        r = _post(fetch, url, body)
    except Exception as e:  # noqa: BLE001 핑 실패가 tick을 막지 않는다
        return {"sent": True, "ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
    text = bytes(r.body).decode("utf-8", "replace")
    ok = r.status == 200 and text == "OK"
    return {"sent": True, "ok": ok, "status": r.status, **({} if ok else {"error": "응답 본문이 OK가 아니다"})}


def _post(fetch, url: str, body: str):
    """safe_fetch가 data를 받으면 POST로 상태 벡터를 보낸다. 아직 GET만 되면 GET으로 생존만 알린다."""
    import inspect
    try:
        params = inspect.signature(fetch).parameters
    except (TypeError, ValueError):
        params = {}
    if "data" in params:
        kw = {"data": body.encode()}
        if "method" in params:
            kw["method"] = "POST"
        return fetch(url, **kw)
    return fetch(url)
