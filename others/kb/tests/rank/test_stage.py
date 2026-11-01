"""tick 6.4와 내부 작업 등록."""
from kb.collect import internal
from kb.rank import tick_stage

from .conftest import publish_gold


def test_stage_registered_and_job_listed():
    assert tick_stage.STAGES[0][:2] == (6.4, "vector")
    ids = {j["id"] for j in internal.load_jobs()}
    assert {"rank.index", "rank.prune"} <= ids


def test_stage_without_gold_is_ok(kb_home):
    r = tick_stage.run()
    assert r.ok and r.detail.get("skipped") == "no_gold"


def test_stage_builds_then_skips(w, kb_home):
    publish_gold(w, kb_home, "g-000000001-aaaa")
    r1 = tick_stage.run()
    assert r1.ok and r1.detail["rows"] > 0 and r1.detail["embedded"] == r1.detail["rows"]
    assert tick_stage.run().detail["skipped"] == "unchanged"


def test_missing_venv_rank_skips(w, kb_home, monkeypatch):
    monkeypatch.delenv("KB_RANK_STUB")
    monkeypatch.setenv("KB_TOOLCHAIN", str(kb_home / "no-toolchain"))
    publish_gold(w, kb_home, "g-000000001-aaaa")
    r = tick_stage.run()
    assert r.ok and r.detail["skipped"] == "venv_rank_missing"
