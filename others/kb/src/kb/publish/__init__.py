"""스냅샷 export 게시(WP-10, 계약 5장).

publish/<build>/{core,full}.json.zst + manifest.json 을 만들고 `current` symlink를 rename으로 바꾼다.
- 컬럼 배열 JSON을 zstd로 압축한다. sha256과 bytes는 전송 바이트(압축본) 기준이다.
- 민감도 internal 이하만 낸다. SQLite 사본을 만들지 않는다. WAL 체크포인트를 건드리지 않는다.
- 변경이 있을 때 최소 5분 간격(MIN_INTERVAL_S)으로만 게시한다.
읽기는 요청마다 `current`를 한 번 풀어 한 폴더에서만 읽는다. 게시 중 교체는 읽기 오류를 만들지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from compression import zstd

from kb.core import paths
from kb.core.gatelock import Gate
from kb.read import ReadCtx, reading
from kb.read import ctx as RC
import importlib
RE = importlib.import_module("kb.read.envelope")  # kb.read.envelope는 함수 이름이 하위 모듈을 가린다
from kb.read.catalog import catalog
from kb.read.ctx import OK_VERIFICATION, visibility_sql

MIN_INTERVAL_S = 300
KEEP_DIRS = 3
NODE_COLS = ["id", "type", "label", "origin", "status", "domain", "merged_into"]
EDGE_COLS = ["id", "src", "dst", "rtype", "status"]
CORE_NODE_GROUPS = ("world", "user")
CORE_EDGE_GROUPS = ("structure", "user", "change", "fact")
CHUNK = 1 << 20


def publish_dir() -> Path:
    return paths.kb_home() / "publish"


@dataclass
class Published:
    dir: Path
    manifest: dict

    def path(self, profile: str) -> Path:
        return self.dir / f"{profile}.json.zst"

    def read(self, profile: str) -> bytes:
        with open(self.path(profile), "rb") as f:   # 열린 fd는 prune, 교체와 무관하게 끝까지 읽힌다
            return f.read()


def current() -> Published | None:
    """현재 게시. 없으면 None. symlink를 한 번 풀어 그 폴더에서만 읽는다."""
    link = publish_dir() / "current"
    for _ in range(3):   # 읽는 사이 교체돼도 다시 시도한다
        try:
            d = publish_dir() / os.readlink(link)
            with open(d / "manifest.json", "rb") as f:
                return Published(d, json.loads(f.read()))
        except (FileNotFoundError, NotADirectoryError):
            return None
        except (OSError, ValueError):
            time.sleep(0.01)
    return None


# ------------------------------------------------------------------ 쓰기

class _Out:
    """zstd 스트림에 JSON 조각을 모아 쓴다. 메모리에 전체를 쌓지 않는다."""

    def __init__(self, path: Path):
        self.f = zstd.ZstdFile(path, "wb", level=3)
        self.buf: list[str] = []
        self.n = 0

    def put(self, s: str) -> None:
        self.buf.append(s)
        self.n += len(s)
        if self.n >= CHUNK:
            self.flush()

    def flush(self) -> None:
        if self.buf:
            self.f.write("".join(self.buf).encode("utf-8"))
            self.buf, self.n = [], 0

    def close(self) -> None:
        self.flush()
        self.f.close()


def _j(x) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def _sha_size(p: Path) -> tuple[str, int]:
    h, n = hashlib.sha256(), 0
    with open(p, "rb") as f:
        while b := f.read(CHUNK):
            h.update(b)
            n += len(b)
    return h.hexdigest(), n


def _ver_clause(a: str = "n") -> tuple[str, list]:
    return f"({a}.type<>'Claim' OR {a}.verification IN ({','.join('?' * len(OK_VERIFICATION))}))", list(OK_VERIFICATION)


def _write_profile(con, profile: str, out: Path, head: dict, groups: dict, edge_groups: dict) -> tuple[int, int]:
    """한 프로필 파일을 쓴다. (노드 수, 엣지 수)."""
    core = profile == "core"
    types = [t for t, g in groups.items() if t == "Series" or g in CORE_NODE_GROUPS] if core else list(groups)
    ctx = ReadCtx.build(status="active" if core else "all", edge_status="active" if core else "all", deadline_s=3600.0,
                        types=types or ["\0none"])
    if core:
        nw, np_ = visibility_sql(ctx, "n")
    else:
        nw, np_ = visibility_sql(ctx.with_(types=None), "n", mode="direct")
        vc, vp = _ver_clause()
        nw += " AND " + vc
        np_ = np_ + vp
    fin = {r["id"]: r["merged_into_final"] for r in con.execute(
        "SELECT id, merged_into_final FROM head WHERE merged_into_final IS NOT NULL")}
    doms: dict[str, list] = {}
    for nid, d in con.execute("SELECT node_id, domain FROM node_domain ORDER BY node_id, domain"):
        doms.setdefault(nid, []).append(d)
    w = _Out(out)
    hdr = _j(head)[:-1]    # '}' 를 떼고 이어 붙인다
    w.put(hdr + ',"nodes":{"columns":' + _j(NODE_COLS) + ',"rows":[')
    ids: set[str] = set()
    first = True
    for r in con.execute(f"SELECT n.id, n.type, n.label, n.origin, n.eff_status, n.merged_into FROM node n WHERE {nw} ORDER BY n.id", np_):
        ids.add(r[0])
        w.put(("" if first else ",") + _j([r[0], r[1], r[2], r[3], r[4], doms.get(r[0], []), r[5]]))
        first = False
    nn = len(ids)
    w.put(']},"edges":{"columns":' + _j(EDGE_COLS) + ',"rows":[')
    ew, ep = visibility_sql(ctx, "e", kind="edge")
    ne, first = 0, True
    for r in con.execute(f"SELECT e.id, e.src, e.dst, e.rtype, e.status FROM edge e WHERE {ew} ORDER BY e.id", ep):
        src, dst = r[1], r[2]
        if core:
            if edge_groups.get(r[3], "fact") not in CORE_EDGE_GROUPS:
                continue
            fs, fd = fin.get(src, src), fin.get(dst, dst)
            if fs == fd and src != dst:    # 병합이 만든 자기 고리
                continue
            src, dst = fs, fd
        if src not in ids or dst not in ids:    # 허공 엣지 없음
            continue
        w.put(("" if first else ",") + _j([r[0], src, dst, r[3], r[4]]))
        first = False
        ne += 1
    w.put("]}}")
    w.close()
    return nn, ne


def publish(*, force: bool = False, min_interval_s: float = MIN_INTERVAL_S, db_path=None, now_ms: int | None = None) -> dict:
    """게시 한 번. 반환: {published, reason, build_id, ...}. reason: ok | unchanged | min_interval | busy."""
    root = publish_dir()
    root.mkdir(parents=True, exist_ok=True)
    gate = Gate(root / ".lock")
    try:
        fd = gate.acquire(0.5)
    except TimeoutError:
        return {"published": False, "reason": "busy"}
    try:
        return _publish_locked(root, force, min_interval_s, db_path, now_ms)
    finally:
        gate.release(fd)


def _publish_locked(root: Path, force: bool, min_interval_s: float, db_path, now_ms: int | None) -> dict:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    cur = current()
    ctx = ReadCtx.build(db_path=db_path, deadline_s=3600.0)
    with reading(ctx) as con:
        gm = RE.gold_meta(con)
        seq = int(gm.get("applied_seq") or 0)
        epoch = RE.epoch_of(con)
        if cur and not force:
            m = cur.manifest
            if m["applied_seq"] == seq and m["epoch"] == epoch:
                return {"published": False, "reason": "unchanged", "build_id": m["build_id"]}
            gen = _parse_iso_ms(m["generated_at"])
            if gen is not None and now_ms - gen < min_interval_s * 1000:
                return {"published": False, "reason": "min_interval", "build_id": m["build_id"]}
        build_id = f"p-{seq:09d}"
        cat = catalog(con, ctx)
        groups = {t["name"]: t["group"] for t in cat["node_types"]}
        edge_groups = {t["name"]: t["group"] for t in cat["edge_types"]}
        head = {"schema_version": RE.SCHEMA_VERSION, "build_id": build_id, "applied_seq": seq, "epoch": epoch,
                "data_as_of": RC.iso(RE.data_as_of(con, seq)), "graph": {"directed": True, "multi": True}}
        tmp = root / f".tmp-{os.getpid()}-{now_ms}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        try:
            profiles = {}
            for prof in ("core", "full"):
                nn, ne = _write_profile(con, prof, tmp / f"{prof}.json.zst", head, groups, edge_groups)
                sha, size = _sha_size(tmp / f"{prof}.json.zst")
                profiles[prof] = {"path": f"/v1/export/graph?profile={prof}", "bytes": size, "sha256": sha, "nodes": nn, "edges": ne}
            manifest = {"build_id": build_id, "applied_seq": seq, "epoch": epoch, "generated_at": RC.iso(now_ms - now_ms % 1000),
                        "changes_cursor": RE.changes_cursor(con), "profiles": profiles}
            (tmp / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode())
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
    name, n = build_id, 1
    while (root / name).exists():
        n += 1
        name = f"{build_id}.{n}"
    os.rename(tmp, root / name)
    link_tmp = root / ".current.new"
    try:
        os.unlink(link_tmp)
    except FileNotFoundError:
        pass
    os.symlink(name, link_tmp)
    os.replace(link_tmp, root / "current")     # 읽는 쪽은 옛 폴더나 새 폴더 둘 중 하나만 본다
    prune(root)
    return {"published": True, "reason": "ok", "build_id": build_id, "dir": name, "profiles": profiles}


def _parse_iso_ms(s: str) -> int | None:
    try:
        return RC.parse_ts(s)
    except RC.BadParam:
        return None


def prune(root: Path | None = None, keep: int = KEEP_DIRS) -> list[str]:
    """오래된 게시 폴더와 남은 임시 폴더를 지운다. current가 가리키는 폴더는 남긴다."""
    root = root or publish_dir()
    removed = []
    try:
        cur = os.readlink(root / "current")
    except OSError:
        cur = None
    dirs = sorted((d for d in root.iterdir() if d.is_dir() and d.name.startswith("p-")), key=lambda d: d.stat().st_mtime, reverse=True)
    for d in dirs[keep:]:
        if d.name != cur:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d.name)
    for d in root.iterdir():
        if d.is_dir() and d.name.startswith(".tmp-") and time.time() - d.stat().st_mtime > 3600:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d.name)
    return removed
