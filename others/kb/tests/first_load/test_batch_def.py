"""sources/first-load.yaml 정의 검사 (WP-25). 네트워크 없음."""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import yaml

from kb.collect import registry
from kb.parse.adapters import ADAPTERS
from kb.parse.discover import DISCOVERERS

REPO = Path(__file__).resolve().parents[2]
BATCH = REPO / "sources" / "first-load.yaml"


def _batch():
    return yaml.safe_load(BATCH.read_text(encoding="utf-8"))["sources"]


def _srcs():
    reg = {s.id: s for s in registry.load_registry(REPO / "sources")}
    return [(e, reg[e["id"]]) for e in _batch()]


def test_all_exist_and_active():
    rows = _srcs()
    assert len(rows) >= 40
    for e, s in rows:
        assert s.enabled, s.id
        assert s.policy.get("requires_decision") is None, s.id
        assert s.policy.get("robots") == "enforce", s.id
        assert s.tos != "signals_conflict", s.id
        assert not s.needs_contact, s.id


def test_deterministic_adapter():
    for e, s in _srcs():
        name = str(s.parser or "").split("@", 1)[0]
        assert name in ADAPTERS, (s.id, s.parser)


def test_excluded():
    ids = {s.id for _, s in _srcs()}
    invs = {s.inventory_id for _, s in _srcs()}
    assert "O07" not in invs and "src:codex-features" not in ids
    assert "src:g4-repos" not in ids
    assert not any(i.startswith("src:g4-repos") for i in ids)


def test_discover_sources_have_max_pages_and_budget():
    per_host = defaultdict(int)
    for e, s in _srcs():
        disc = s.fetch.get("discover")
        if disc:
            assert disc["kind"] in DISCOVERERS
            mp = e.get("max_pages")
            assert isinstance(mp, int) and 1 <= mp <= 25, s.id
            host = registry.host_of(s.fetch["url"])
            per_host[host] += mp
        else:
            assert "max_pages" not in e, s.id
    for host, n in per_host.items():
        assert n * 3 <= 25 * 60, (host, n)


def test_order_a_to_f_before_g():
    doms = [e["domain"] for e in _batch()]
    first_g = next(i for i, d in enumerate(doms) if d == ["G"])
    assert all("G" not in d for d in doms[:first_g])
    assert all(d == ["G"] for d in doms[first_g:])
