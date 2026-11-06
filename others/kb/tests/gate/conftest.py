from pathlib import Path

import pytest

from kb.core import cas, ids, ledger
from kb.project import rebuild

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME + 임시 설정 + KB_SHARE(schemas는 저장소 것, sources는 빈 레지스트리)."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    (share / "sources" / "domains").mkdir(parents=True)
    (share / "sources" / "internal.d").mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    for n in ("classes.yaml", "host-policy.yaml"):
        (share / "sources" / n).write_text((REPO / "sources" / n).read_text())
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def capture(url, body: bytes, ctype="text/plain", source="src:t", fetched_at=1_790_000_000_000):
    from kb.write import commit
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": ["G"], "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    return p


def put_entity(eid, typ, label, domain=("G",), liveness=None, aliases=()):
    from kb.write import commit
    p = {"id": eid, "type": typ, "label": label, "domain": list(domain)}
    if aliases:
        p["aliases"] = list(aliases)
    if liveness:
        p["liveness"] = {"state": liveness, "liveness": liveness, "status": "active"}
    commit([{"kind": "entity.put", "actor": "t", "origin": "external", "subject": eid,
             "idem_key": f"t:ent:{eid}:{liveness}", "payload": p}], "t")


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path())


def queue_rows(kind):
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        return [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind=? ORDER BY ref", (kind,))]
    finally:
        c.close()
