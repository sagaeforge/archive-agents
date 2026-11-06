import json
import os
import re
import sys
import types
from pathlib import Path

import pytest
import yaml

from conftest import FAKE_PAT, NODE, tree
from kb.cli import main
from kb.harvest import config, core

REPO = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((REPO / "schemas/cli/harvest.schema.json").read_text(encoding="utf-8"))


def settings_file(world, tmp, **extra):
    s = {"claude_projects": str(world.projects), "repos": [str(world.home / "sagae-*")], "min_age_s": 0,
         "min_report_chars": 100, "min_result_chars": 20, "min_body_chars": 1}
    s.update(extra)
    p = tmp / "harvest.yaml"
    p.write_text(yaml.safe_dump({"settings": s}, allow_unicode=True), encoding="utf-8")
    return p


def populate(world):
    world.memory(name="a.md", body="메모 본문 하나\n내부 192.0.2.1 줄\n")
    world.journal([("research:a", {"summary": "요약 문장이다. " * 6, "status": "done"})])
    world.agent("에이전트 보고다. " * 20)
    world.doc("t.md", "# 조사\n\n출처 https://example.org/x 이다. 본문이 충분히 길다.\n")


# ------------------------------------------------------------------ CLI

def test_cli_dry_run_then_run_output_matches_schema(world, capsys, tmp_path):
    import jsonschema
    populate(world)
    cfgf = settings_file(world, tmp_path)
    before = tree(world.home.parent)
    assert main(["harvest", "--dry-run", "--json", "--config", str(cfgf)]) == 0
    dry = json.loads(capsys.readouterr().out)
    jsonschema.validate(dry, SCHEMA)
    assert dry["mode"] == "dry-run" and dry["candidates"] == 4 and dry["new_events"] == 0
    assert tree(world.home.parent) == before
    assert main(["harvest", "--json", "--config", str(cfgf)]) == 0
    run = json.loads(capsys.readouterr().out)
    jsonschema.validate(run, SCHEMA)
    assert run["mode"] == "run" and run["actions"] == {"new": 4} and run["new_events"] >= 4
    assert main(["harvest", "--json", "--config", str(cfgf)]) == 0
    again = json.loads(capsys.readouterr().out)
    jsonschema.validate(again, SCHEMA)
    assert again["new_events"] == 0 and again["actions"] == {"unchanged": 4}


def test_cli_overrides_and_errors(world, capsys, tmp_path):
    populate(world)
    cfgf = settings_file(world, tmp_path)
    assert main(["harvest", "--dry-run", "--json", "--config", str(cfgf), "--max-writes", "1", "--samples", "2"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["actions"] == {"new": 4} and out["deferred"] == {"cap": 3} and len(out["samples"]) == 2
    assert main(["harvest", "--json", "--dump", str(tmp_path / "d"), "--config", str(cfgf)]) == 1             # --dump는 dry-run 전용
    assert json.loads(capsys.readouterr().out)["error"] == "E_ARGS"
    bad = tmp_path / "bad.yaml"
    bad.write_text("settings:\n  max_writes: -1\n", encoding="utf-8")
    assert main(["harvest", "--dry-run", "--json", "--config", str(bad)]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "E_CONFIG"
    (world.cfg_dir / "intake-deny.txt").unlink()
    assert main(["harvest", "--dry-run", "--json", "--config", str(cfgf)]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "E_DENY_MISSING"


def test_cli_report_carries_no_bodies_secrets_or_hostnames(world, capsys, tmp_path):
    world.memory(name="a.md", body=f"본문 줄 BODY-SENTINEL\n{NODE} 노드\n")
    world.memory(name="s.md", body=f"비밀 {FAKE_PAT}\n")
    cfgf = settings_file(world, tmp_path)
    assert main(["harvest", "--dry-run", "--json", "--config", str(cfgf)]) == 0
    text = capsys.readouterr().out
    assert "BODY-SENTINEL" not in text and NODE not in text and FAKE_PAT not in text
    out = json.loads(text)
    assert out["skipped"] == {"secret": 1} and out["skipped_secret_rules"]


# ------------------------------------------------------------------ tick 작업

def load_job():
    from kb.collect import internal
    jobs = [j for j in internal.load_jobs() if j["id"] == "harvest.sessions"]
    assert len(jobs) == 1
    return jobs[0]


def test_job_is_registered_hourly_at_an_existing_stage():
    j = load_job()
    assert j["every_s"] == 3600 and j["run"] == "kb.harvest.jobs:run" and j["_file"] == "harvest.yaml"
    assert "kind" not in j                                              # kb jobs run(에이전트 작업)이 아니라 tick 내부 작업이다
    from kb.collect.tick import discover_stages
    found, _ = discover_stages()
    assert (float(j["stage"]), "recover") in {(float(n), name) for n, name in found}, "작업이 돌 단계가 없으면 영영 안 돈다"
    mod, fn = j["run"].split(":")
    assert callable(getattr(__import__(mod, fromlist=[fn]), fn))


def test_yaml_settings_equal_the_code_defaults():
    # 코드 기본값과 harvest.yaml이 어긋나면 어느 쪽이 실제로 도는지 알 수 없다
    assert config.load() == config.Config()


def test_config_rejects_unknown_keys_and_unsafe_caps():
    with pytest.raises(config.ConfigError):
        config.from_dict({"max_writez": 1})
    with pytest.raises(config.ConfigError):
        config.from_dict({"max_writes": True})
    with pytest.raises(config.ConfigError):
        config.from_dict({"max_body_bytes": 10, "max_write_bytes": 5})
    assert config.load(max_writes=None, min_age_s=5).min_age_s == 5


class FakeState:
    def __init__(self):
        self.kv = {}

    def kv_get(self, k):
        return self.kv.get(k)

    def kv_set(self, k, v):
        self.kv[k] = v


def test_job_runs_through_the_tick_scheduler_at_most_hourly(world, tmp_path, monkeypatch):
    from kb.collect import clock, internal
    populate(world)
    cfgf = settings_file(world, tmp_path)
    monkeypatch.setattr(config, "yaml_path", lambda: cfgf)
    real = load_job()
    monkeypatch.setattr(internal, "load_jobs", lambda: [real])
    t = {"now": 1_800_000_000_000}
    monkeypatch.setattr(clock, "now_ms", lambda: t["now"])
    ctx = types.SimpleNamespace(warnings=[], expired=lambda: False)
    st = FakeState()
    res, warns = internal.run_due(1.0, ctx, st)
    assert warns == [] and res["harvest.sessions"]["actions"] == {"new": 4} and res["harvest.sessions"]["new_events"] >= 4
    t["now"] += 10 * 60 * 1000
    assert internal.run_due(1.0, ctx, st) == ({}, [])                   # 한 시간 안에는 다시 돌지 않는다
    assert internal.run_due(2.0, ctx, st) == ({}, [])                   # 다른 단계에서는 돌지 않는다
    t["now"] += 51 * 60 * 1000
    res2, warns2 = internal.run_due(1.0, ctx, st)
    assert warns2 == [] and res2["harvest.sessions"]["new_events"] == 0 and res2["harvest.sessions"]["actions"] == {"unchanged": 4}


def test_job_failure_becomes_a_warning_and_still_counts_as_run(world, tmp_path, monkeypatch):
    from kb.collect import clock, internal
    populate(world)
    monkeypatch.setattr(config, "yaml_path", lambda: settings_file(world, tmp_path))
    (world.cfg_dir / "intake-deny.txt").unlink()                        # 차단 목록 없이는 돌지 않는다
    real = load_job()
    monkeypatch.setattr(internal, "load_jobs", lambda: [real])
    monkeypatch.setattr(clock, "now_ms", lambda: 1_800_000_000_000)
    ctx = types.SimpleNamespace(warnings=[], expired=lambda: False)
    st = FakeState()
    res, warns = internal.run_due(1.0, ctx, st)
    assert res["harvest.sessions"]["error"].startswith("harvest: IntakeError") and ctx.warnings
    assert st.kv_get("job:harvest.sessions") == 1_800_000_000_000       # 예외로 끝나지 않으므로 다음 시도는 한 시간 뒤다


def test_job_can_be_switched_off_without_removing_it(world, tmp_path, monkeypatch):
    from kb.harvest import jobs
    populate(world)
    monkeypatch.setattr(config, "yaml_path", lambda: settings_file(world, tmp_path, enabled=False))
    ctx = types.SimpleNamespace(warnings=[], expired=lambda: False)
    before = tree(world.home.parent)
    assert jobs.run(ctx) == {"skipped": "disabled"} and ctx.warnings == []
    assert tree(world.home.parent) == before                              # 원본도 읽지 않고 아무것도 만들지 않는다
    with pytest.raises(config.ConfigError):
        config.from_dict({"enabled": "no"})


def test_job_stops_when_the_tick_deadline_has_passed(world, tmp_path, monkeypatch):
    populate(world)
    monkeypatch.setattr(config, "yaml_path", lambda: settings_file(world, tmp_path))
    from kb.harvest import jobs
    ctx = types.SimpleNamespace(warnings=[], expired=lambda: True)
    out = jobs.run(ctx)
    assert out["stopped_early"] is True and out["new_events"] == 0 and out["deferred"] == {"deadline": 4}


# ------------------------------------------------------------------ LLM, 네트워크, 상주 프로세스 없음

HARVEST_SRC = sorted((REPO / "src/kb/harvest").glob("*.py")) + [REPO / "src/kb/commands/harvest.py"]


@pytest.mark.parametrize("path", HARVEST_SRC, ids=lambda p: p.name)
def test_harvest_modules_import_nothing_that_calls_out(path):
    # urllib.parse는 문자열 파싱이라 괜찮다. 요청을 보낼 수 있는 모듈만 막는다
    forbidden = re.compile(r"^\s*(?:import|from)\s+(subprocess|socket|ssl|urllib\.request|urllib\.error|http\.client|http\.server|"
                           r"requests|httpx|aiohttp|openai|anthropic|kb\.extract|kb\.agentrun|kb\.collect\.fetch|"
                           r"kb\.collect\.capturer|asyncio|threading)\b", re.M)
    assert not forbidden.findall(path.read_text(encoding="utf-8")), path.name


def _spawn(code: str) -> str:
    """깨끗한 인터프리터에서 code를 돌려 표준 출력을 받는다. 프로세스 차단 보호막(Popen)을 쓰지 않고 posix_spawn으로 띄운다."""
    r, w = os.pipe()
    pid = os.posix_spawn(sys.executable, [sys.executable, "-I", "-c", code], {"PATH": os.environ.get("PATH", "")},
                         file_actions=[(os.POSIX_SPAWN_DUP2, w, 1), (os.POSIX_SPAWN_CLOSE, r)])
    os.close(w)
    with os.fdopen(r) as f:
        out = f.read().strip()
    os.waitpid(pid, 0)
    return out


def test_importing_harvest_does_not_load_llm_or_fetch_modules():
    # socket은 kb.intake.deny가 호스트 이름을 읽으려고 불러온다. 불러오는 것은 호출이 아니다(호출은 보호막이 막는다)
    code = ("import sys, kb.harvest, kb.harvest.jobs, kb.commands.harvest\n"
            "bad=[m for m in sys.modules if m.startswith(('kb.extract','kb.agentrun','kb.collect.fetch','kb.collect.capturer',"
            "'urllib.request','http.client','ssl'))]\n"
            "print(','.join(sorted(bad)))")
    assert _spawn(code) == "", "수확이 불러온 모듈에 LLM, 수집, 네트워크 모듈이 있다"


def test_no_resident_process_or_systemd_unit_was_added():
    hits = [p for p in (REPO / "ops").rglob("*") if p.is_file() and "harvest" in p.name.lower()]
    assert hits == []
    for p in (REPO / "ops/systemd").rglob("*"):
        if p.is_file():
            assert "harvest" not in p.read_text(encoding="utf-8", errors="replace").lower(), p.name
