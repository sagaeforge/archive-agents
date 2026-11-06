import shutil
from pathlib import Path

import pytest

from kb.core import cas, ids, ledger
from kb.project import rebuild

REPO = Path(__file__).resolve().parents[2]
FX = Path(__file__).resolve().parent / "fixtures"

TRENDS_URL = "https://trends.google.com/trending/rss?geo=KR"
SUGGEST_KO = "https://www.google.com/complete/search?client=firefox&hl=ko&q=%EC%9C%A0%ED%8A%9C%EB%B8%8C%20%EC%A0%9C%EB%AA%A9"
SUGGEST_EN = "https://www.google.com/complete/search?client=firefox&hl=en&q=youtube%20thumbnail"


def fx(name: str) -> bytes:
    return (FX / name).read_bytes()


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME + 저장소의 sources(overlay 포함)와 schemas를 쓰는 KB_SHARE."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    (cfg / "decisions.toml").write_text("approved = [1]\n")
    share = kb_home / "share"
    share.mkdir()
    shutil.copytree(REPO / "sources", share / "sources")
    (share / "schemas").symlink_to(REPO / "schemas")
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


def capture(url, body: bytes, ctype, source, fetched_at=1_793_500_000_000):
    from kb.write import commit
    sha = cas.put(body)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": source, "url": url, "raw_sha": sha, "content_type": ctype,
         "bytes": len(body), "fetched_at": fetched_at, "domain": ["A"], "tier": "objects"}
    commit([{"kind": "snapshot.captured", "actor": "collector", "origin": "external", "idem_key": f"snapshot:{sid}",
             "subject": sid, "payload": p}], "collector")
    return p


def gold():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    return connect_ro(current_gold_path())
