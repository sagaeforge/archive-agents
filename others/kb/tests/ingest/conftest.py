import importlib.util
import json
from pathlib import Path

import pytest

from kb.core import cas, ids, ledger
from kb.project import rebuild

REPO = Path(__file__).resolve().parents[2]
FX = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME + 임시 설정 + KB_SHARE(schemas, sources는 저장소 것). 실제 네트워크는 시험에서 막는다."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    share.mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources").symlink_to(REPO / "sources")
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def seed_snapshots() -> dict:
    spec = importlib.util.spec_from_file_location("seed_first_batch", FX / "seed_first_batch.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m.seed()


def capture(url, body: bytes, ctype="text/markdown", source="src:adhoc", fetched_at=1_793_000_000_000):
    from kb.write import commit
    from kb.write.engine import project_pending
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": ["G"], "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    project_pending()
    return sid


def bundle(items, producer="agent:kb-collector", batch="t-1", domain=("G",), **hdr):
    h = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": batch, "producer": producer, "domain": list(domain),
         "created_at": "2026-11-01T00:00:00Z", **hdr}
    return [h, *items]


def run(items, *, write=False, fetch=False, **kw):
    from kb import ingest
    fn = ingest.submit if write else ingest.validate
    return fn(bundle(items, **kw), fetch=fetch)


def res(rep, ref):
    return next(r for r in rep.lines if r.get("ref") == ref)


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path())


def event_count():
    led = ledger.open_ledger()
    try:
        return led.execute("SELECT count(*) FROM event").fetchone()[0]
    finally:
        led.close()


def queue_rows(kind):
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind=? ORDER BY ref", (kind,))]
    finally:
        c.close()


def write_jsonl(path: Path, objs) -> Path:
    path.write_text("\n".join(json.dumps(o, ensure_ascii=False) for o in objs) + "\n", encoding="utf-8")
    return path
