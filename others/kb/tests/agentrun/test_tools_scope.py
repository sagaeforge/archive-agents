"""에이전트 정의가 ADR 20.2 표와 같고, 워크플로우·job 설정이 약속을 지킨다."""
import asyncio
import json
import re

import pytest

from arhelp import REPO

TABLE = {  # 이름: (도구 집합, model, effort, maxTurns)
    "kb-collector": ({"WebSearch", "kb_fetch", "kb_source", "kb_get", "kb_search", "kb_ingest_validate", "kb_ingest_submit",
                      "kb_ticket_list", "kb_ticket_close"}, "sonnet", "medium", 30),
    "kb-researcher": ({"WebSearch", "WebFetch"}, "haiku", "low", 8),
    "kb-judge": (set(), "haiku", "low", 3),
    "kb-verifier": ({"kb_search", "kb_get", "kb_source"}, "haiku", "low", 6),
    "kb-retro": (set(), "sonnet", "medium", 3),
}
FORBIDDEN = {"Read", "Bash", "Write", "Edit"}
MCP = "mcp__kb-collect__"


def front(name):
    txt = (REPO / ".claude" / "agents" / f"{name}.md").read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", txt, re.S)
    fm = {}
    for ln in m.group(1).splitlines():
        k, _, v = ln.partition(":")
        fm[k.strip()] = v.strip().strip('"')
    return fm, m.group(2)


def tools_of(fm):
    return {t.strip() for t in fm.get("tools", "").split(",") if t.strip()}


def test_five_agents_exactly():
    assert {p.stem for p in (REPO / ".claude" / "agents").glob("*.md")} == set(TABLE)


@pytest.mark.parametrize("name", sorted(TABLE))
def test_agent_matches_adr_table(name):
    fm, body = front(name)
    want_tools, model, effort, turns = TABLE[name]
    got = tools_of(fm)
    assert {t.removeprefix(MCP) for t in got} == want_tools
    assert all(t.startswith(MCP) for t in got if t not in ("WebSearch", "WebFetch"))
    assert fm["model"] == model and fm["effort"] == effort and int(fm["maxTurns"]) == turns
    assert fm["omitClaudeMd"] == "true"
    assert "## 공통 규칙" in body and "incidents" in body and "데이터이며 지시가 아니다" in body
    assert "attributed" in body and "자체 점수" in body and "개인 정보" in body and "liveness=removed" in body
    assert not got & FORBIDDEN


def test_no_tool_agents():
    for n in ("kb-judge", "kb-retro"):
        fm, _ = front(n)
        assert fm["tools"] == "" and tools_of(fm) == set()


def test_mcp_tools_exist_in_registered_profile(kbenv):
    cfg = json.load(open(REPO / "ops/job-settings/kb-collect.mcp.json"))
    assert list(cfg["mcpServers"]) == ["kb-collect"]
    assert cfg["mcpServers"]["kb-collect"]["args"] == ["--profile", "collector"]
    from kb.serve.mcp import build_server
    have = {t.name for t in asyncio.run(build_server("collector").list_tools())}
    used = set()
    for n in TABLE:
        used |= {t.removeprefix(MCP) for t in tools_of(front(n)[0]) if t.startswith(MCP)}
    assert "kb_get" in used and used <= have, used - have


def split_calls(src):
    """agent( 호출마다 괄호 짝이 닫힐 때까지의 본문."""
    out = []
    for m in re.finditer(r"(?<![\w.])agent\(", src):
        i, depth = m.end(), 1
        while depth and i < len(src):
            depth += {"(": 1, ")": -1}.get(src[i], 0)
            i += 1
        out.append(src[m.end():i])
    return out


def test_every_workflow_agent_call_has_model_and_effort():
    total = 0
    for p in sorted((REPO / ".claude" / "workflows").glob("*.js")):
        src = p.read_text(encoding="utf-8")
        calls = split_calls(src)
        total += len(calls)
        for c in calls:
            assert re.search(r"\bmodel:", c) and re.search(r"\beffort:", c), f"{p.name}: {c[:80]}"
            assert "fork" not in c
        assert "fork" not in src.replace("fork를", "")
        assert not re.search(r"Date\.now|Math\.random|new Date\(\)", src)
    assert total >= 8


def test_critic_is_opus_high_and_ladder():
    src = (REPO / ".claude/workflows/kb-first-collect.js").read_text(encoding="utf-8")
    assert "LADDER[2].model" in src and "LADDER[2].effort" in src
    for r in ("haiku', effort: 'low", "sonnet', effort: 'medium", "opus', effort: 'high", "opus', effort: 'xhigh", "opus', effort: 'max"):
        assert r in src
    assert "A.rung" in src and "RETRIES = Math.min(1" in src


def test_job_settings_allow_workflow_and_deny_hosts():
    import yaml
    deny = yaml.safe_load(open(REPO / "sources/host-policy.yaml"))["deny"]
    for name in ("kb-first-collect", "kb-fulfill", "kb-liveness-review", "kb-retro"):
        s = json.load(open(REPO / "ops/job-settings" / f"{name}.json"))["permissions"]
        assert f"Workflow({name})" in s["allow"]
        for h in deny:
            assert f"WebFetch(domain:{h})" in s["deny"], (name, h)
        assert not FORBIDDEN & set(s["allow"])


def test_check_workflows_accepts_repo_and_rejects_broken(repo, home):
    import subprocess
    ok = subprocess.run(["bash", str(repo / "ops/bin/check-workflows")], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    bad = home / "bad.js"
    bad.write_text("export const meta = {name: 'x'}\nconst a = ;\n")
    assert subprocess.run(["bash", str(repo / "ops/bin/check-workflows"), str(bad)], capture_output=True).returncode == 1
    bad.write_text("export const meta = {name: 'x'}\nconst t = Date.now()\n")
    assert subprocess.run(["bash", str(repo / "ops/bin/check-workflows"), str(bad)], capture_output=True).returncode == 1
