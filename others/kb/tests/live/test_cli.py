"""kb live run / kb review 진입점, tick 단계 등록, 결정 8 뒤 GraphQL 일괄(가짜 gh)."""
import json
import subprocess
from pathlib import Path

import pytest

from kb.cli import main
from kb.core import opsdb
from kb.live import ghgraphql, probe, reviewq, runner
from kb.live.model import Item

from .conftest import NOW, node, put_entity, source

FIX = Path(__file__).parent / "fixtures" / "registry.yaml"


def test_live_run_dry_run_fixture_json(env, capsys):
    assert main(["live", "run", "--dry-run", "--sources", str(FIX), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["checked"] == 2 and out["dry_run"] and out["written"] == 0
    by = {d["target"]: d for d in out["decisions"]}
    assert by["e:repo:acme-old-tool"]["liveness"] == "superseded" and by["e:repo:acme-old-tool"]["successor"] == "acme/new-tool"
    assert by["e:package:left-pad"]["liveness"] == "deprecated"
    c = opsdb.connect()
    try:
        assert c.execute("SELECT count(*) FROM review").fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM queue WHERE kind='live'").fetchone()[0] == 0
    finally:
        c.close()


def test_review_list_and_decide_keep(env, capsys):
    rid = reviewq.open_item("e:repo:x", "repo", Item("H02", "archived", "removed"), [])
    assert main(["review", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["count"] == 1
    assert main(["review", "decide", str(rid), "--by", "agent:codex", "--liveness", "removed"]) == 2
    assert main(["review", "decide", str(rid), "--keep", "--by", "user"]) == 0
    assert reviewq.list_open() == []


def test_tick_stage_registered_and_skips_without_gold(env):
    from kb.live import tick_stage
    assert tick_stage.STAGES[0][:2] == (6.3, "live")
    from kb.collect import registry
    jobs = [j for j in __import__("kb.collect.internal", fromlist=["x"]).load_jobs()]
    assert tick_stage.run() is not None


def test_graphql_batch_is_gated_by_decision_8_and_uses_fake_gh(env, monkeypatch):
    assert not ghgraphql.enabled(which=lambda n: "/usr/bin/gh")                  # 결정 8 승인 전
    (env.cfg / "decisions.toml").write_text("approved = [8]\n")
    assert ghgraphql.enabled(which=lambda n: "/usr/bin/gh")
    assert not ghgraphql.enabled(which=lambda n: None)
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        data = {"r0": {"nameWithOwner": "acme/moved", "isArchived": True, "pushedAt": "2026-12-01T00:00:00Z"}, "r1": None}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"data": data}), stderr="")

    gh = ghgraphql.GhBatch(["acme/old", "acme/gone"], run=fake_run, source=None, write_snapshots=False)
    assert len(calls) == 1 and calls[0][:3] == ["gh", "api", "graphql"]               # 한 번에 일괄
    assert gh.repo("acme/old").json()["nameWithOwner"] == "acme/moved" and gh.repo("acme/gone").status == 404
    t = runner._target({"id": "e:repo:acme-old", "type": "Repo", "label": "acme/old", "props": {"repo": "acme/old"}, "liveness": "active"})
    out = runner.run([t], probe.OfflineFetcher({}), now=NOW, dry_run=True, gh=gh)
    d = out["decisions"][0]
    assert d["canonical"] == "acme/moved"
