"""kb-agent-run 본체. share_dir()로 cd해 설정과 정의를 그 아래에서 찾는다.
  kb-agent-run --engine openrouter|anthropic_api [--dry-run] [--sample] [--args JSON] [--utilization X] [--model M] [--max-budget-usd N] <작업>
승인 게이트: 작업의 결정(11, kb-first-collect는 10 포함)이 승인 전이면 실제 호출을 하지 않고 종료 코드 3."""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

from kb.agentrun import invoke, stream, verdict

EXIT_GATE = 3


def _archive(path, lines: list[str]) -> str:
    """스트림을 ops/runs/에 zstd로 보관한다(없으면 gzip)."""
    data = ("\n".join(lines) + "\n").encode()
    try:
        from compression import zstd
        out = str(path) + ".zst"
        with open(out, "wb") as f:
            f.write(zstd.compress(data))
    except Exception:  # noqa: BLE001
        import gzip
        out = str(path) + ".gz"
        with gzip.open(out, "wb") as f:
            f.write(data)
    return out


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_args(ns, job: str) -> dict | None:
    a = json.loads(ns.args) if ns.args else {}
    if job == "kb-first-collect":
        a.setdefault("now", _now_iso())
        a.setdefault("seed", 0)
        if ns.sample:
            a["sample"] = True
        if ns.utilization is not None:
            a["utilization"] = ns.utilization
    else:
        a.setdefault("now", _now_iso())
    return a or None


def main(argv=None) -> int:
    from kb.core import config, opsdb, paths
    ap = argparse.ArgumentParser(prog="kb-agent-run")
    ap.add_argument("job")
    ap.add_argument("--engine", choices=("openrouter", "anthropic_api"), required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sample", action="store_true")
    ap.add_argument("--args", default=None, help="워크플로우 args(JSON)")
    ap.add_argument("--utilization", type=float, default=None, help="5시간 활용률(0~1). 문턱 이상이면 워크플로우가 건너뛴다")
    ap.add_argument("--model", default=None)
    ap.add_argument("--max-budget-usd", type=float, default=None)
    ns = ap.parse_args(argv)
    share = str(paths.share_dir())
    os.chdir(share)
    try:
        call = invoke.build(ns.job, share, args=make_args(ns, ns.job), model=ns.model, max_budget=ns.max_budget_usd, engine=ns.engine)
    except (KeyError, ValueError) as e:
        print(f"kb-agent-run: {e}", file=sys.stderr)
        return 2
    if ns.dry_run:
        print(call.shell())
        for w in call.warnings:
            print(f"# 경고: {w}", file=sys.stderr)
        return 0
    missing = [n for n in call.decisions if not config.decision_ok(n)]
    if missing:
        print(f"kb-agent-run: 결정 {missing} 승인 전이라 실제 호출을 하지 않는다", file=sys.stderr)
        return EXIT_GATE
    from kb.agentrun import auth
    from kb.extract import budget, engines, route, guard
    arm = engines.Arm('agent', call.engine, call.argv[call.argv.index('--model') + 1])
    cap = float(call.argv[call.argv.index('--max-budget-usd') + 1])
    if route.stopped() or guard.halted() or not engines.available(arm, reserve_usd=cap):
        print("kb-agent-run: engine_held", file=sys.stderr)
        return EXIT_GATE
    try:
        with auth.environment(call.engine, call.env,
                              settings_path=os.path.join(call.cwd, call.argv[call.argv.index('--settings') + 1]),
                              mcp='--mcp-config' in call.argv) as (env, secret):
            call.argv[call.argv.index('--settings') + 1] = env['KB_API_SETTINGS']
            if '--mcp-config' in call.argv:
                call.argv[call.argv.index('--mcp-config') + 1] = env['KB_API_MCP_CONFIG']
            if not auth.preflight(call.argv[0], call.engine, env):
                auth.mismatch(call.engine)
                print("kb-agent-run: auth_signature", file=sys.stderr)
                return EXIT_GATE
            call.env = env
            return _run(call, ns, opsdb, paths, secret=secret)
    except engines.AuthError as e:
        print(f"kb-agent-run: {e}", file=sys.stderr)
        return EXIT_GATE


def _run(call, ns, opsdb, paths, secret="") -> int:
    from kb.extract import budget, engines, route
    from kb.agentrun import auth
    from kb.agentrun import record
    run_id = opsdb.record_run(f"agentrun.{call.job}")
    lines: list[str] = []
    events: list[dict] = []
    n_inc = 0
    cap = float(call.argv[call.argv.index('--max-budget-usd') + 1])
    model = call.argv[call.argv.index('--model') + 1]
    try:
        reservation = budget.admit(call.engine, model, 'agent', cap, job=call.job)
    except budget.Refused as e:
        print(f"kb-agent-run: budget_{e.reason}", file=sys.stderr)
        return EXIT_GATE
    try:
        from kb.extract import paid
        p = paid.popen(reservation, call.argv, engine=call.engine, model=model, job=call.job,
                       env=call.env, cwd=call.cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except budget.Refused as e:
        budget.release(reservation)
        print(f"kb-agent-run: admission_{e.reason}", file=sys.stderr)
        return EXIT_GATE
    except BaseException:
        budget.release(reservation)  # no child/no paid request was started
        raise
    auth_seen = False
    auth_failed = False
    over = False
    try:
        for ln in p.stdout:  # 사고는 보는 즉시 쓴다
            ln = engines.redact(ln, (secret,), partial=True)
            lines.append(ln.rstrip("\n"))
            for ev in stream.parse_lines([ln]):
                events.append(ev)
                if ev.get('type') == 'system' and ev.get('subtype') == 'init':
                    auth_seen = True
                    if not engines.auth_signature(call.engine, ev, phase='init', mechanism='helper'):
                        auth_failed = True
                        auth.mismatch(call.engine)
                        p.terminate()
                if ev.get("type") == "rate_limit_event":
                    try:
                        record.write_rate_limit(ev, call.job)
                    except Exception:  # noqa: BLE001
                        pass
                if ev.get("type") in ("result", "system", "assistant", "user"):
                    for inc in stream.incidents_in(ev):
                        record.write_incident(call.job, inc, run_id)
                        n_inc += 1
        rc = p.wait()
    finally:
        # Results may be absent after a crash/interrupt; then charge the reservation.
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        result = next((e for e in reversed(events) if e.get('type') == 'result'), {})
        over = budget.settle(reservation, result.get('total_cost_usd'))
    runs = paths.ops_dir() / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    arch = _archive(runs / f"{stamp}-{call.job}.ndjson", lines)
    v = verdict.judge(events)
    if not auth_seen or auth_failed:
        if not auth_seen:
            auth.mismatch(call.engine)
        v.ok, v.reasons = False, sorted(set(v.reasons + ['auth_signature']))
    if over:
        route.set_off(call.engine, 'cost_exceeded', None)
        from kb.extract import state
        state.incident('other', f'Workflow cost exceeded reservation: {call.engine}')
        v.ok, v.reasons = False, sorted(set(v.reasons + ['cost_exceeded']))
    if rc != 0 and v.ok:
        v.ok, v.reasons = False, [f"exit:{rc}"]
    from kb.extract.engines import Arm
    result = next((e for e in reversed(events) if e.get('type') == 'result'), {})
    payload = result.get('structured_output') or result.get('result') or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    units = payload.get('accepted', sum(t.get('accepted', 0) for t in payload.get('tickets', []) if isinstance(t, dict)))
    units = max(0, units) if isinstance(units, int) else 0
    rejected = payload.get('rejected', 0)
    rejected = max(0, rejected) if isinstance(rejected, int) else 0
    engines.record(Arm('agent', call.engine, call.argv[call.argv.index('--model') + 1]),
                   cost=budget.settlement_amount(reservation, result.get('total_cost_usd')), accepted=units if v.ok else 0,
                   rejected=rejected + int(not v.ok), held=int(v.ok and not units),
                   schema_failed=not v.ok)
    opsdb.record_run(f"agentrun.{call.job}", run_id=run_id, outcome="ok" if v.ok else "failed",
                     detail={"engine": call.engine, "reasons": v.reasons, "archive": arch, "incidents": n_inc})
    print(json.dumps({"job": call.job, "engine": call.engine, "ok": v.ok, "reasons": v.reasons, "incidents": n_inc, "archive": arch}, ensure_ascii=False))
    return 0 if v.ok else 1


if __name__ == "__main__":
    sys.exit(main())
