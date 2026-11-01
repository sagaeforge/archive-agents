"""실행당 자동 dead 5건 상한, 초과분은 대기열. stale_suspect는 removed로 자동 승격하지 않는다."""
from kb.core import opsdb
from kb.live import probe, reviewq, rules, runner, signals as S
from kb.live.model import Sig

from .conftest import NOW


def removed_decision(i):
    sg = [Sig("M12", "removed", None, f"x{i} is no longer available"), Sig("M16", "candidate", None, "Removed x", {"verb": "removed"})]
    return rules.decide(f"e:feature:f{i:02d}", "feature", sg, current="alive")


def test_cap_pushes_overflow_to_review_queue():
    decs = [removed_decision(i) for i in range(8)]
    assert all(d.liveness == "removed" and d.auto for d in decs)
    over = runner.apply_cap(decs, 5)
    assert over == 3
    assert sum(1 for d in decs if d.liveness == "removed") == 5
    held = [d for d in decs if d.liveness != "removed"]
    assert len(held) == 3 and all(not d.auto and d.queue[0].proposed == "removed" for d in held)
    assert sorted(d.target for d in held) == ["e:feature:f05", "e:feature:f06", "e:feature:f07"]


def test_stale_suspect_is_never_promoted_to_removed():
    old = {"pushed_at": "2020-01-01T00:00:00Z", "archived": False}
    d = rules.decide("e:repo:old", "repo", [S.m04_commit_age(old, NOW), S.m09_publish_age("2019-01-01", NOW)], current="alive")
    assert d.liveness == "stale_suspect"
    assert runner.apply_cap([d], 5) == 0 and d.liveness == "stale_suspect"


def test_run_applies_cap_and_writes_nothing_in_dry_run(env):
    targets, resp = [], {}
    for i in range(7):
        u = f"https://docs.example/f{i}"
        targets.append({"id": f"e:feature:f{i}", "type": "feature", "label": f"f{i}", "liveness": "active",
                        "props": {"name": f"/f{i}", "docs_url": u, "changelog_url": u + "/cl"}})
        resp[u] = {"status": 200, "body": f"# /f{i}\n\n| /f{i} | Removed in v2.0.0 |\n"}
        resp[u + "/cl"] = {"status": 200, "body": f"## 2.0.0\n- Removed `/f{i}` command\n"}
    out = runner.run(targets, probe.OfflineFetcher(resp), now=NOW, dry_run=True)
    assert out["checked"] == 7 and out["capped"] == 2 and out["written"] == 0 and out["dry_run"]
    assert sum(1 for d in out["decisions"] if d["liveness"] == "removed") == 5
    c = opsdb.connect()
    try:
        assert c.execute("SELECT count(*) FROM review").fetchone()[0] == 0
    finally:
        c.close()
