"""kb redact: record.redact 실행과 파생 저장소 정리(ADR 7.9 표).

처리 순서: 원장 payload 삭제(+WAL 비우기) -> 봉인 세그먼트 재봉인 -> CAS 객체(다른 레코드가 쓰면 보존, 보고)
-> spool, inbox, ops/runs, 임시 파일 -> 원장 사본(ship/). git 이력과 restic 과거 세대는 별도 단계다(purge_git, purge_restic).
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from compression import zstd

from kb.core import cas, ledger, opsdb, paths, spool
from kb.core.canon import canon_json, sha256_hex
from kb.guard import ship

HEX64 = re.compile(r"[0-9a-f]{64}")
TIER_NAMES = ("objects", "fp", "ttl")
MIN_NEEDLE = 12
FRAG_MIN = 20


class RedactError(Exception):
    pass


# ---------------------------------------------------------------- 수집

def _walk_strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from _walk_strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk_strings(v)


def _collect(led, rid: str) -> dict:
    """지우기 전에 레코드의 이벤트, 본문 해시, CAS 참조, 검색어를 모은다."""
    evs = led.execute("SELECT seq, kind, idem_key, payload_sha FROM event WHERE subject=? ORDER BY seq", (rid,)).fetchall()
    if not evs:
        raise RedactError(f"없는 레코드: {rid}")
    shas = {e[3] for e in evs if e[1] != "record.redact"}
    cas_refs: set[str] = set()
    needles: set[str] = set()
    frags: set[str] = set()
    for s in shas:
        pl = ledger.get_payload(led, s)
        if not pl:
            continue
        for v in _walk_strings(pl):
            if HEX64.fullmatch(v):
                cas_refs.add(v)
        for k in ("body", "title"):
            v = pl.get(k)
            if isinstance(v, str) and len(v) >= MIN_NEEDLE:
                needles.add(v)
        body = pl.get("body") if isinstance(pl.get("body"), str) else None
        if isinstance(pl.get("body_sha"), str):
            try:
                body = cas.get(pl["body_sha"], "fp").decode()
                if len(body) >= MIN_NEEDLE:
                    needles.add(body)
            except (cas.CasError, OSError, UnicodeDecodeError):
                pass
        # 실행 스트림 같은 버리는 기록은 조각으로도 지운다: 본문의 긴 줄과 props의 문자열 값
        for line in (body or "").splitlines():
            if len(line.strip()) >= FRAG_MIN:
                frags.add(line.strip())
        for v in _walk_strings(pl.get("props")):
            if len(v) >= MIN_NEEDLE:
                frags.add(v)
    return {"idem_keys": {e[2] for e in evs}, "seqs": [e[0] for e in evs], "shas": shas,
            "cas_refs": sorted(cas_refs), "needles": sorted(needles), "frags": sorted(frags)[:200]}


# ---------------------------------------------------------------- 단계

def _flush(led, res: dict, tries: int = 3) -> bool:
    """ledger.redact가 이미 한 번 기다렸다(busy_timeout 5초). 읽기 연결이 곧 끝날 수 있어 짧게 몇 번 더 본다."""
    ok = bool(res.get("wal_cleared"))
    if not ok:
        led.execute("PRAGMA busy_timeout=300")
    n = 0
    while not ok and n < tries:
        time.sleep(0.2 * (n + 1))
        ok = ledger.flush_wal(led)
        n += 1
    return ok


def _reseal(led, removed: list[str]) -> list[dict]:
    """지운 본문을 가진 모든 이벤트의 세그먼트를 재봉인한다. 같은 본문이 여러 세그먼트에 있을 수 있다."""
    if not removed:
        return []
    marks = ",".join("?" * len(removed))
    seqs = [r[0] for r in led.execute(f"SELECT seq FROM event WHERE payload_sha IN ({marks}) ORDER BY seq", removed)]
    segs = [r for r in ledger.manifest_rows() if r.get("kind") == "segment"]
    done, out = set(), []
    for s in seqs:
        seg = next((x for x in segs if x["first_seq"] <= s <= x["last_seq"]), None)
        if seg is None or seg["file"] in done:  # 아직 봉인 전이면 다음 내보내기가 표지로 쓴다
            continue
        done.add(seg["file"])
        row = ledger.reseal_segment(led, s)
        if row:
            out.append(row)
    return out


def _other_users(led, sha: str, rid: str) -> list[str]:
    rows = led.execute("SELECT DISTINCT e.subject FROM event e JOIN payload p ON p.sha=e.payload_sha "
                       "WHERE CAST(p.body AS TEXT) LIKE ? AND (e.subject IS NOT ? )", (f"%{sha}%", rid)).fetchall()
    return sorted(r[0] or "(subject 없음)" for r in rows)


def _purge_cas(led, rid: str, refs: list[str]) -> dict:
    deleted, kept = [], []
    for sha in refs:
        tiers = [t for t in TIER_NAMES if cas.exists(sha, t)]
        if not tiers:
            continue
        users = _other_users(led, sha, rid)
        for t in tiers:
            if users:
                kept.append({"sha": sha, "tier": t, "shared_with": users})
            else:
                p = str(cas.path_of(sha, t))
                if cas.delete(sha, t):
                    deleted.append({"sha": sha, "tier": t, "path": p})
    return {"deleted": deleted, "kept": kept}


def _has(data: bytes, needles: list[bytes]) -> bool:
    return any(n in data for n in needles)


def _rewrite_atomic(p: Path, data: bytes) -> None:
    cas.atomic_write(p, data)


def _scrub_spool(rid: str, idem: set[str], needles: list[bytes]) -> dict:
    """spool의 대기 항목에서 그 레코드의 이벤트를 지운다. 다른 레코드의 이벤트는 남긴다(대기 중인 쓰기는 T0 데이터다)."""
    removed, changed = [], []
    root = paths.spool_dir()
    if not root.exists():
        return {"removed": removed, "rewritten": changed}
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name.startswith(".tmp-"):
            continue
        try:
            raw = p.read_bytes()
        except FileNotFoundError:
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            if _has(raw, needles):
                spool.remove(p)
                removed.append(str(p))
            continue
        evs = obj.get("events") if isinstance(obj, dict) else None
        if not isinstance(evs, list):
            if _has(raw, needles):
                spool.remove(p)
                removed.append(str(p))
            continue

        def mine(e) -> bool:
            if not isinstance(e, dict):
                return False
            pl = e.get("payload") if isinstance(e.get("payload"), dict) else {}
            return e.get("subject") == rid or pl.get("id") == rid or e.get("idem_key") in idem

        keep = [e for e in evs if not mine(e)]
        if len(keep) == len(evs):
            continue
        if not keep:
            spool.remove(p)
            removed.append(str(p))
        else:
            obj["events"] = keep
            _rewrite_atomic(p, canon_json(obj))
            changed.append(str(p))
    return {"removed": removed, "rewritten": changed}


def _inbox_hit(text: str, rid: str, needles: list[str]) -> bool:
    head = text[:4096]
    if re.search(rf"^id:\s*[\"']?{re.escape(rid)}[\"']?\s*$", head, re.M):
        return True
    return any(n in text for n in needles)


def _scrub_inbox(rid: str, needles: list[str]) -> list[str]:
    removed = []
    root = paths.inbox_dir()
    if not root.exists():
        return removed
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if _inbox_hit(text, rid, needles):
            os.unlink(p)
            cas.fsync_dir(p.parent)
            removed.append(str(p))
    return removed


def _scrub_runs(rid: str, terms: list[str]) -> dict:
    """ops/runs 스트림의 행을 지운다. .zst는 풀어서 다시 압축한다."""
    removed_rows, files = 0, []
    root = paths.ops_dir() / "runs"
    if not root.exists():
        return {"rows": 0, "files": files}
    pats = set()
    for t in terms:
        if t:  # JSON으로 쓰인 줄은 따옴표, 개행, 비ASCII가 이스케이프된 형태일 수 있다
            pats.update({t.encode(), json.dumps(t)[1:-1].encode(), json.dumps(t, ensure_ascii=False)[1:-1].encode()})
    pats = sorted(pats, key=len)
    for p in sorted(root.glob("*")):
        if not p.is_file() or p.name.startswith(".tmp-"):
            continue
        raw = p.read_bytes()
        zst = p.name.endswith(".zst")
        try:
            data = zstd.decompress(raw) if zst else raw
        except zstd.ZstdError:
            continue
        lines = data.split(b"\n")
        keep = [x for x in lines if not (x and _has(x, pats))]
        gone = sum(1 for x in lines if x) - sum(1 for x in keep if x)
        if gone:
            body = b"\n".join(keep)
            if zst:
                body = zstd.compress(body, options={zstd.CompressionParameter.checksum_flag: 1})
            _rewrite_atomic(p, body)
            removed_rows += gone
            files.append(str(p))
    return {"rows": removed_rows, "files": files}


def _scrub_dlq(shas: set[str], rid: str) -> int:
    p = opsdb.ops_path()
    if not p.exists():
        return 0
    c = opsdb.connect()
    try:
        n = 0
        for s in shas:
            n += c.execute("DELETE FROM dlq WHERE payload_sha=? OR ref LIKE ?", (s, f"%{s}%")).rowcount
        n += c.execute("DELETE FROM dlq WHERE ref=?", (rid,)).rowcount
        return n
    finally:
        c.close()


def sweep_tmp(*, min_age_s: float = 3600.0, needles: list[bytes] | None = None) -> list[str]:
    """크래시가 남긴 .tmp-* 를 치운다(WP-01 3회차 결함 3). spool, raw/*, ship, ledger 아래 전부.
    살아 있는 쓰기의 임시 파일을 지우지 않게 min_age_s 이상 묵은 것만 지운다. 평문이 든 것(needles)은 나이와 무관하다."""
    roots = [paths.spool_dir(), paths.raw_dir(), ship.stage_dir(), paths.ledger_dir(), paths.inbox_dir()]
    now = time.time()
    out = []
    for root in roots:
        if not root.exists():
            continue
        for dp, dns, fns in os.walk(root):
            for fn in fns:
                if not fn.startswith(".tmp-"):
                    continue
                p = Path(dp) / fn
                try:
                    st = p.stat()
                    old = now - st.st_mtime >= min_age_s
                    hit = bool(needles) and _has(p.read_bytes(), needles)
                except FileNotFoundError:
                    continue
                if old or hit:
                    cas.unlink_quiet(p)
                    out.append(str(p))
    return out


def _pending_path(rid: str) -> Path:
    return paths.ops_dir() / "redact" / f"{sha256_hex(rid.encode())[:16]}.json"


# ---------------------------------------------------------------- 진입점

def redact_record(rid: str, reason: str, *, actor: str = "user:sagae", rebuild_gold: bool = False,
                  tmp_age_s: float = 60.0) -> dict:
    """한 레코드를 지운다. 반환의 ok가 False이면 평문이 남았을 수 있다(wal_cleared 등)."""
    if not reason or not reason.strip():
        raise RedactError("사유(--reason)가 필요하다")
    led = ledger.open_ledger()
    try:
        info = _collect(led, rid)
        res = ledger.redact(led, rid, reason.strip(), actor)
        wal = _flush(led, res)
        removed, shared = res.get("removed", []), res.get("shared", [])
        resealed = _reseal(led, removed)
        cas_res = _purge_cas(led, rid, info["cas_refs"])
    finally:
        led.close()
    needles_s = info["needles"]
    needles_b = [n.encode() for n in needles_s]
    sp = _scrub_spool(rid, info["idem_keys"], needles_b)
    ib = _scrub_inbox(rid, needles_s)
    terms = [rid, *info["shas"], *info["cas_refs"], *needles_s, *info["frags"]]
    runs = _scrub_runs(rid, terms)
    dlq = _scrub_dlq(info["shas"] | set(info["cas_refs"]), rid)
    tmp = sweep_tmp(min_age_s=tmp_age_s, needles=needles_b)
    # 원장 사본(ship/)은 지우기 전 평문을 가진다. 다음 전송이 새로 만든다.
    stale = []
    for name in ("ledger.db", "ledger.db-wal", "ledger.db-shm", "ops.db"):
        p = ship.stage_dir() / name
        if p.exists():
            cas.unlink_quiet(p)
            stale.append(str(p))
    deleted = [d["path"] for d in cas_res["deleted"]] + sp["removed"] + ib
    modified = [str(ledger.export_dir() / r["file"]) for r in resealed] + sp["rewritten"] + runs["files"] + stale
    out = {"ok": wal, "id": rid, "wal_cleared": wal, "removed": removed, "shared": shared, "resealed": resealed,
           "cas": cas_res, "spool": sp, "inbox": ib, "runs": runs, "dlq": dlq, "tmp": tmp, "ship_copies": stale,
           "deleted_paths": deleted, "modified_paths": modified}
    if shared or cas_res["kept"]:
        out["shared_report"] = {"payload": shared, "cas": cas_res["kept"]}
    pend = _pending_path(rid)
    cas.atomic_write(pend, json.dumps({"id": rid, "at": int(time.time() * 1000), "deleted_paths": deleted,
                                       "modified_paths": modified}, sort_keys=True).encode())
    try:  # 재구축 전에도 조회가 막히게 gold에 record.redact를 바로 투영한다
        from kb.write.engine import project_pending
        out["project"] = project_pending()
    except Exception as e:  # noqa: BLE001 gold가 없거나 잠겨 있어도 삭제 자체는 끝났다
        out["project"] = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
    if rebuild_gold:
        from kb.project import rebuild
        r = rebuild(allow_missing=True)
        out["rebuild"] = {"swapped": r.swapped, "missing": len(r.missing)}
        if r.swapped:  # 되돌림용으로 남긴 옛 빌드에는 지운 본문이 그대로 있다
            out["old_builds_dropped"] = _drop_old_builds()
    else:
        out["warnings"] = ["gold_not_rebuilt: 다음 재구축 전까지 gold에 지운 본문이 남을 수 있다"]
    return out


def _drop_old_builds() -> list[str]:
    from kb.project import current_build, gold_root
    root, keep, gone = gold_root(), current_build(), []
    for d in sorted(root.iterdir()):
        if d.is_dir() and not d.is_symlink() and not d.name.startswith(".") and d.name != keep:
            shutil.rmtree(d, ignore_errors=True)
            gone.append(d.name)
    return gone


# ---------------------------------------------------------------- git 이력

def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "FILTER_BRANCH_SQUELCH_WARNING": "1"}
    r = subprocess.run(["git", "-C", str(repo), "-c", "user.name=sagae-kb", "-c", "user.email=kb@invalid",
                        "-c", "commit.gpgsign=false", *args], env=env, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RedactError(f"git {args[0]} 실패: {(r.stderr or r.stdout).strip()[:300]}")
    return r


def purge_git(repo: str | Path, rel_paths: list[str]) -> dict:
    """내보내기 git의 모든 이력에서 파일을 지운다(filter-branch). 실행은 사용자 승인 뒤다(런북).
    원격이 있으면 거기에는 이미 퍼졌을 수 있다. 이 함수는 로컬 저장소만 고친다."""
    repo = Path(repo)
    if not (repo / ".git").exists():
        return {"rewritten": False, "reason": "no_git"}
    if not rel_paths:
        return {"rewritten": False, "reason": "no_paths"}
    q = " ".join(shlex.quote(p) for p in rel_paths)
    empty = _git(repo, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode != 0
    if empty:
        return {"rewritten": False, "reason": "no_commits"}
    _git(repo, "filter-branch", "--force", "--index-filter",
         f"git rm -r --cached --ignore-unmatch -q -- {q}", "--prune-empty", "--", "--all")
    refs = _git(repo, "for-each-ref", "--format=%(refname)", "refs/original").stdout.split()
    for r in refs:
        _git(repo, "update-ref", "-d", r)
    _git(repo, "reflog", "expire", "--expire=now", "--all")
    _git(repo, "gc", "--prune=now", "-q")
    return {"rewritten": True, "paths": rel_paths}


# ---------------------------------------------------------------- restic 과거 세대

def _escape_pat(p: str) -> str:
    return re.sub(r"([\\*?\[])", r"\\\1", p)


def purge_restic(target_ids: list[str] | None = None, *, rid: str | None = None,
                 deleted: list[str] | None = None, modified: list[str] | None = None,
                 reship: bool = True) -> dict:
    """restic 과거 세대에서 지운 파일을 뺀다: ship(전 계층 강제) -> rewrite --forget -> prune.
    지운 파일은 모든 스냅샷에서, 바뀐 파일(재봉인한 세그먼트, 새 원장 사본)은 가장 새 스냅샷만 남기고 뺀다.
    E:는 append-only가 아니라 prune이 된다. 마운트 확인을 통과하지 못한 대상은 건너뛴다."""
    if rid and deleted is None:
        pend = json.loads(_pending_path(rid).read_text())
        deleted, modified = pend["deleted_paths"], pend["modified_paths"]
    deleted, modified = list(deleted or []), list(modified or [])
    secrets = ship.load_secrets()
    out = []
    for t in ship.load_targets():
        if target_ids and t.id not in target_ids:
            continue
        mc = ship.check_mount(t)
        if not mc.ok:
            out.append({"target": t.id, "skipped": f"unavailable:{mc.reason}"})
            continue
        if reship:
            sr = ship.ship(only=[t.id], force=True)
            if not sr.get("ok"):
                out.append({"target": t.id, "error": f"ship 실패: {sr.get('errors') or sr.get('targets')}"})
                continue
        ship.run_restic(t, ["unlock", "--retry-lock", ship.RETRY_LOCK], secrets)
        snaps = json.loads(ship.run_restic(t, ["snapshots", "--host", "kb", "--json"], secrets).stdout or "[]")
        newest: dict[str, str] = {}
        for s in sorted(snaps, key=lambda x: x["time"]):
            for tag in s.get("tags") or [""]:
                newest[tag] = s["id"]
        keep_ids = set(newest.values())
        batches = [([s["id"] for s in snaps if s["id"] in keep_ids], deleted),
                   ([s["id"] for s in snaps if s["id"] not in keep_ids], deleted + modified)]
        rewritten = 0
        for ids, pats in batches:
            if not ids or not pats:
                continue
            f = ship.stage_dir() / f".tmp-exclude-{os.getpid()}"
            cas.atomic_write(f, ("\n".join(_escape_pat(x) for x in pats) + "\n").encode())
            try:
                ship.run_restic(t, ["rewrite", "--forget", "--exclude-file", str(f), "--retry-lock",
                                    ship.RETRY_LOCK, *ids], secrets)
                rewritten += len(ids)
            finally:
                cas.unlink_quiet(f)
        ship.run_restic(t, ["prune", "--retry-lock", ship.RETRY_LOCK], secrets)
        out.append({"target": t.id, "rewritten": rewritten, "pruned": True})
    return {"targets": out}
