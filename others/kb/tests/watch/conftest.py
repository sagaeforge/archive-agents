import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tests" / "project"))   # projhelp: 이벤트 만들기

from kb.core import ledger, opsdb  # noqa: E402
from kb.project import rebuild  # noqa: E402

CLASSES = {"jitter": 0.0, "classes": {
    "rel": {"interval_s": 3600, "stale_s": 86400, "retroactive": True},
    "docs": {"interval_s": 86400, "stale_s": 259200, "retroactive": False}}}
NOW = 1_800_000_000_000
H = 3_600_000
HOUR_S = 3600


def mk_source(sid, domain=("A",), cls="rel", enabled=True, **policy):
    pol = {"enabled": enabled, "tos": "allowed", "tos_ref": "https://t.example/tos", "robots": "enforce",
           "requires_decision": None, "trust": "primary", "retention": "permanent", "pii": False, "needs_contact": False}
    pol.update(policy)
    return {"id": sid, "name": sid, "domain": list(domain), "class": cls,
            "fetch": {"kind": "https", "url": f"https://{sid.replace(':', '-')}.example/x"}, "policy": pol}


@pytest.fixture
def env(kb_home, monkeypatch):
    """임시 KB_HOME, 설정 폴더, KB_SHARE(sources는 시험용, schemas는 저장소 것). 빈 원장 + 첫 gold."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    (share / "sources" / "domains").mkdir(parents=True)
    (share / "sources" / "overlays").mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources" / "classes.yaml").write_text(yaml.safe_dump(CLASSES))
    (share / "sources" / "host-policy.yaml").write_text(yaml.safe_dump({"deny": ["youtube.com"]}))
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


@pytest.fixture
def approve(env):
    def f(*nums):
        (env.cfg / "decisions.toml").write_text("approved = [" + ", ".join(map(str, nums)) + "]\n")
    return f


@pytest.fixture
def set_registry(env):
    def put(sources):
        (env.share / "sources" / "domains" / "t.yaml").write_text(yaml.safe_dump({"sources": sources}, allow_unicode=True))
    return put


@pytest.fixture
def tick_state(env):
    def put(**kv):
        c = opsdb.connect()
        try:
            for k, v in kv.items():
                opsdb.tick_state_set(c, k.replace("__", "."), v)
        finally:
            c.close()
    return put


@pytest.fixture
def ops(env):
    c = opsdb.connect()
    yield c
    c.close()


def codes(items):
    return [x["code"] for x in items]
