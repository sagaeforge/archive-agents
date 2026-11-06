"""sources/first-batch.yaml 정의 검사 (WP-21). 네트워크 없음."""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from kb.collect import registry
from kb.parse.adapters import ADAPTERS

REPO = Path(__file__).resolve().parents[2]
BATCH = REPO / "sources" / "first-batch.yaml"
HOSTS = yaml.safe_load((REPO / "sources" / "host-policy.yaml").read_text(encoding="utf-8"))
APPROVED = {1, 2, 3, 7, 8, 9, 10, 11}


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    def put(nums):
        monkeypatch.setenv("KB_CONFIG_DIR", str(tmp_path))
        (tmp_path / "decisions.toml").write_text("approved = [" + ", ".join(map(str, nums)) + "]\n")
    return put


def _rows():
    reg = {s.id: s for s in registry.load_registry(REPO / "sources")}
    ids = [e["id"] for e in yaml.safe_load(BATCH.read_text(encoding="utf-8"))["sources"]]
    return [reg[i] for i in ids], ids


def test_only_active_runnable_sources(cfg):
    cfg(APPROVED)
    rows, ids = _rows()
    assert len(ids) == len(set(ids)) and len(rows) >= 40
    for s in rows:
        ok, why = registry.runnable(s)
        assert ok, (s.id, why)
        assert s.enabled and s.tos != "forbidden" and not s.needs_contact, s.id
        assert str(s.fetch.get("kind")) == "https", s.id


def test_zero_inactive_sources(cfg):
    cfg(APPROVED)
    _, ids = _rows()
    reg = {s.id: s for s in registry.load_registry(REPO / "sources")}
    off = [i for i in reg if not reg[i].enabled]
    assert off and not (set(off) & set(ids))
    assert "src:opensurvey-trend" not in ids


def test_decision_pending_sources_need_approval(cfg):
    rows, _ = _rows()
    gated = [s for s in rows if s.policy.get("requires_decision") is not None or s.policy.get("robots") == "official_api"]
    assert gated, "결정 8, 9 소스가 배치에 있어야 한다"
    cfg([])
    assert all(not registry.runnable(s)[0] for s in gated)
    cfg([8, 9])
    assert all(registry.runnable(s)[0] for s in gated)


def test_adapters_exist_and_hosts_allowed(cfg):
    cfg(APPROVED)
    rows, _ = _rows()
    deny = [d.lower() for d in HOSTS["deny"]]
    for s in rows:
        assert str(s.parser or "").split("@", 1)[0] in ADAPTERS, (s.id, s.parser)
        for u in s.all_urls():
            h = registry.host_of(u).lower()
            assert not any(h == d or h.endswith("." + d) for d in deny), (s.id, h)
