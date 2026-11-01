"""[결정 11 뒤] 실제 claude -p가 kb-mcp에 붙는다(Haiku 1회, 비용 상한 0.03).
임시 다른 프로젝트 cwd에서 ops/bin/dev kb-mcp를 가리키는 임시 설정을 --strict-mcp-config --mcp-config로 넘긴다.
확인: status=connected, kb_search 결과가 탭 구분 텍스트 그대로 도달, 세션 종료 뒤 kb ship 분리 실행 기록."""
import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from mhelp import fake_kb, lines, wait_for

REPO = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(shutil.which("claude") is None, reason="claude 없음")
def test_real_claude_connects_and_reaches_tab_text(kbenv):
    import os
    import tomllib
    real_cfg = Path.home() / ".config" / "sagae-kb" / "decisions.toml"
    if 11 not in (tomllib.loads(real_cfg.read_text()).get("approved") or []):
        pytest.skip("결정 11 미승인")
    work = kbenv.home / "real"
    other = work / "other-project"
    other.mkdir(parents=True, exist_ok=True)
    log = work / "ship.log"
    log.unlink(missing_ok=True)
    env = {k: os.environ[k] for k in ("KB_HOME", "KB_CONFIG_DIR", "KB_SHARE", "KB_TOOLCHAIN", "KB_BUILD_ROOT", "KB_REPO", "HOME", "PATH")
           if k in os.environ}
    env["KB_SHIP_BIN"] = fake_kb(work, log)
    cfg = work / "mcp.json"
    cfg.write_text(json.dumps({"mcpServers": {"kb": {"command": str(REPO / "ops/bin/dev"), "args": ["kb-mcp"], "env": env}}}))
    prompt = ("kb_search 도구를 q=\"hooks\" 로 정확히 한 번만 호출해라. 다른 도구는 쓰지 마라. 호출이 끝나면 DONE 한 단어만 답해라.")
    cmd = ["claude", "-p", prompt, "--model", "haiku", "--strict-mcp-config", "--mcp-config", str(cfg),
           "--allowedTools", "mcp__kb__kb_search", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.03",
           "--no-session-persistence"]
    p = subprocess.run(cmd, cwd=other, capture_output=True, text=True, timeout=240)
    evs = [json.loads(x) for x in p.stdout.splitlines() if x.startswith("{")]
    init = next(e for e in evs if e.get("type") == "system" and e.get("subtype") == "init")
    kb = next(s for s in init["mcp_servers"] if s["name"] == "kb")
    assert kb["status"] == "connected", (kb, p.stderr[-500:])
    results = []
    for e in evs:
        if e.get("type") == "user":
            for c in e["message"]["content"]:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    cont = c["content"]
                    results.append(cont if isinstance(cont, str) else "".join(x.get("text", "") for x in cont))
    assert results, p.stdout[-800:]
    assert results[0].startswith("#kb v1 seq=") and "\t" in results[0]
    cost = next((e.get("total_cost_usd") for e in evs if e.get("type") == "result"), None)
    assert cost is not None and cost <= 0.03
    got = wait_for(lambda: lines(log), 8.0)
    assert len(got) == 1 and got[0].endswith("ship --if-dirty --timeout 12")
