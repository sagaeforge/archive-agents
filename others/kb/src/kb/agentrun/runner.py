"""kb-agent-run 본체. share_dir()로 cd해 설정과 정의를 그 아래에서 찾는다.
  kb-agent-run [--dry-run] [--sample] [--args JSON] [--utilization X] [--model M] [--max-budget-usd N] <작업>
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
        call = invoke.build(ns.job, share, args=make_args(ns, ns.job), model=ns.model, max_budget=ns.max_budget_usd)
    except KeyError as e:
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
    return _run(call, ns, opsdb, paths)


def _run(call, ns, opsdb, paths) -> int:
    from kb.agentrun import record
    run_id = opsdb.record_run(f"agentrun.{call.job}")
    lines: list[str] = []
    events: list[dict] = []
    n_inc = 0
    p = subprocess.Popen(call.argv, env=call.env, cwd=call.cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    for ln in p.stdout:  # 사고는 보는 즉시 쓴다
        lines.append(ln.rstrip("\n"))
        for ev in stream.parse_lines([ln]):
            events.append(ev)
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
    runs = paths.ops_dir() / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    arch = _archive(runs / f"{stamp}-{call.job}.ndjson", lines)
    v = verdict.judge(events)
    if rc != 0 and v.ok:
        v.ok, v.reasons = False, [f"exit:{rc}"]
    opsdb.record_run(f"agentrun.{call.job}", run_id=run_id, outcome="ok" if v.ok else "failed",
                     detail={"reasons": v.reasons, "archive": arch, "incidents": n_inc})
    print(json.dumps({"job": call.job, "ok": v.ok, "reasons": v.reasons, "incidents": n_inc, "archive": arch}, ensure_ascii=False))
    return 0 if v.ok else 1


if __name__ == "__main__":
    sys.exit(main())
