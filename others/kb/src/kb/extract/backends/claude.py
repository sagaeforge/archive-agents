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
    r = Result(window_id, NAME, model)
    t0 = time.time()
    try:
        p = subprocess.run(build_cmd(model, system, json.dumps(schema_obj, ensure_ascii=False), budget_usd), input=user,
                           capture_output=True, text=True, env=clean_env(),
                           timeout=float(settings.get("claude.timeout_s", 300)))
    except subprocess.TimeoutExpired:
        r.error = "timeout"
        r.elapsed_s = round(time.time() - t0, 3)
        return r
    except OSError as e:
        r.error = f"spawn: {type(e).__name__}"
        return r
    r.elapsed_s = round(time.time() - t0, 3)
    s = parse_stream(p.stdout)
    r.extra["rate"] = rate_view(s["rate"])
    res = s["result"]
    if res is None:
        r.error = f"no result event exit={p.returncode}"
        return r
    u = res.get("usage") or {}
    cr, cc, un = u.get("cache_read_input_tokens") or 0, u.get("cache_creation_input_tokens") or 0, u.get("input_tokens") or 0
    r.usage = {"input_tokens": un + cr + cc, "output_tokens": u.get("output_tokens"), "cached_input_tokens": cr,
               "reasoning_tokens": (u.get("output_tokens_details") or {}).get("thinking_tokens")}
    r.cost_usd = res.get("total_cost_usd")     # 구독이라 추정값이고 실제 청구가 아니다
    mu = res.get("modelUsage") or {}
    r.served_model = ",".join(mu.keys()) if mu else None
    r.provider = "anthropic"
    so = res.get("structured_output")
    if res.get("is_error") or res.get("permission_denials") or so is None:
        r.error = (f"verdict subtype={res.get('subtype')} is_error={res.get('is_error')} "
                   f"denials={len(res.get('permission_denials') or [])} so={so is not None}")
    if so is not None:
        r.raw = json.dumps(so, ensure_ascii=False)
    r.finish_reason = "length" if res.get("stop_reason") in ("max_tokens", "length") else "stop"
    return r


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
        if not self._auth_ok():
            return Preflight(False, "auth")
        return self.canary()

    def canary(self) -> Preflight:
        """전체 플래그 조합 1회. 결과를 CAS에 남긴다. rate_limit 값이 없으면 시작하지 않고 경고한다."""
        from kb.extract import schema
        from kb.extract.prompt import system_text, user_message
        w = canary_window()
        sch = schema.extract_schema(["e:canary"])
        r = run_claude(str(settings.get("claude.model", "haiku")), system_text(), user_message(w), sch,
                       float(settings.get("claude.budget_usd", 0.02)), "canary")
        sha = cas.put(json.dumps(r.as_dict(), ensure_ascii=False, sort_keys=True).encode())
        rv = r.extra.get("rate") or {}
        ok = r.error is None and r.raw is not None
        state.put("claude:canary", {"bin": bin_path(), "ok": ok, "at": settings.now_s(), "sha": sha,
                                    "five_hour": rv.get("five_hour"), "rate": rv})
        if not ok:
            return Preflight(False, "canary_failed", r.error or "")
        if not _has_rate(rv):
            return Preflight(False, "no_rate_value", "rate_limit_event 값 없음: 시작하지 않는다")
        return Preflight(True, "", info={"rate": rv, "canary_sha": sha, "at": settings.now_s()})

    def extract(self, job: Job, permit) -> Result:
        guard.verify(permit, NAME, job.user)
        budget_usd = job.budget_usd if job.budget_usd is not None else float(settings.get("claude.budget_usd", 0.02))
        return run_claude(job.model or str(settings.get("claude.model", "haiku")), job.system, job.user, job.schema,
                          budget_usd, job.window.window_id)
