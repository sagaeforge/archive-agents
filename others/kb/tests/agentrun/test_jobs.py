"""kb jobs run: 만기 작업만, 결정 11 전에는 호출 0회, 순서, 저장소 밖 cwd에서 kb-agent-run이 사본 설정을 찾아 가짜 claude까지 닿음."""
import json
import os
import shutil
import stat
import subprocess
import sys

import pytest

from arhelp import REPO, approve

JOBS_YAML = """jobs:
  - {id: a.retro, kind: agent, every_s: 604800, cmd: "kb retro"}
  - {id: a.liveness, kind: agent, every_s: 604800, cmd: "kb-agent-run kb-liveness-review"}
  - {id: a.fulfill, kind: agent, every_s: 86400, cmd: "kb-agent-run kb-fulfill"}
  - {id: a.l2, kind: agent, every_s: 3600, cmd: "kb agent run --scope public"}
  - {id: a.notdue, kind: agent, every_s: 999999999, cmd: "kb-agent-run kb-retro"}
  - {id: a.tick, every_s: 60, run: "x:y"}
"""


def script(path, body):
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


@pytest.fixture
def fakes(home, monkeypatch):
    share = home / "share"
    (share / "sources" / "internal.d").mkdir(parents=True)
    (share / "sources" / "internal.d" / "t.yaml").write_text(JOBS_YAML)
    monkeypatch.setenv("KB_SHARE", str(share))
    log = home / "calls.log"
    monkeypatch.setenv("KB_BIN", script(home / "fake-kb", f'echo "kb $*" >> "{log}"\n'))
    monkeypatch.setenv("KB_AGENT_RUN", script(home / "fake-agent-run", f'echo "agent-run $*" >> "{log}"\n'))
    from kb.commands import jobs
    monkeypatch.setattr(jobs, "_claude_gate", lambda: None)   # 활용률 검사는 test_job_gate.py가 본다
    return log


def lines(log):
    return log.read_text().splitlines() if log.exists() else []


def test_no_calls_before_decision_11(fakes):
    from kb.commands import jobs
    out = jobs.run_due()
    assert out["calls"] == 0 and out["skipped"] == {"*": "decision_11"} and lines(fakes) == []


def test_only_due_jobs_in_fixed_order(fakes, home):
    from kb.commands import jobs
    approve(home, 11)
    out = jobs.run_due()
    assert lines(fakes) == ["kb agent run --scope public", "agent-run kb-fulfill", "agent-run kb-liveness-review", "kb retro",
                            "agent-run kb-retro"]
    assert out["calls"] == 5 and not out["failed"]
    # 곧바로 다시 돌리면 만기가 아니라 호출 0회
    again = jobs.run_due()
    assert again["calls"] == 0 and set(again["skipped"].values()) == {"not_due"}
    assert len(lines(fakes)) == 5


def test_failed_job_is_not_marked_done(fakes, home, monkeypatch):
    from kb.commands import jobs
    approve(home, 11)
    monkeypatch.setenv("KB_AGENT_RUN", script(home / "bad-run", "exit 3\n"))
    out = jobs.run_due()
    assert {f["id"] for f in out["failed"]} == {"a.fulfill", "a.liveness", "a.notdue"}
    assert jobs.run_due()["calls"] == 3   # 실패한 것만 다음에 다시 만기


def test_when_conditions_skip_without_work(fakes, home, monkeypatch):
    from kb.commands import jobs
    approve(home, 11)
    monkeypatch.setattr(jobs, "_condition", lambda j: False if j["id"] == "a.fulfill" else True)
    out = jobs.run_due()
    assert out["skipped"]["a.fulfill"] == "no_work" and "agent-run kb-fulfill" not in lines(fakes)


def test_shipped_agents_yaml_registers_kinds(repo):
    import yaml
    doc = yaml.safe_load(open(repo / "sources/internal.d/agents.yaml"))
    byid = {j["id"]: j for j in doc["jobs"]}
    assert byid["agents.fulfill"]["cmd"] == "kb-agent-run kb-fulfill" and byid["agents.fulfill"]["every_s"] == 86400
    assert byid["agents.liveness_review"]["every_s"] == 604800
    assert all(j["kind"] == "agent" and "run" not in j for j in doc["jobs"])


def test_agent_run_finds_copied_share_from_outside_cwd(home, tmp_path_factory, monkeypatch):
    """임시 KB_SHARE 사본 + 저장소 밖 cwd: 래퍼가 사본으로 cd해 사본 안 설정을 찾아 가짜 claude까지 닿는다."""
    share = home / "share-copy"
    (share / "ops" / "bin").mkdir(parents=True)
    shutil.copy(REPO / "ops/bin/kb-agent-run", share / "ops/bin/kb-agent-run")
    shutil.copytree(REPO / "ops/job-settings", share / "ops/job-settings")
    shutil.copytree(REPO / ".claude/agents", share / ".claude/agents")
    shutil.copytree(REPO / ".claude/workflows", share / ".claude/workflows")
    out = home / "claude-out"
    fake = script(home / "fake-claude", f'''pwd > "{out}.cwd"
echo "$*" > "{out}.args"
for a in "$@"; do case "$a" in ops/job-settings/*) test -f "$a" && echo "found $a" >> "{out}.found";; esac; done
test -f .claude/workflows/kb-fulfill.js && echo wf >> "{out}.found"
echo '{{"type":"system","subtype":"init","mcp_servers":[]}}'
echo '{{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"result":"{{\\\\"workflow\\\\":\\\\"kb-fulfill\\\\",\\\\"incidents\\\\":[]}}"}}'
''')
    approve(home, 11)
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    env = dict(os.environ, KB_SHARE=str(share), KB_CLAUDE_BIN=fake, KB_PYTHON=sys.executable)
    p = subprocess.run([str(share / "ops/bin/kb-agent-run"), "kb-fulfill"], cwd=elsewhere, env=env, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr + p.stdout
    assert json.loads(p.stdout.strip().splitlines()[-1])["ok"] is True
    assert open(f"{out}.cwd").read().strip() == str(share)
    found = open(f"{out}.found").read()
    assert "found ops/job-settings/kb-fulfill.json" in found and "wf" in found
    args = open(f"{out}.args").read()
    assert "--strict-mcp-config" in args and "--permission-mode dontAsk" in args
    # 실행 기록 보관
    assert list((home / "ops" / "runs").glob("*kb-fulfill*"))


def test_agent_run_refuses_without_decision(home, monkeypatch):
    env = dict(os.environ, KB_SHARE=str(REPO), KB_CLAUDE_BIN="/bin/false", KB_PYTHON=sys.executable)
    p = subprocess.run([str(REPO / "ops/bin/kb-agent-run"), "kb-first-collect", "--sample"], env=env, capture_output=True, text=True)
    assert p.returncode == 3 and "승인 전" in p.stderr


def test_dry_run_fixed_form(repo):
    p = subprocess.run([str(repo / "ops/bin/kb-agent-run"), "--dry-run", "kb-fulfill"], capture_output=True, text=True,
                       env=dict(os.environ, KB_PYTHON=sys.executable))
    assert p.returncode == 0
    s = p.stdout
    for need in ("env -i", "KB_JOB=1", "--strict-mcp-config", "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0", "--permission-mode dontAsk",
                 "--settings ops/job-settings/kb-fulfill.json", "--output-format stream-json", "--include-hook-events"):
        assert need in s, need
