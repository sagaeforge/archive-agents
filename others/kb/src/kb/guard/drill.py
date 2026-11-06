"""복원 훈련과 복원(ADR 17.3, 17.4).

- restore_ledger: 원장 사본(또는 내보내기)에서 체인 검증, 앵커 대조, 유실 범위 기록, schema.epoch_bumped를 한 번에 한다.
  복원은 앵커 유무와 무관하게 항상 epoch을 올린다(로컬 앵커도 복원본과 함께 낡을 수 있다).
- full_restore: restic 대상에서 임시 홈으로 복원 -> 체인 -> 앵커 -> 재구축 -> 지문.
- 통과 기록은 ops.db drill 표에 쓴다. kb fp open이 restore_offsite 행(7일 이내, ok=1)을 본다.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import time
from pathlib import Path

from kb.core import cas, ledger, opsdb, paths
from kb.core.canon import canon_json, sha256_hex
from kb.guard import anchor, ship

DAY_MS = 86_400_000
EVERY = {"check": DAY_MS, "ledger": 7 * DAY_MS, "full": 30 * DAY_MS}


class DrillError(Exception):
    pass


@contextlib.contextmanager
def using_home(home: str | Path):
    """KB_HOME을 잠시 바꾼다. paths.kb_home()이 호출 때마다 환경 변수를 읽으므로 코어 함수가 그대로 쓴다."""
    old = os.environ.get("KB_HOME")
    os.environ["KB_HOME"] = str(home)
    try:
        yield Path(home)
    finally:
        if old is None:
            os.environ.pop("KB_HOME", None)
        else:
            os.environ["KB_HOME"] = old


def drill_dir() -> Path:
    return paths.kb_home() / "drill"


# ---------------------------------------------------------------- 내보내기에서 원장 재구성

def ledger_from_export(dest: Path) -> dict:
    """ledger/export/ 봉인 세그먼트만으로 원장을 다시 만든다. 원장 사본이 없을 때의 평문 복구 경로다.
    줄은 해시 열이 있어 그대로 넣는다. 지워진 줄({"redacted":true})은 본문 없이 들어간다."""
    segs = sorted((r for r in ledger.manifest_rows() if r.get("kind") == "segment"), key=lambda r: r["first_seq"])
    if not segs:
        raise DrillError("내보내기 세그먼트가 없다")
    c = ledger.open_ledger(dest)
    n = 0
    try:
        c.execute("BEGIN IMMEDIATE")
        prev_hash, prev_seq = ledger.GENESIS, 0
        versions: dict[str, int] = {}
        redacts: list[list[str]] = []
        for seg in segs:
            path = ledger.export_dir() / seg["file"]
            blob = path.read_bytes()
            want = ledger.segment_sha(seg["file"])
            if want and sha256_hex(blob) != want:
                raise DrillError(f"세그먼트 봉인 불일치: {seg['file']}")
            if seg["first_seq"] != prev_seq + 1:
                raise DrillError(f"세그먼트 사이에 빈 구간: {prev_seq} 다음이 {seg['first_seq']}")
            for ln in ledger.read_segment(seg["file"]):
                if ln["seq"] != prev_seq + 1 or ln["prev_hash"] != prev_hash or ledger.row_hash(ln) != ln["hash"]:
                    raise DrillError(f"체인 불일치 seq={ln['seq']}: {seg['file']}")
                pl = ln["payload"]
                if not ledger._marked(ln):
                    body = canon_json(pl)
                    if sha256_hex(body) != ln["payload_sha"]:
                        raise DrillError(f"본문 해시 불일치 seq={ln['seq']}")
                    if not c.execute("SELECT 1 FROM payload WHERE sha=?", (ln["payload_sha"],)).fetchone():
                        c.execute("INSERT INTO payload(sha, body) VALUES(?,?)", (ln["payload_sha"], body))
                c.execute(f"INSERT INTO event({','.join(ledger.EVENT_COLS)}) VALUES({','.join('?' * len(ledger.EVENT_COLS))})",
                          tuple(ln[k] for k in ledger.EVENT_COLS))
                k = ln["kind"]
                if k in ledger.RECORD_KINDS:
                    versions[ln["subject"]] = versions.get(ln["subject"], 0) + 1
                    c.execute("INSERT INTO record_head(id,version,content_sha) VALUES(?,?,?) "
                              "ON CONFLICT(id) DO UPDATE SET version=excluded.version, content_sha=excluded.content_sha",
                              (ln["subject"], versions[ln["subject"]], ln["payload_sha"]))
                if k == "schema.epoch_bumped":
                    c.execute("UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='epoch'")
                elif k == "system.fp_opened":
                    c.execute("INSERT INTO meta(k,v) VALUES('fp_open',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                              (str(ln["at"]),))
                elif k == "record.redact" and isinstance(pl, dict):
                    redacts.append(pl.get("payload_shas") or [])
                prev_hash, prev_seq = ln["hash"], ln["seq"]
                n += 1
        # 세그먼트를 다시 봉인하기 전에 지워진 본문이 줄에 남아 있을 수 있다. 원장 규칙대로 지운다.
        kill = sorted({s for r in redacts for s in r})
        if kill:
            c.execute("UPDATE meta SET v='1' WHERE k='redact_gate'")
            try:
                c.executemany("DELETE FROM payload WHERE sha=?", [(s,) for s in kill])
            finally:
                c.execute("UPDATE meta SET v='0' WHERE k='redact_gate'")
        c.execute("COMMIT")
    except BaseException:
        if c.in_transaction:
            c.execute("ROLLBACK")
        raise
    finally:
        ledger.flush_wal(c)
        c.close()
    return {"events": n, "segments": len(segs)}


def _copy_file(src: Path, dst: Path) -> None:
    cas.make_dirs(dst.parent)
    cas.unlink_quiet(dst)
    shutil.copyfile(src, dst)
    fd = os.open(dst, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    cas.fsync_dir(dst.parent)


# ---------------------------------------------------------------- 원장 복원

def _merge_anchors(extra: list[str | Path] | None) -> list[dict]:
    seen, out = set(), []
    for src in [anchor.anchors_path(), *(extra or [])]:
        for a in anchor.read_anchors(src):
            key = (a["seq"], a["head_hash"])
            if key not in seen:
                seen.add(key)
                out.append(a)
    return out


def restore_ledger(copy: str | Path | None = None, *, from_export: bool = False,
                   anchors: list[str | Path] | None = None, between=None, force: bool = False) -> dict:
    """현재 KB_HOME의 ledger/ledger.db를 복원한다. between(led, info)는 epoch을 올리기 전에 부른다(재구축, 지문)."""
    dst = ledger.ledger_path()
    if dst.exists() and not force:
        raise DrillError(f"원장이 이미 있다: {dst} (덮어쓰지 않는다)")
    if not from_export and copy is None:
        raise DrillError("원장 사본 경로(--ledger) 또는 --from-export가 필요하다")
    tmp = dst.parent / ".tmp-restore.db"
    cas.make_dirs(dst.parent)
    for suf in ("", "-wal", "-shm"):
        cas.unlink_quiet(Path(str(tmp) + suf))
    info: dict = {"source": "export" if from_export else "copy"}
    if from_export:
        info["export"] = ledger_from_export(tmp)
    else:
        _copy_file(Path(copy), tmp)
    led = ledger.open_ledger(tmp)
    try:
        vr = ledger.verify_chain(led)
        integ = ledger.integrity(led)
        info["chain"] = {"ok": bool(vr.ok), "events": vr.events, "head_seq": vr.head_seq, "errors": list(vr.errors)[:10]}
        info["integrity"] = integ[:10]
        ledger.flush_wal(led)
    finally:
        led.close()
    if not info["chain"]["ok"] or info["integrity"]:
        bad = dst.parent / "ledger.db.bad"
        os.replace(tmp, bad)
        info.update(ok=False, error="체인 또는 무결성 검사 실패", bad=str(bad))
        return info
    for suf in ("-wal", "-shm"):
        cas.unlink_quiet(Path(str(tmp) + suf))
    if force:
        for suf in ("", "-wal", "-shm"):
            cas.unlink_quiet(Path(str(dst) + suf))
    os.replace(tmp, dst)
    cas.fsync_dir(dst.parent)
    led = ledger.open_ledger()
    try:
        ac = anchor.check(led, _merge_anchors(anchors))
        info["anchor"] = ac
        if between is not None:
            info["between"] = between(led, info)
        lost = ac["lost"]
        payload = {"reason": "restore"}
        if lost:
            payload.update(lost_from_seq=lost["from_seq"], lost_to_seq=lost["to_seq"])
        seq, h = ledger.head(led)
        r = ledger.append(led, [{"kind": "schema.epoch_bumped", "actor": "system:restore", "origin": "system",
                                 "idem_key": f"epoch-bump:restore:{seq}:{h[:16]}", "payload": payload}])[0]
        info["epoch_event_seq"] = r["seq"]
        info["epoch"] = int(ledger.meta_get(led, "epoch") or 0)
        info["lost"] = lost
    finally:
        led.close()
    if lost:
        oc = opsdb.connect()
        try:
            opsdb.record_incident(oc, "restore_loss",
                                  f"복원본이 앵커보다 뒤: seq {lost['from_seq']}..{lost['to_seq']} ({lost['count']}건) 유실")
        finally:
            oc.close()
    info["ok"] = not ac["mismatch"]
    return info


# ---------------------------------------------------------------- restic에서 복원

def snapshot_home(t: ship.Target, secrets: dict) -> str:
    """최신 T0 스냅샷의 경로에서 원본 KB_HOME을 찾는다."""
    r = ship.run_restic(t, ["snapshots", "--host", "kb", "--tag", "t0", "--latest", "1", "--json"], secrets)
    snaps = json.loads(r.stdout or "[]")
    for s in snaps:
        for p in s.get("paths") or []:
            if p.endswith("/ship/ledger.db") or p.endswith("/ship/ship.json"):
                return str(Path(p).parent.parent)
    raise DrillError(f"{t.id}: t0 스냅샷이 없다")


def restore_tiers(t: ship.Target, secrets: dict, root: Path, tiers: tuple) -> dict:
    """root/<원본 경로>로 복원한다. 돌려주는 값은 복원된 KB_HOME."""
    src_home = snapshot_home(t, secrets)
    missing = []
    for tier in tiers:
        try:
            ship.run_restic(t, ["restore", "latest", "--host", "kb", "--tag", tier, "--target", str(root),
                                "--retry-lock", ship.RETRY_LOCK], secrets)
        except ship.ResticError as e:
            if tier == "t0":
                raise
            missing.append({"tier": tier, "error": str(e)[:200]})
    return {"home": str(root) + src_home, "src_home": src_home, "missing_tiers": missing}


def _rebuild_and_fp(led, info: dict) -> dict:
    """복원된 원장으로 gold를 다시 만들고 ship.json의 기준 지문과 대조한다. epoch을 올리기 전에 돈다."""
    from kb.commands.rebuild import record_missing
    from kb.project import current_gold_path, fingerprint, rebuild
    out: dict = {}
    res = rebuild(allow_missing=True, led=led)
    out["rebuild"] = {"swapped": res.swapped, "rolled_back": res.rolled_back, "last_seq": res.last_seq,
                      "missing": len(res.missing)}
    if res.missing:
        out["gaps"] = record_missing(led, res.missing)
    gp = current_gold_path()
    fp = fingerprint(gp) if gp else None
    ref = None
    try:
        ref = json.loads((ship.stage_dir() / "ship.json").read_text())
    except (OSError, ValueError):
        pass
    out["fingerprint"] = fp
    if ref and ref.get("gold_fp") and ref.get("head_seq") == res.last_seq and not res.missing:
        out["fp_reference"] = ref["gold_fp"]
        out["fp_match"] = ref["gold_fp"] == fp
    else:
        out["fp_match"] = None  # 기준이 없거나(지문 없는 전송, 머리가 다름) 없는 객체가 있어 비교하지 않는다
    return out


def full_restore(t: ship.Target, secrets: dict, root: Path, *, tiers=("t0", "t1"), rebuild_gold: bool = True) -> dict:
    """restic 대상 -> root 복원 -> 체인 -> 앵커 -> 재구축 -> 지문 -> epoch -> 투영 따라잡기."""
    got = restore_tiers(t, secrets, root, tiers)
    out: dict = {"target": t.id, **got}
    home = Path(got["home"])
    with using_home(home):
        copy = home / "ship" / "ledger.db"
        if copy.exists():
            res = restore_ledger(copy, between=_rebuild_and_fp if rebuild_gold else None)
        else:
            res = restore_ledger(from_export=True, between=_rebuild_and_fp if rebuild_gold else None)
        out.update(res)
        if res.get("ok") and rebuild_gold:
            from kb.write.engine import project_pending
            out["project"] = project_pending()
            from kb.project import current_gold_path
            gp = current_gold_path()
            if gp is not None:
                from kb.core import conn as _c
                g = _c.connect_ro(gp)
                try:
                    r = g.execute("SELECT v FROM meta WHERE k='epoch'").fetchone()
                finally:
                    g.close()
                out["gold_epoch"] = int(r[0]) if r else None
    return out


# ---------------------------------------------------------------- 기록

def record(kind: str, target: str | None, ok: bool, detail: dict | str, *, c=None) -> int:
    own = c is None
    c = c or opsdb.connect()
    try:
        d = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False, sort_keys=True)[:4000]
        cur = c.execute("INSERT INTO drill(at, kind, target, ok, detail) VALUES(?,?,?,?,?)",
                        (int(time.time() * 1000), kind, target, 1 if ok else 0, d))
        return cur.lastrowid
    finally:
        if own:
            c.close()


def _passed(res: dict) -> bool:
    if not res.get("ok"):
        return False
    b = res.get("between") or {}
    if b.get("fp_match") is False:
        return False
    rb = b.get("rebuild")
    if rb and (rb.get("rolled_back") or not rb.get("swapped")):
        return False
    return True


def drill_target(t: ship.Target, secrets: dict, *, level: str = "full", offsite: bool = False,
                 keep: bool = False, ops=None) -> dict:
    """한 대상에서 훈련 한 번. level=ledger는 T0 복원 + 체인 + 앵커, full은 T0+T1 + 재구축 + 지문.
    마운트 확인을 통과하지 못하면 돌지 않는다(기록도 쓰지 않는다)."""
    if t.mount:
        mc = ship.check_mount(t)
        if not mc.ok:
            return {"target": t.id, "ran": False, "ok": False, "reason": f"unavailable:{mc.reason}"}
    own = ops is None
    ops = ops or opsdb.connect()  # 기록은 훈련 홈이 아니라 실제 홈의 ops.db에 쓴다
    scratch = drill_dir() / f"{level}-{int(time.time() * 1000)}"
    cas.make_dirs(scratch)
    try:
        try:
            ship.prep_repo(t, secrets, None)
            res = full_restore(t, secrets, scratch, tiers=("t0", "t1") if level == "full" else ("t0",),
                               rebuild_gold=(level == "full"))
            ok = _passed(res)
            res["ran"] = True
        except (ship.ShipError, DrillError, ledger.LedgerError, OSError) as e:
            res = {"target": t.id, "ran": True, "ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
            ok = False
        res["ok"] = ok
        kind = ("restore_offsite" if offsite else "restore_full") if level == "full" else "restore_ledger"
        if offsite and level != "full":
            kind = "restore_offsite_ledger"
        record(kind, t.id, ok, {k: v for k, v in res.items() if k in ("chain", "anchor", "lost", "between", "error", "epoch")}, c=ops)
        return res
    finally:
        if own:
            ops.close()
        if not keep:
            shutil.rmtree(scratch, ignore_errors=True)


def check_target(t: ship.Target, secrets: dict, *, now_ms: int | None = None, ops=None) -> dict:
    """restic check --read-data-subset n/30. n은 날마다 돌아간다."""
    if t.mount:
        mc = ship.check_mount(t)
        if not mc.ok:
            return {"target": t.id, "ran": False, "ok": False, "reason": f"unavailable:{mc.reason}"}
    n = ((now_ms if now_ms is not None else int(time.time() * 1000)) // DAY_MS) % 30 + 1
    try:
        ship.prep_repo(t, secrets, None)
        ship.run_restic(t, ["check", "--read-data-subset", f"{n}/30", "--retry-lock", ship.RETRY_LOCK], secrets)
        ok, err = True, None
    except ship.ShipError as e:
        ok, err = False, str(e)
    record("restic_check", t.id, ok, {"subset": f"{n}/30", "error": err}, c=ops)
    return {"target": t.id, "ran": True, "ok": ok, "subset": f"{n}/30", "error": err}


def run_due(*, now_ms: int | None = None, budget_s: float | None = None) -> dict:
    """주기: restic check 매일, 원장 복원 매주, 전체 종단 매월. 실패는 기록하고 다음으로 간다."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    end = None if budget_s is None else time.monotonic() + budget_s
    out: list[dict] = []
    try:
        targets, secrets = ship.load_targets(), ship.load_secrets()
    except ship.ShipError as e:
        return {"ran": [], "error": str(e)}
    ops = opsdb.connect()
    try:
        for t in targets:
            for lvl in ("check", "ledger", "full"):
                key = f"drill.last.{lvl}.{t.id}"
                if now - ship.state_int(key, 0, c=ops) < EVERY[lvl]:
                    continue
                if end is not None and time.monotonic() > end:
                    return {"ran": out, "budget": "exhausted"}
                if lvl == "check":
                    r = check_target(t, secrets, now_ms=now, ops=ops)
                else:
                    r = drill_target(t, secrets, level=lvl, offsite=False, ops=ops)
                if r.get("ran"):
                    opsdb.tick_state_set(ops, key, str(now))
                out.append({"target": t.id, "level": lvl, "ran": r.get("ran"), "ok": r.get("ok"),
                            "reason": r.get("reason") or r.get("error")})
    finally:
        ops.close()
    return {"ran": out}
