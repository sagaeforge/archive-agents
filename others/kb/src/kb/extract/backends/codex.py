"""codex exec 어댑터(ADR-0003 7장). 실측 통과 전까지 codex.enabled=false이고 mock으로만 시험한다.
한도 상태에서는 호출하지 않는다(구매 크레딧을 쓰지 않는다). 자격 증명 파일을 읽지 않는다."""
from __future__ import annotations

import json
import os
import select
import subprocess
import tempfile
import time

from kb.core import paths
from kb.extract import guard, settings
from kb.extract.types import Job, Preflight, Result

NAME = "codex"
OFF = ["hooks", "plugins", "apps", "goals", "image_generation", "memories", "shell_tool"]


def _bin() -> str:
    return str(settings.get("codex.bin", "codex"))


def _env() -> dict:
    node = os.path.dirname(_bin()) if os.sep in _bin() else ""
    e = {"HOME": os.path.expanduser("~"), "PATH": (node + ":" if node else "") + "/usr/bin:/bin", "LANG": "C.UTF-8"}
    if settings.get("codex.mock_base_url"):
        e["MOCK_KEY"] = "dummy"
    return e


def rate_limits() -> dict:
    """codex app-server 공개 RPC account/rateLimits/read. 계정 식별자는 기록하지 않는다."""
    out = {"ordinaryUsageAllowed": None, "usedPercent": None, "resetsAt": None, "error": None}
    try:
        p = subprocess.Popen([_bin(), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, text=True, env=_env())
    except OSError as e:
        out["error"] = type(e).__name__
        return out

    def send(o):
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()
    try:
        send({"method": "initialize", "id": 1, "params": {"clientInfo": {"name": "sagae_kb", "title": "kb", "version": "0.1"}}})
        sent, got, t0 = False, None, time.time()
        while time.time() - t0 < 25:
            r, _, _ = select.select([p.stdout], [], [], 1)
            if not r:
                continue
            line = p.stdout.readline()
            if not line:
                break
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == 1 and not sent:
                send({"method": "initialized", "params": {}})
                send({"method": "account/rateLimits/read", "id": 2})
                sent = True
            elif m.get("id") == 2:
                got = m
                break
        res = (got or {}).get("result") or {}
        pr = (res.get("rateLimits") or {}).get("primary") or {}
        out.update(ordinaryUsageAllowed=res.get("ordinaryUsageAllowed"), usedPercent=pr.get("usedPercent"),
                   resetsAt=pr.get("resetsAt"), error=(got or {}).get("error"))
    except Exception as e:  # noqa: BLE001
        out["error"] = type(e).__name__
    finally:
        p.terminate()
    return out


def limit_ok(rl: dict) -> bool:
    mx = float(settings.get("codex.max_used_percent", 50))
    return rl.get("ordinaryUsageAllowed") is True and rl.get("usedPercent") is not None and rl["usedPercent"] < mx


def build_cmd(model: str, schema_path: str, out_path: str, work: str) -> list:
    c = [_bin(), "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
         "--sandbox", "read-only", "-C", work, "--output-schema", schema_path, "-o", out_path, "-m", model]
    for f in OFF:
        c += ["--disable", f]
    c += ["-c", 'web_search="disabled"', "-c", "agents.enabled=false",
          "-c", f'model_reasoning_effort="{settings.get("codex.effort", "low")}"']
    mock = settings.get("codex.mock_base_url")
    if mock:
        c += ["-c", 'model_provider="mockp"', "-c",
              'model_providers.mockp={name="mockp",base_url="%s",wire_api="responses",env_key="MOCK_KEY",'
              'request_max_retries=0,stream_max_retries=0}' % mock]
    return c + ["-"]


class Codex:
    name = NAME
    external = True

    def preflight(self) -> Preflight:
        if not settings.get("codex.enabled", False):
            return Preflight(False, "disabled")
        if settings.get("codex.mock_base_url"):
            return Preflight(True, "", info={"mock": True})
        rl = rate_limits()
        if not limit_ok(rl):
            return Preflight(False, "limit", info={"rate": rl})
        return Preflight(True, "", info={"rate": rl})

    def extract(self, job: Job, permit) -> Result:
        guard.verify(permit, NAME, job.user)
        model = job.model or str(settings.get("codex.model", "gpt-6.1-sol"))
        r = Result(job.window.window_id, NAME, model)
        work = tempfile.mkdtemp(prefix="kb-codex-", dir=str(paths.kb_home() / "test-tmp") if (paths.kb_home() / "test-tmp").is_dir() else None)
        sp, op = os.path.join(work, "schema.json"), os.path.join(work, "out.json")
        sch = job.schema
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(sch, f, ensure_ascii=False)
        t0 = time.time()
        try:
            p = subprocess.run(build_cmd(model, sp, op, work), input=job.system + "\n\n" + job.user, capture_output=True,
                               text=True, env=_env(), timeout=float(settings.get("codex.timeout_s", 300)))
        except subprocess.TimeoutExpired:
            r.error = "timeout"
            r.elapsed_s = round(time.time() - t0, 3)
            return r
        except OSError as e:
            r.error = f"spawn: {type(e).__name__}"
            return r
        r.elapsed_s = round(time.time() - t0, 3)
        if os.path.exists(op):
            r.raw = open(op, encoding="utf-8").read()
        items, usage, fail = [], None, None
        for line in p.stdout.splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            t = e.get("type")
            if t in ("item.started", "item.completed"):
                items.append((e.get("item") or {}).get("type"))
            elif t == "turn.completed":
                usage = e.get("usage")
            elif t in ("turn.failed", "error"):
                fail = json.dumps(e, ensure_ascii=False)[:300]
        r.extra["tool_items"] = sorted({x for x in items if x and x not in ("agent_message", "reasoning")})
        if usage:
            r.usage = {"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                       "cached_input_tokens": usage.get("cached_input_tokens"),
                       "reasoning_tokens": usage.get("reasoning_output_tokens")}
        r.finish_reason = "stop" if usage else None
        r.provider, r.served_model, r.cost_usd = "openai", model, None     # Codex 비용은 null이고 usedPercent를 남긴다
        if p.returncode != 0 or not r.raw:
            r.error = fail or f"exit={p.returncode}"
        return r
