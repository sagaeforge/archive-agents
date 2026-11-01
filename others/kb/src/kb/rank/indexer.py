"""벡터 색인 빌드(kb index --incremental). venv-rank에서 돈다: python -I indexer.py [--full] [--json].
gold의 공개 범위 현재 단위를 KURE-v3(1024 절단 int8)로 임베딩해 derived/vec/<build>/에 쓴다.
증분: 이전 색인에서 (ID, 종류, 내용 sha)가 같은 행은 벡터를 재사용한다. 같은 gold 빌드면 건너뛴다. 벡터는 파생물이다."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from kb.core import paths  # noqa: E402
from kb.rank import conf, store, units  # noqa: E402


def gold_db() -> tuple[Path, str] | None:
    link = paths.kb_home() / "derived" / "gold" / "current"
    db = link / "graph.db"
    return (db, os.readlink(link)) if link.is_symlink() and db.exists() else None


def model_tag(stub: bool) -> str:
    return "stub" if stub else f"{conf.MODELS['embed']['rev'][:8]}-d{conf.DIM}"


def _prior(tag: str):
    cur = store.current_root()
    if cur is None:
        return None
    try:
        ix = store.Index(cur)
    except (OSError, ValueError, KeyError):
        return None
    return ix if ix.meta.get("model") == tag and ix.dim == conf.DIM else None


def plan(*, full: bool = False, stub: bool | None = None) -> dict:
    """무엇을 임베딩하고 무엇을 재사용할지만 센다. 모델을 올리지 않고 아무것도 쓰지 않는다."""
    stub = conf.stub() if stub is None else stub
    g = gold_db()
    if g is None:
        return {"ok": True, "skipped": "no_gold"}
    tag = model_tag(stub)
    build = f"v-{g[1]}-{tag}"
    prior = None if full else _prior(tag)
    if prior is not None and prior.build == build:
        return {"ok": True, "skipped": "unchanged", "build": build, "rows": prior.n}
    con = units.open_gold_ro(g[0])
    try:
        us = units.select_units(con)
    finally:
        con.close()
    have = {(i, k, s): n for n, (i, k, s) in enumerate(zip(prior.ids, prior.kinds, prior.shas))} if prior else {}
    reuse = sum(1 for u in us if (u.id, u.kind, u.sha) in have)
    return {"ok": True, "build": build, "rows": len(us), "reused": reuse, "to_embed": len(us) - reuse, "_units": us, "_prior": prior, "_have": have,
            "_tag": tag}


def build(*, full: bool = False, stub: bool | None = None, embedder=None) -> dict:
    t0 = time.monotonic()
    stub = conf.stub() if stub is None else stub
    root = conf.vec_root()
    root.mkdir(parents=True, exist_ok=True)
    lock = open(root / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return {"ok": True, "skipped": "locked"}
    try:
        p = plan(full=full, stub=stub)
        if "skipped" in p:
            return p
        us, prior, have, tag = p.pop("_units"), p.pop("_prior"), p.pop("_have"), p.pop("_tag")
        todo = [u for u in us if (u.id, u.kind, u.sha) not in have]
        rows_new: dict[str, bytes] = {}
        device = "none"
        if todo:
            if embedder is None:
                from kb.rank import models
                embedder = models.StubEmbedder() if stub else models.Embedder(conf.model_path("embed"), models.pick_device())
            device = embedder.device
            for s in range(0, len(todo), 256):
                part = todo[s:s + 256]
                for u, r in zip(part, embedder.encode_q8([u.text for u in part], "document")):
                    rows_new[u.id] = r
            if hasattr(embedder, "close"):
                embedder.close()
        rows = [rows_new[u.id] if u.id in rows_new else prior.row(have[(u.id, u.kind, u.sha)]) for u in us]
        tmp = root / f".tmp-{p['build']}"
        if tmp.exists():
            shutil.rmtree(tmp)
        store.write_index(tmp, p["build"], [u.id for u in us], [u.kind for u in us], [u.sha for u in us], rows,
                          {"model": tag, "embed_rev": None if stub else conf.MODELS["embed"]["rev"], "device": device})
        final = root / p["build"]
        if final.exists():
            shutil.rmtree(final)
        os.rename(tmp, final)
        store.point_current(p["build"])
        prune(keep=2)
        p.update(embedded=len(todo), device=device, elapsed_s=round(time.monotonic() - t0, 2))
        return p
    finally:
        lock.close()


def prune(keep: int = 2) -> list[str]:
    """현재 색인과 최근 keep-1개만 남긴다. 임시 폴더도 지운다."""
    root = conf.vec_root()
    if not root.is_dir():
        return []
    cur = store.current_root()
    dirs = sorted((d for d in root.iterdir() if d.is_dir() and not d.is_symlink() and d.name.startswith("v-")),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    gone = []
    for d in dirs[keep:]:
        if cur is not None and d.resolve() == cur:
            continue
        shutil.rmtree(d, ignore_errors=True)
        gone.append(d.name)
    for d in root.glob(".tmp-*"):
        shutil.rmtree(d, ignore_errors=True)
    return gone


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.dry_run:
        out = {k: v for k, v in plan(full=a.full).items() if not k.startswith("_")}
        out["dry_run"] = True
    else:
        out = build(full=a.full)
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
