"""ops/mcp 스크립트: register-user.sh(건식 기본, --apply는 결정 7 뒤), print-gateway-config.sh, kb.mcp.json."""
import json
import os
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FAKE = str(REPO / "tests" / "mcp" / "fake-claude.sh")
REG = str(REPO / "ops" / "mcp" / "register-user.sh")
GW = str(REPO / "ops" / "mcp" / "print-gateway-config.sh")


def run(args, env, **kw):
    return subprocess.run(["bash", *args], capture_output=True, text=True, env=env, timeout=60, **kw)


def base_env(tmp, **kw):
    e = {k: v for k, v in os.environ.items() if k != "KB_CLAUDE_BIN"}
    e.update(KB_CLAUDE_BIN=FAKE, FAKE_CLAUDE_LOG=str(tmp / "claude.log"), KB_CONFIG_DIR=str(tmp / "cfg"))
    e.update(kw)
    return e


def test_dry_run_prints_command_and_never_calls_claude(kbenv):
    tmp = kbenv.home / "scr1"
    tmp.mkdir(exist_ok=True)
    (tmp / "claude.log").unlink(missing_ok=True)
    r = run([REG], base_env(tmp))
    assert r.returncode == 0
    assert "mcp add --scope user kb --" in r.stdout and "kb-mcp" in r.stdout
    assert not (tmp / "claude.log").exists()


def test_apply_refused_without_decision_7(kbenv):
    tmp = kbenv.home / "scr2"
    (tmp / "cfg").mkdir(parents=True, exist_ok=True)
    (tmp / "claude.log").unlink(missing_ok=True)
    (tmp / "cfg" / "decisions.toml").write_text("approved = [1, 2, 3]\n")
    r = run([REG, "--apply"], base_env(tmp))
    assert r.returncode == 3 and not (tmp / "claude.log").exists()
    (tmp / "cfg" / "decisions.toml").unlink()
    r = run([REG, "--apply"], base_env(tmp))
    assert r.returncode == 3 and not (tmp / "claude.log").exists()


def test_apply_with_fake_claude_passes_expected_args(kbenv):
    tmp = kbenv.home / "scr3"
    (tmp / "cfg").mkdir(parents=True, exist_ok=True)
    (tmp / "claude.log").unlink(missing_ok=True)
    (tmp / "cfg" / "decisions.toml").write_text("approved = [1, 7]\n")
    r = run([REG, "--apply"], base_env(tmp, KB_MCP_BIN="/opt/x/kb-mcp"))
    assert r.returncode == 0, r.stderr
    assert (tmp / "claude.log").read_text().strip() == "mcp add --scope user kb -- /opt/x/kb-mcp"


def test_script_never_edits_claude_json():
    code = "\n".join(ln for ln in Path(REG).read_text().splitlines() if not ln.lstrip().startswith("#"))
    assert ".claude.json" not in code and "sed -i" not in code


def test_gateway_config_shape():
    out = subprocess.run(["bash", GW], capture_output=True, text=True, timeout=30, check=True).stdout
    cfg = json.loads(out)
    assert set(cfg) == {"upstreams"} and set(cfg["upstreams"]) == {"kb"}
    kb = cfg["upstreams"]["kb"]
    assert set(kb) == {"command", "args", "env", "uriPrefixes", "autoApprove"}
    assert kb["command"].endswith("/runtime/bin/kb-mcp") and os.path.isabs(kb["command"])
    assert kb["env"] == {"KB_MCP_SESSION": "tower", "KB_MCP_SUPERVISED": "1"}
    assert kb["uriPrefixes"] == ["kb://"] and "type" not in kb
    assert kb["autoApprove"] == ["kb_search", "kb_get", "kb_related", "kb_history", "kb_source", "kb_status"]


def test_kb_mcp_json_is_absolute_and_global_free():
    d = json.loads((REPO / "ops" / "mcp" / "kb.mcp.json").read_text())
    srv = d["mcpServers"]["kb"]
    assert os.path.isabs(srv["command"]) and srv["command"].endswith("/runtime/bin/kb-mcp")
