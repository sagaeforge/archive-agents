import os
from pathlib import Path

import pytest
import yaml

from kb.core import ledger
from kb.project import rebuild

from .fakenet import FakeClock, World

REPO = Path(__file__).resolve().parents[2]
CLASSES = {"jitter": 0.0, "classes": {
    "rel": {"interval_s": 3600, "stale_s": 86400, "retroactive": True},
    "docs": {"interval_s": 86400, "stale_s": 259200, "retroactive": False},
    "short": {"interval_s": 43200, "stale_s": 172800, "retroactive": False},
    "feed": {"interval_s": 3600, "stale_s": 86400, "retroactive": True},
}}


def mk_source(sid, url=None, *, urls=None, discover=None, domain=("A",), cls="rel", enabled=True, **policy):
    fetch = {"kind": "https"}
    if url:
        fetch["url"] = url
    if urls:
        fetch["urls"] = urls
    if discover:
        fetch["discover"] = discover
    pol = {"enabled": enabled, "tos": "allowed", "tos_ref": "https://t.example/tos", "robots": "enforce",
           "requires_decision": None, "trust": "primary", "retention": "permanent", "pii": False, "needs_contact": False}
    pol.update(policy)
    return {"id": sid, "name": sid, "domain": list(domain), "class": cls, "fetch": fetch, "policy": pol}


@pytest.fixture
def env(kb_home, monkeypatch, tmp_path):
    """임시 KB_HOME + 임시 설정 폴더 + 임시 KB_SHARE(sources는 시험용, schemas는 저장소 것)."""
    cfg = kb_home / "config"
    cfg.mkdir()
    monkeypatch.setenv("KB_CONFIG_DIR", str(cfg))
    share = kb_home / "share"
    (share / "sources" / "domains").mkdir(parents=True)
    (share / "sources" / "overlays").mkdir()
    (share / "sources" / "internal.d").mkdir()
    (share / "schemas").symlink_to(REPO / "schemas")
    (share / "sources" / "classes.yaml").write_text(yaml.safe_dump(CLASSES))
    (share / "sources" / "host-policy.yaml").write_text(yaml.safe_dump({
        "deny": ["youtube.com", "googlevideo.com", "suggestqueries.google.com", "trends.google.com", "sec.gov",
                 "netflix.com", "kobaco.co.kr", "denied.example"],
        "budgets": {"api.github.com": 50, "budget.example": 3}}))
    monkeypatch.setenv("KB_SHARE", str(share))
    monkeypatch.delenv("KB_MCP_SESSION", raising=False)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    import kb.collect.capturer as c
    monkeypatch.setattr(c, "_adhoc_done", False)
    return type("Env", (), {"home": kb_home, "cfg": cfg, "share": share})()


@pytest.fixture
def clk(monkeypatch):
    return FakeClock().install(monkeypatch)


@pytest.fixture
def world(monkeypatch, clk, env):
    w = World(clk).install(monkeypatch)
    return w


@pytest.fixture
def set_registry(env):
    def put(sources, overlay=None, name="t.yaml"):
        (env.share / "sources" / "domains" / name).write_text(yaml.safe_dump({"sources": sources}, allow_unicode=True))
        if overlay is not None:
            (env.share / "sources" / "overlays" / "o.yaml").write_text(yaml.safe_dump(overlay))
    return put


@pytest.fixture
def approve(env):
    def f(*nums):
        (env.cfg / "decisions.toml").write_text("approved = [" + ", ".join(map(str, nums)) + "]\n")
    return f


def events(kind=None):
    c = ledger.open_ledger()
    try:
        out = []
        for e in ledger.iter_events(c, 0, 100000):
            if kind is None or e["kind"] == kind:
                out.append(e)
        return out
    finally:
        c.close()


@pytest.fixture(autouse=True)
def _no_live_stage(monkeypatch):
    """6.3 live는 WP-09 소유다. 수집 시험의 fetch 횟수를 세므로 live 단계는 이 시험들에서 뺀다(live 시험은 tests/live)."""
    from kb.collect import tick as T
    orig = T.discover_stages

    def wrapped():
        ok, bad = orig()
        return ({k: v for k, v in ok.items() if k[1] != "live"}, {k: v for k, v in bad.items() if k[1] != "live"})

    monkeypatch.setattr(T, "discover_stages", wrapped)
