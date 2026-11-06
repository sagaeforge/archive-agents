"""만기 에이전트 작업마다 API/로컬 엔진을 고른다(ADR-0004 E1).
구독 카나리아 없이 기존 전역 정지와 엔진별 정지를 확인한다. 실행 중 엔진은 바꾸지 않는다."""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys

ORDER = ("kb agent run", "kb-agent-run kb-fulfill", "kb-agent-run kb-liveness-review", "kb retro")


def _rank(cmd: str) -> int:
    for i, p in enumerate(ORDER):
        if cmd.startswith(p):
            return i
    return len(ORDER)


def load_agent_jobs() -> list[dict]:
    from kb.collect import registry
    d = registry.sources_dir() / "internal.d"
    out: list[dict] = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.yaml")):
        doc = registry.read_yaml(p) or {}
        for j in doc.get("jobs") or []:
            if isinstance(j, dict) and j.get("kind") == "agent" and j.get("id") and j.get("cmd"):
                out.append(dict(j, _file=p.name))
    out.sort(key=lambda j: (_rank(str(j["cmd"])), str(j["id"])))
    return out


def resolve(cmd: str) -> list[str]:
    from kb.core import paths
    t = shlex.split(cmd)
    if t[0] == "kb-agent-run":
        return [os.environ.get("KB_AGENT_RUN") or str(paths.share_dir() / "ops" / "bin" / "kb-agent-run"), *t[1:]]
    if t[0] == "kb":
        kb = os.environ.get("KB_BIN")
        if not kb:
            cand = paths.kb_home() / "runtime" / "bin" / "kb"
            kb = str(cand) if cand.exists() else ""
        return ([kb] if kb else [sys.executable, "-I", "-m", "kb"]) + t[1:]
    return t


def calls_claude(cmd: str) -> bool:
    t = shlex.split(cmd)
    return bool(t) and (t[0] == "kb-agent-run" or t[:2] == ["kb", "retro"])


def _engine_for(j: dict) -> str | None:
    from kb.extract import engines
    # O1/A1 add OpenAI/PydanticAI execution. Do not select an unavailable executor.
    tokens = shlex.split(str(j["cmd"]))
    is_extract = tokens[:3] == ["kb", "agent", "run"]
    if not calls_claude(str(j["cmd"])) and not is_extract:
        return None  # raw claude/codex/env commands cannot bypass engine isolation
    if is_extract and ("--scope=sensitive" in tokens or any(tokens[i:i + 2] == ["--scope", "sensitive"] for i in range(len(tokens)))):
        arm = engines.select("sensitive", [engines.Arm("sensitive", "local", "nemotron")], needs_external=False)
        return arm.engine if arm else None
    task = "agent" if calls_claude(str(j["cmd"])) else "extract"
    models = {"openrouter": "anthropic/claude-haiku-5.5" if task == "agent" else "openai/gpt-6.1-sol",
              "anthropic_api": "haiku"}
    supported = {"openrouter", "anthropic_api"} if task == "agent" else {"openrouter"}
    requested = j.get("engine")
    if requested and requested not in supported:
        return None
    arms = [engines.Arm(task, e, models[e]) for e in sorted(supported) if not requested or e == requested]
    amount = 0.
    if task == "agent":
        from kb.agentrun.invoke import JOBS
        job = next((t for t in tokens if t in JOBS), "kb-retro")
        amount = float(JOBS[job]["budget"])
        if "--max-budget-usd" in tokens:
            amount = float(tokens[tokens.index("--max-budget-usd") + 1])
    arm = engines.select(task, arms, eligible=lambda a: engines.available(a, reserve_usd=amount))
    return arm.engine if arm else None


def _engine_gate(engine: str) -> str | None:
    from kb.extract import guard, route
    if route.stopped():
        return "hold_" + route.stopped()
    if guard.halted():
        return "halted"
    if route.is_off(engine):
        return "engine_off"
    return None


def _condition(j: dict) -> bool:
    """when 조건. 판정 수단이 실패하면 만기 작업은 돈다(조용히 안 도는 쪽이 더 나쁘다)."""
    w = j.get("when")
    if not w:
        return True
    try:
        if w == "tickets":
            from kb import ticket
            return bool(ticket.list_tickets("queued", limit=1)["items"])
        if w == "review_open":
            from kb.core import opsdb
            c = opsdb.connect()
            try:
                return c.execute("SELECT count(*) FROM review WHERE closed_at IS NULL").fetchone()[0] > 0
            finally:
                c.close()
    except Exception:  # noqa: BLE001
        return True
    return True


def _record_skip(job_id: str, reason: str) -> None:
    try:
        from kb.extract import state
        state.metric("agentjob.skipped", 1, {"job": job_id, "reason": reason})
    except Exception:  # noqa: BLE001
        pass                                          # 기록 실패가 건너뜀을 호출로 바꾸지 않는다


def run_due(dry_run: bool = False) -> dict:
    from kb.collect import clock
    from kb.core import config, opsdb
    out: dict = {"ran": [], "failed": [], "skipped": {}, "calls": 0}
    if not config.decision_ok(11):
        out["skipped"]["*"] = "decision_11"
        return out
    now = clock.now_ms()
    for j in load_agent_jobs():
        key = f"agentjob:{j['id']}"
        last = opsdb.tick_state_get(key)
        if last and now - int(last) < float(j.get("every_s", 86400)) * 1000:
            out["skipped"][j["id"]] = "not_due"
            continue
        if not _condition(j):
            out["skipped"][j["id"]] = "no_work"
            continue
        engine = _engine_for(j)
        if engine is None:
            out["skipped"][j["id"]] = "no_api_engine"
            continue
        argv = resolve(str(j["cmd"]))
        if calls_claude(str(j["cmd"])):
            argv += ["--engine", engine]
        # Extraction has its own selector and only one currently deployed API executor.

        if dry_run:
            out["ran"].append({"id": j["id"], "argv": argv, "engine": engine, "dry_run": True})
            continue
        why = _engine_gate(engine)    # 앞 작업이 한 시간을 쓸 수 있으므로 작업마다 다시 본다
        if why:                                       # 실패가 아니다: not_due 기록을 남기지 않아 다음 회차에 다시 만기다
            out["skipped"][j["id"]] = "engine_" + why
            _record_skip(j["id"], why)
            continue
        out["calls"] += 1
        try:
            p = subprocess.run(argv, timeout=float(j.get("timeout_s", 3600)), capture_output=True, text=True)
            rc = p.returncode
        except Exception as e:  # noqa: BLE001
            rc, p = -1, None
            out["failed"].append({"id": j["id"], "error": type(e).__name__})
            continue
        if rc == 0:
            opsdb.tick_state_set(key, now)
            out["ran"].append({"id": j["id"], "argv": argv, "engine": engine})
        else:
            out["failed"].append({"id": j["id"], "rc": rc, "error": "job_failed"})
    return out


def cmd_run(args) -> int:
    out = run_due(args.dry_run)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    else:
        print(f"호출 {out['calls']}건, 실행 {len(out['ran'])}, 실패 {len(out['failed'])}, 건너뜀 {len(out['skipped'])}")
        for k, v in out["skipped"].items():
            print(f"  건너뜀 {k}: {v}")
        for f in out["failed"]:
            print(f"  실패 {f}")
    return 1 if out["failed"] else 0


def register(sub) -> None:
    p = sub.add_parser("jobs", help="만기 에이전트 작업 실행(kb-agent.service)")
    s = p.add_subparsers(dest="jobs_cmd", metavar="<run>")
    r = s.add_parser("run", help="만기인 kind=agent 작업을 순서대로 부른다")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_run)
    p.set_defaults(func=lambda a: (p.print_help(), 2)[1])
