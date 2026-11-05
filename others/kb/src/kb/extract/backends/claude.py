"""claude -p 어댑터(ADR 10.5 호출 형태 그대로). --effort를 붙이지 않는다(ADR-0003 6장). 판정은 마지막 result 이벤트:
is_error=false, permission_denials 비어 있음, structured_output 있음. exit 코드를 보지 않는다."""
from __future__ import annotations

import json
import os
import subprocess
import time

from kb.core import cas
from kb.extract import guard, settings, state
from kb.extract.types import Job, Preflight, Result, Window

NAME = "claude"
RATE_KEY = "claude:rate"
# 설치판 스키마의 optional 필드라 경로를 코드 한 곳에 고정한다(공개 타입에는 rate_limit_info.utilization?뿐이다).
FIVE_HOUR = ("unifiedWindows", "five_hour", "utilization")
SEVEN_DAY = ("unifiedWindows", "seven_day", "utilization")
PATH = "/usr/bin:/bin"


def bin_path() -> str:
    return os.environ.get("KB_CLAUDE_BIN") or ""


def clean_env() -> dict:
    return {"HOME": os.path.expanduser("~"), "PATH": PATH, "LANG": "C.UTF-8", "DISABLE_AUTOUPDATER": "1", "RTK_DISABLED": "1"}


def rate_view(info: dict | None) -> dict | None:
    if not info:
        return None

    def dig(path):
        cur = info
        for k in path:
            cur = cur.get(k) if isinstance(cur, dict) else None
        return cur
    return {"five_hour": dig(FIVE_HOUR), "seven_day": dig(SEVEN_DAY), "status": info.get("status"),
            "isUsingOverage": info.get("isUsingOverage")}


def _has_rate(rv: dict | None) -> bool:
    """five_hour, seven_day가 둘 다 없을 때만 값 없음이다. 7일 경고 구간에는 five_hour 키가 빠진다(ADR 10.5)."""
    return bool(rv) and (rv.get("five_hour") is not None or rv.get("seven_day") is not None)


def build_cmd(model: str, system: str, schema_json: str, budget_usd: float) -> list:
    return [bin_path(), "-p", "--model", model, "--tools", "", "--setting-sources", "", "--strict-mcp-config",
            "--system-prompt", system, "--json-schema", schema_json,
            "--max-turns", str(int(settings.get("claude.max_turns", 3))), "--max-budget-usd", str(budget_usd),
            "--no-session-persistence", "--permission-prompts", "none", "--output-format", "stream-json", "--verbose"]


def parse_stream(stdout: str) -> dict:
    res = rate = init = None
    for line in stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get("type")
        if t == "result":
            res = e
        elif t == "rate_limit_event":
            rate = e.get("rate_limit_info")
        elif t == "system" and e.get("subtype") == "init":
            init = e
    return {"result": res, "rate": rate, "init": init}


def run_claude(model: str, system: str, user: str, schema_obj: dict, budget_usd: float, window_id: str) -> Result:
    return Result(window_id, NAME, model, error="subscription_automatic_forbidden")


CANARY_TEXT = "Claude Code 2.1.316 was released on 2026-10-30. The release notes state that the --tools flag accepts an empty string."


def canary_window() -> Window:
    return Window("canary", "canary", CANARY_TEXT, [], [{"id": "e:canary", "label": "Claude Code", "aliases": []}], "Canary")


class Claude:
    name = NAME
    external = True

    def _auth_ok(self) -> bool:
        try:
            p = subprocess.run([bin_path(), "auth", "status"], capture_output=True, text=True, env=clean_env(), timeout=60)
        except Exception:  # noqa: BLE001
            return False
        return p.returncode == 0

    def preflight(self) -> Preflight:
        b = bin_path()
        if not b or not os.path.isfile(b):
            return Preflight(False, "no_bin")
        c = state.get("claude:canary") or {}
        ttl = float(settings.get("claude.canary_ttl_s", 86400))
        if c.get("bin") == b and c.get("ok") and settings.now_s() - c.get("at", 0) < ttl and _has_rate(c.get("rate")):
            return Preflight(True, "", info={"rate": c.get("rate"), "at": c.get("at")})
        return self.canary()

    def canary(self) -> Preflight:
        return Preflight(False, "subscription_automatic_forbidden")

    def extract(self, job: Job, permit) -> Result:
        guard.verify(permit, NAME, job.user)
        budget_usd = job.budget_usd if job.budget_usd is not None else float(settings.get("claude.budget_usd", 0.02))
        return run_claude(job.model or str(settings.get("claude.model", "haiku")), job.system, job.user, job.schema,
                          budget_usd, job.window.window_id)
