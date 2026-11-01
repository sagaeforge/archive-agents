"""ADR 20.3의 호출 형태를 고정한다. 표준 라이브러리만 쓴다(kb-agent-run --dry-run이 venv 없이도 돈다)."""
from __future__ import annotations

import json
import os
import shlex
import shutil
from dataclasses import dataclass, field

# 결정 번호: 10 = kb-first-collect 실행과 상한, 11 = 실제 claude -p 호출 허용
JOBS: dict[str, dict] = {
    "kb-first-collect": dict(settings="kb-first-collect.json", mcp=True, tools="Workflow,WebSearch,WebFetch", model="haiku",
                             effort="low", max_turns=8, budget=5.0, decisions=(10, 11)),
    "kb-fulfill": dict(settings="kb-fulfill.json", mcp=True, tools="Workflow,WebSearch,WebFetch", model="haiku",
                       effort="low", max_turns=8, budget=2.0, decisions=(11,)),
    "kb-liveness-review": dict(settings="kb-liveness-review.json", mcp=False, tools="Workflow", model="haiku",
                               effort="low", max_turns=6, budget=1.0, decisions=(11,)),
    "kb-retro": dict(settings="kb-retro.json", mcp=False, tools="Workflow", model="haiku",
                     effort="low", max_turns=6, budget=1.0, decisions=(11,)),
}
MCP_CONFIG = "ops/job-settings/kb-collect.mcp.json"
PASS_ENV = ("KB_HOME", "KB_SHARE", "KB_CONFIG_DIR")


@dataclass
class Call:
    env: dict[str, str]
    argv: list[str]
    cwd: str
    job: str
    prompt: str
    decisions: tuple = ()
    warnings: list[str] = field(default_factory=list)

    def shell(self) -> str:
        """env -i 로 시작하는 한 줄. 사람이 읽고 그대로 실행할 수 있는 형태다."""
        pairs = [f"{k}={shlex.quote(v)}" for k, v in self.env.items()]
        return "env -i " + " ".join(pairs + [shlex.quote(a) for a in self.argv])


def _node_dir(environ) -> str:
    n = shutil.which("node", path=environ.get("PATH"))
    return os.path.dirname(os.path.realpath(n)) if n else ""


def build(job: str, share: str, *, args: dict | None = None, model: str | None = None, effort: str | None = None,
          max_budget: float | None = None, environ=None) -> Call:
    if job not in JOBS:
        raise KeyError(f"알 수 없는 작업: {job}. 가능: {', '.join(sorted(JOBS))}")
    j = JOBS[job]
    environ = os.environ if environ is None else environ
    home = environ.get("HOME", os.path.expanduser("~"))
    node = _node_dir(environ)
    path = ":".join(p for p in (node, "/usr/bin", "/bin") if p)
    env = {"HOME": home, "PATH": path, "LANG": "C.UTF-8", "KB_JOB": "1", "DISABLE_AUTOUPDATER": "1",
           "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0"}
    for k in PASS_ENV:
        if environ.get(k):
            env[k] = environ[k]
    claude = environ.get("KB_CLAUDE_BIN") or "claude"
    prompt = f"/{job}" + (" " + json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(",", ":")) if args else "")
    argv = [claude, "-p", prompt, "--setting-sources", "project", "--strict-mcp-config"]
    if j["mcp"]:
        argv += ["--mcp-config", MCP_CONFIG]
    argv += ["--settings", f"ops/job-settings/{j['settings']}", "--tools", j["tools"],
             "--permission-mode", "dontAsk", "--permission-prompts", "none",
             "--model", model or j["model"], "--effort", effort or j["effort"],
             "--max-turns", str(j["max_turns"]), "--max-budget-usd", f"{max_budget if max_budget is not None else j['budget']:g}",
             "--output-format", "stream-json", "--verbose", "--include-hook-events"]
    warns = [] if environ.get("KB_CLAUDE_BIN") else ["KB_CLAUDE_BIN이 비어 있어 PATH의 claude를 쓴다"]
    return Call(env=env, argv=argv, cwd=share, job=job, prompt=prompt, decisions=tuple(j["decisions"]), warnings=warns)
