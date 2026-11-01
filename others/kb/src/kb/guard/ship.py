"""kb ship: 봉인, 원장 사본, restic 전송(ADR 17.1).

대상은 $KB_CONFIG_DIR/targets.yaml, 비밀번호는 $KB_CONFIG_DIR/secrets.env(0600)다. 저장소에 비밀을 넣지 않는다.
머신 밖 대상(external_drive)은 전송 직전마다 마운트를 확인하고, 어긋나면 그 대상만 건너뛴다.
kb는 mount, sudo, /etc/fstab, wsl.conf를 건드리지 않는다.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from kb.core import cas, config, ledger, opsdb, paths
from kb.core import conn as _conn
from kb.core.canon import sha256_hex
from kb.core.gatelock import Gate
from kb.guard import anchor

TIERS = ("t0", "t1", "t3")
EVERY_MS = {"t1": 86_400_000, "t3": 86_400_000}     # T0는 dirty일 때 매 박동
AGE_LIMIT_MS = {"t0": 86_400_000, "t1": 3 * 86_400_000}   # 머신 밖 나이 임계: T0 1일, T1 3일
RETRY_LOCK = "2m"
CHECK_SUBSET = "1/30"
KINDS = ("local", "external_drive")


class ShipError(Exception):
    pass


class ResticError(ShipError):
    def __init__(self, msg: str, rc: int | None = None):
        super().__init__(msg)
        self.rc = rc


# ---------------------------------------------------------------- 설정

@dataclass
class Target:
    id: str
    kind: str
    repo: str
    tiers: tuple = ("t0", "t1", "t3")
    mount: dict | None = None
    copy_from: str | None = None

    @property
    def offsite(self) -> bool:
        return self.kind == "external_drive"


def targets_path() -> Path:
    return paths.config_dir() / "targets.yaml"


def load_targets(path: str | Path | None = None) -> list[Target]:
    p = Path(path) if path else targets_path()
    if not p.exists():
        return []
    try:
        import yaml
    except ImportError as e:  # pyyaml은 collect extra다
        raise ShipError("targets.yaml을 읽으려면 pyyaml이 필요하다(uv sync --extra collect)") from e
    doc = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    out, seen = [], set()
    for i, raw in enumerate(doc.get("targets") or []):
        if not isinstance(raw, dict) or not raw.get("id") or not raw.get("repo"):
            raise ShipError(f"targets.yaml {i + 1}번째 대상: id와 repo가 필요하다")
        kind = raw.get("kind") or "local"
        if kind not in KINDS:
            raise ShipError(f"{raw['id']}: kind는 {KINDS} 중 하나")
        if raw["id"] in seen:
            raise ShipError(f"대상 id 중복: {raw['id']}")
        seen.add(raw["id"])
        default = ("t0", "t1") if kind == "external_drive" else TIERS
        tiers = tuple(raw.get("tiers") or default)
        bad = [t for t in tiers if t not in TIERS]
        if bad:
            raise ShipError(f"{raw['id']}: 알 수 없는 계층 {bad}")
        out.append(Target(raw["id"], kind, str(raw["repo"]), tiers, raw.get("mount"), raw.get("copy_from")))
    return out


def load_secrets(path: str | Path | None = None) -> dict[str, str]:
    p = Path(path) if path else paths.config_dir() / "secrets.env"
    if not p.exists():
        return {}
    if p.stat().st_mode & 0o077:
        raise ShipError(f"{p} 권한이 넓다(0600이어야 한다)")
    out = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def _pw(t_id: str, secrets: dict[str, str]) -> str | None:
    key = "RESTIC_PASSWORD_" + re.sub(r"[^A-Za-z0-9]", "_", t_id).upper()
    return secrets.get(key) or secrets.get("RESTIC_PASSWORD")


# ---------------------------------------------------------------- 마운트 확인

@dataclass
class MountCheck:
    ok: bool
    reason: str | None = None
    detail: dict = field(default_factory=dict)


def findmnt_bin() -> str:
    return os.environ.get("KB_FINDMNT") or "findmnt"


def _norm_source(s: str) -> str:
    return s.rstrip("\\/").upper()


def check_mount(t: Target) -> MountCheck:
    """findmnt -T <경로>의 TARGET, SOURCE, FSTYPE과 저장소의 마커를 본다. OPTIONS는 options_require가 설정된 경우에만 확인한다. 하나라도 어긋나면 ok=False.
    마운트가 빠진 /mnt/e는 ext4의 빈 디렉터리라 그대로 쓰면 ext4에 사본이 생긴다."""
    m = t.mount
    if not m:
        return MountCheck(True)
    mp = str(m.get("path") or "")
    if not mp:
        return MountCheck(False, "mount_config")
    try:
        r = subprocess.run([findmnt_bin(), "-T", mp, "-n", "-J", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"],
                           capture_output=True, text=True, timeout=15)
        fs = json.loads(r.stdout)["filesystems"][0] if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError):
        fs = None
    if not fs:
        return MountCheck(False, "findmnt_failed")
    d = {"target": fs.get("target"), "source": fs.get("source"), "fstype": fs.get("fstype"),
         "options": fs.get("options")}
    if os.path.normpath(str(fs.get("target") or "")) != os.path.normpath(mp):
        return MountCheck(False, "not_mountpoint", d)
    want_src = _norm_source(str(m.get("source") or "E:"))
    if _norm_source(str(fs.get("source") or "")) != want_src:
        return MountCheck(False, "source_mismatch", d)
    opts = set(re.split(r"[,;]", str(fs.get("options") or "")))
    ft = str(m.get("fstype") or "drvfs")
    got = str(fs.get("fstype") or "")
    if ft == "drvfs":
        okfs = got == "drvfs" or (got == "9p" and "aname=drvfs" in opts)
    else:
        okfs = got == ft
    if not okfs:
        return MountCheck(False, "fstype_mismatch", d)
    for need in m.get("options_require") or []:
        if need not in opts:
            return MountCheck(False, f"option_missing:{need}", d)
    marker = m.get("marker")
    if marker:
        mk = Path(t.repo) / marker
        try:
            val = mk.read_text(encoding="utf-8").strip()
        except OSError:
            return MountCheck(False, "marker_missing", d)
        if val != t.id:
            return MountCheck(False, "marker_mismatch", d)
    return MountCheck(True, None, d)


# ---------------------------------------------------------------- ops.db 상태

def _state_conn(create: bool):
    p = opsdb.ops_path()
    if create:
        return opsdb.connect()
    return _conn.connect_ro(p) if p.exists() else None


def state_get(k: str, default: str | None = None, *, c=None) -> str | None:
    own = c is None
    c = c or _state_conn(False)
    if c is None:
        return default
    try:
        r = c.execute("SELECT v FROM tick_state WHERE k=?", (k,)).fetchone()
        return r[0] if r else default
    finally:
        if own:
            c.close()


def state_int(k: str, default: int = 0, **kw) -> int:
    try:
        return int(state_get(k, None, **kw))
    except (TypeError, ValueError):
        return default


def _state_del(c, k: str) -> None:
    c.execute("DELETE FROM tick_state WHERE k=?", (k,))


# ---------------------------------------------------------------- 경로, 표지

def stage_dir() -> Path:
    return paths.kb_home() / "ship"


def tier_paths(tier: str) -> list[Path]:
    """계층별 전송 경로. raw/ttl은 어디에도 없다(머신 밖으로 보내지 않는다)."""
    h = paths.kb_home()
    if tier == "t0":
        cand = [stage_dir() / "ledger.db", stage_dir() / "ship.json", paths.ledger_dir() / "export",
                paths.ledger_dir() / "anchors.ndjson", paths.raw_dir() / "fp", paths.spool_dir(), paths.inbox_dir()]
    elif tier == "t1":
        cand = [paths.raw_dir() / "objects", h / "models", paths.runtime_dir() / "wheels"]
    elif tier == "t3":
        cand = [stage_dir() / "ops.db", paths.ops_dir() / "runs", paths.ops_dir() / "retro"]
    else:
        raise ShipError(f"알 수 없는 계층: {tier}")
    return [p for p in cand if p.exists()]


def _tree_sig(root: Path) -> str:
    h = []
    if not root.exists():
        return ""
    for dp, dns, fns in os.walk(root):
        dns.sort()
        for fn in sorted(fns):
            if fn.startswith(".tmp-"):
                continue
            p = Path(dp) / fn
            try:
                st = p.stat()
            except FileNotFoundError:
                continue
            h.append(f"{p.relative_to(root)}\0{st.st_size}\0{st.st_mtime_ns}")
    return sha256_hex("\n".join(h).encode())


def current_mark() -> str:
    """dirty 판정 표지: 원장 머리 + spool/, inbox/, raw/fp 변경. held 쓰기는 원장을 바꾸지 않으므로 함께 본다."""
    seq, h = 0, ledger.GENESIS
    p = ledger.ledger_path()
    if p.exists():
        c = _conn.connect_ro(p, 30.0)
        try:
            seq, h = ledger.head(c)
        finally:
            c.close()
    parts = [f"{seq}:{h}", _tree_sig(paths.spool_dir()), _tree_sig(paths.inbox_dir()),
             _tree_sig(paths.raw_dir() / "fp"), _tree_sig(paths.ledger_dir() / "export")]
    return sha256_hex("|".join(parts).encode())


# ---------------------------------------------------------------- 사본

def _backup_db(src_path: Path, dst: Path) -> None:
    """SQLite 백업 API로 일관된 사본을 만든다."""
    cas.make_dirs(dst.parent)
    tmp = dst.parent / f".tmp-{dst.name}"
    cas.unlink_quiet(tmp)
    src = _conn.connect_ro(src_path, 600.0)
    out = sqlite3.connect(str(tmp))
    try:
        src.backup(out)
        out.execute("PRAGMA journal_mode=DELETE")
        out.commit()
    finally:
        out.close()
        src.close()
    fd = os.open(tmp, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, dst)
    cas.fsync_dir(dst.parent)
    for suf in ("-wal", "-shm"):
        cas.unlink_quiet(Path(str(tmp) + suf))


def _gold_fp() -> tuple[str | None, int | None]:
    from kb.project import current_gold_path, fingerprint
    gp = current_gold_path()
    if gp is None:
        return None, None
    c = _conn.connect_ro(gp)
    try:
        r = c.execute("SELECT v FROM meta WHERE k='applied_seq'").fetchone()
    finally:
        c.close()
    applied = int(r[0]) if r else None
    return fingerprint(gp), applied


def stage_copies(*, want_ops: bool, fingerprint: bool) -> dict:
    """ship/ledger.db(+ship.json), ship/ops.db를 만든다. 머리와 gold 지문은 훈련의 비교 기준이다."""
    d = stage_dir()
    cas.make_dirs(d)
    info: dict = {"v": 1, "kb_home": str(paths.kb_home()), "at": int(time.time() * 1000),
                  "head_seq": 0, "head_hash": ledger.GENESIS, "gold_fp": None, "gold_applied_seq": None}
    lp = ledger.ledger_path()
    if lp.exists():
        _backup_db(lp, d / "ledger.db")
        c = _conn.connect_ro(d / "ledger.db")
        try:
            info["head_seq"], info["head_hash"] = ledger.head(c)
        finally:
            c.close()
        if fingerprint:
            try:
                info["gold_fp"], info["gold_applied_seq"] = _gold_fp()
            except Exception:  # noqa: BLE001 지문은 훈련의 보조 기준이다. 전송을 막지 않는다
                pass
    if want_ops and opsdb.ops_path().exists():
        _backup_db(opsdb.ops_path(), d / "ops.db")
    cas.atomic_write(d / "ship.json", json.dumps(info, sort_keys=True).encode())
    return info


# ---------------------------------------------------------------- restic

def restic_bin() -> str:
    b = os.environ.get("KB_RESTIC_BIN")
    if b:
        return b
    tc = paths.toolchain_dir() / "bin" / "restic"
    if tc.exists():
        return str(tc)
    return shutil.which("restic") or "restic"


def restic_env(t: Target, secrets: dict[str, str]) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESTIC_")}
    pw = _pw(t.id, secrets)
    if not pw:
        raise ShipError(f"{t.id}: restic 비밀번호가 없다(secrets.env의 RESTIC_PASSWORD)")
    env["RESTIC_REPOSITORY"] = t.repo
    env["RESTIC_PASSWORD"] = pw
    env["RESTIC_CACHE_DIR"] = str(stage_dir() / "restic-cache")
    return env


def run_restic(t: Target, args: list[str], secrets: dict[str, str], *, timeout: float | None = None,
               extra_env: dict | None = None, ok_rc: tuple = (0,)) -> subprocess.CompletedProcess:
    env = restic_env(t, secrets)
    env.update(extra_env or {})
    try:
        r = subprocess.run([restic_bin(), *args], env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise ResticError(f"restic {args[0]} 시간 초과({timeout:.0f}s)") from e
    except OSError as e:
        raise ResticError(f"restic 실행 실패: {e}") from e
    if r.returncode not in ok_rc:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or [""]
        raise ResticError(f"restic {args[0]} rc={r.returncode}: {tail[0][:300]}", r.returncode)
    return r


def init_repo(t: Target, secrets: dict[str, str]) -> dict:
    """저장소 초기화. 머신 밖 대상은 사용자 입회로만 부른다(결정 2). 마운트 1단계(마커 제외)를 먼저 본다."""
    if t.mount:
        probe = Target(t.id, t.kind, t.repo, t.tiers, {k: v for k, v in t.mount.items() if k != "marker"})
        mc = check_mount(probe)
        if not mc.ok:
            raise ShipError(f"{t.id}: 마운트 확인 실패({mc.reason}). 마운트를 확인한다")
    cas.make_dirs(Path(t.repo))
    run_restic(t, ["init"], secrets)
    mk = (t.mount or {}).get("marker")
    if mk:
        cas.atomic_write(Path(t.repo) / mk, (t.id + "\n").encode())
    return {"id": t.id, "repo": t.repo, "marker": mk}


def repo_ready(t: Target, secrets: dict[str, str], timeout: float | None) -> bool:
    try:
        run_restic(t, ["cat", "config", "--retry-lock", RETRY_LOCK], secrets, timeout=timeout)
        return True
    except ResticError:
        return False


def prep_repo(t: Target, secrets: dict[str, str], timeout: float | None) -> None:
    """주기 작업 앞: restic unlock(낡은 잠금만 지운다). 앞 주기가 I/O 오류로 끝났으면 check를 먼저 돈다."""
    run_restic(t, ["unlock", "--retry-lock", RETRY_LOCK], secrets, timeout=timeout)
    if state_get(f"ship.recheck.{t.id}") == "1":
        run_restic(t, ["check", "--read-data-subset", CHECK_SUBSET, "--retry-lock", RETRY_LOCK], secrets,
                   timeout=timeout)
        c = opsdb.connect()
        try:
            _state_del(c, f"ship.recheck.{t.id}")
        finally:
            c.close()


def backup_tier(t: Target, tier: str, secrets: dict[str, str], timeout: float | None) -> dict:
    ps = tier_paths(tier)
    if not ps:
        return {"tier": tier, "skipped": "no_paths"}
    args = ["backup", "--host", "kb", "--tag", tier, "--retry-lock", RETRY_LOCK, "--exclude", ".tmp-*",
            *[str(p) for p in ps]]
    r = run_restic(t, args, secrets, timeout=timeout, ok_rc=(0, 3))  # 3: 읽는 중 사라진 파일. 스냅샷은 만들어졌다
    return {"tier": tier, "paths": [str(p) for p in ps], "partial": r.returncode == 3}


def copy_tier(src: Target, dst: Target, secrets: dict[str, str], timeout: float | None) -> dict:
    env = {"RESTIC_FROM_REPOSITORY": src.repo, "RESTIC_FROM_PASSWORD": _pw(src.id, secrets) or ""}
    run_restic(dst, ["copy", "--host", "kb", "--retry-lock", RETRY_LOCK], secrets, timeout=timeout, extra_env=env)
    return {"copied_from": src.id}


# ---------------------------------------------------------------- 상태 보고

def health(now_ms: int | None = None) -> dict:
    """머신 밖 대상의 나이와 마운트 안내. 대상이 설정된 뒤에만 켜진다(ADR 12장 표)."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    crit, notes = [], []
    try:
        targets = load_targets()
    except ShipError:
        return {"critical": [], "notices": [], "offsite": False}
    off = [t for t in targets if t.offsite]
    c = _state_conn(False)
    try:
        for t in off:
            for tier in ("t0", "t1"):
                if tier not in t.tiers:
                    continue
                last = state_int(f"ship.ok.{t.id}.{tier}", 0, c=c) or state_int(f"ship.seen.{t.id}", 0, c=c)
                if last and now - last > AGE_LIMIT_MS[tier]:
                    crit.append({"code": "offsite_age", "target": t.id, "tier": tier, "age_s": (now - last) // 1000})
            why = state_get(f"ship.unavailable.{t.id}", None, c=c)
            if why:
                notes.append({"code": "offsite_unmounted", "target": t.id, "reason": why})
    finally:
        if c is not None:
            c.close()
    return {"critical": crit, "notices": notes, "offsite": bool(off)}


# ---------------------------------------------------------------- kb ship

def _due(t: Target, mark: str, now: int, c, force: bool = False) -> list[str]:
    if force:
        return [x for x in TIERS if x in t.tiers]
    out = []
    if "t0" in t.tiers and state_get(f"ship.mark.{t.id}", None, c=c) != mark:
        out.append("t0")
    for tier in ("t1", "t3"):
        if tier in t.tiers and now - state_int(f"ship.ok.{t.id}.{tier}", 0, c=c) >= EVERY_MS[tier]:
            out.append(tier)
    return out


def plan(now_ms: int | None = None) -> dict:
    """쓰기 없이 계획을 만든다. 대상이 없으면 targets=[], offsite=False."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    targets = load_targets()
    mark = current_mark()
    c = _state_conn(False)
    rows = []
    try:
        for t in targets:
            mc = check_mount(t) if t.mount else MountCheck(True)
            rows.append({"id": t.id, "kind": t.kind, "offsite": t.offsite, "repo": t.repo,
                         "available": mc.ok, "reason": mc.reason, "due": _due(t, mark, now, c)})
    finally:
        if c is not None:
            c.close()
    return {"targets": rows, "offsite": any(t.offsite for t in targets), "mark": mark,
            "dirty": any(r["due"] for r in rows)}


def seal() -> dict:
    """내보내기 봉인 + 앵커. tick 6.1 단계가 부른다."""
    if not ledger.ledger_path().exists():
        return {"sealed": 0, "anchor": None}
    led = ledger.open_ledger()
    try:
        made = ledger.export_segment(led)
        a = anchor.append_anchor(led)
    finally:
        led.close()
    return {"sealed": len(made), "anchor": a}


def _record_unavailable(t: Target, reason: str) -> None:
    c = opsdb.connect()
    try:
        opsdb.record_metric(c, "target_unavailable", 1, {"target": t.id, "reason": reason})
        if t.offsite:
            opsdb.tick_state_set(c, f"ship.unavailable.{t.id}", reason)
    finally:
        c.close()


def ship(*, if_dirty: bool = False, timeout: float | None = None, dry_run: bool = False,
         fingerprint: bool = False, only: list[str] | None = None, force: bool = False,
         now_ms: int | None = None) -> dict:
    now = int(time.time() * 1000) if now_ms is None else now_ms
    if dry_run:
        pl = plan(now)
        pl.update(ok=True, dry_run=True, **health(now))
        return pl
    deadline = None if timeout is None else time.monotonic() + timeout

    def left() -> float | None:
        return None if deadline is None else max(0.0, deadline - time.monotonic())

    gate = Gate(stage_dir() / "ship.lock")
    try:
        gfd = gate.acquire(0.5)
    except TimeoutError:
        return {"ok": True, "skipped": "busy", "targets": [], "offsite": False, **health(now)}
    try:
        return _ship_locked(now, if_dirty, left, fingerprint, only, force)
    finally:
        gate.release(gfd)


def _ship_locked(now: int, if_dirty: bool, left, fingerprint: bool, only: list[str] | None, force: bool) -> dict:
    res: dict = {"ok": True, "dry_run": False, "targets": [], "sealed": 0, "errors": []}
    try:
        targets = [t for t in load_targets() if not only or t.id in only]
        secrets = load_secrets()
    except ShipError as e:
        return {"ok": False, "targets": [], "offsite": False, "errors": [str(e)], **health(now)}
    res["offsite"] = any(t.offsite for t in targets)
    try:
        sres = seal()
        res["sealed"] = sres["sealed"]
    except Exception as e:  # noqa: BLE001 봉인 실패가 전송을 막지 않는다. 사본의 체인이 증거다
        res["errors"].append(f"seal: {type(e).__name__}: {str(e)[:200]}")
    if not targets:
        res.update(health(now))
        return res
    ops = opsdb.connect()
    try:
        for t in targets:
            if not state_get(f"ship.seen.{t.id}", None, c=ops):
                opsdb.tick_state_set(ops, f"ship.seen.{t.id}", str(now))
        mark = current_mark()
        due = {t.id: _due(t, mark, now, ops, force) for t in targets}
        if if_dirty and not any(due.values()):
            res.update(skipped="clean", targets=[{"id": t.id, "result": "clean"} for t in targets], **health(now))
            return res
        run_id = opsdb.record_run(ops, "ship")
        want_ops = any("t3" in d for d in due.values())
        try:
            info = stage_copies(want_ops=want_ops, fingerprint=fingerprint)
            res["head_seq"] = info["head_seq"]
        except Exception as e:  # noqa: BLE001
            res["ok"] = False
            res["errors"].append(f"stage: {type(e).__name__}: {str(e)[:200]}")
            opsdb.record_run(ops, "ship", run_id=run_id, outcome="failed", detail=res["errors"])
            res.update(health(now))
            return res
        done: dict[str, bool] = {}
        for t in targets:
            r = _ship_target(t, due[t.id], mark, secrets, left, done, ops)
            res["targets"].append(r)
            done[t.id] = r["result"] == "ok"
            if r["result"] == "failed":
                res["ok"] = False
        opsdb.record_run(ops, "ship", run_id=run_id, outcome="ok" if res["ok"] else "failed",
                         detail={"targets": [(x["id"], x["result"]) for x in res["targets"]]})
    finally:
        ops.close()
    res.update(health(now))
    return res


def _ship_target(t: Target, tiers: list[str], mark: str, secrets, left, done: dict, ops) -> dict:
    r: dict = {"id": t.id, "result": "ok", "tiers": []}
    if t.mount:
        mc = check_mount(t)
        if not mc.ok:  # 실패가 아니다. 쓰기 0바이트, target_unavailable과 offsite_unmounted만 남긴다
            _record_unavailable(t, mc.reason or "unavailable")
            return {"id": t.id, "result": "unavailable", "reason": mc.reason, "tiers": []}
    if t.offsite:
        _state_del(ops, f"ship.unavailable.{t.id}")
    if not tiers:
        r["result"] = "clean"
        return r
    now = int(time.time() * 1000)
    try:
        if left() == 0.0:
            raise ResticError("전체 시간 초과")
        prep_repo(t, secrets, left())  # unlock이 저장소를 열어 보는 첫 호출이다. 초기화 전이면 여기서 실패한다
        use_copy = bool(t.copy_from and done.get(t.copy_from))
        if use_copy:
            src = next(x for x in load_targets() if x.id == t.copy_from)
            r["tiers"].append(copy_tier(src, t, secrets, left()))
        else:
            for tier in tiers:
                if left() == 0.0:
                    raise ResticError("전체 시간 초과")
                r["tiers"].append(backup_tier(t, tier, secrets, left()))
        for tier in tiers:
            opsdb.tick_state_set(ops, f"ship.ok.{t.id}.{tier}", str(int(time.time() * 1000)))
        if "t0" in tiers:
            opsdb.tick_state_set(ops, f"ship.mark.{t.id}", mark)
        opsdb.record_metric(ops, "ship_ok", 1, {"target": t.id, "tiers": ",".join(tiers)}, at=now)
    except ShipError as e:  # 한 대상의 실패는 다른 대상을 막지 않는다
        r.update(result="failed", error=str(e))
        opsdb.tick_state_set(ops, f"ship.recheck.{t.id}", "1")
        opsdb.record_metric(ops, "ship_fail", 1, {"target": t.id, "error": str(e)[:200]}, at=now)
    return r
