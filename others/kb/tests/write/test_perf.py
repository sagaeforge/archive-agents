"""쓰기 p99 시험. 기본 제외(-m perf). 세션 쓰기 6 + 승격 2 프로세스(8세션), 간격 10 ms,
실제 크기 승격(이벤트당 40문단, 게이트 보유당 200문단, CAS 읽기 포함).
게이트 안 투영(기본)과 게이트 밖 비동기 투영(KB_PERF_NOPROJ=1, tick이 따라잡음)의 값을 함께 출력한다."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from kb.write.engine import project_pending

HERE = Path(__file__).parent
P99_MS = 150.0


def run_load(home: Path, noproj: bool, label: str):
    out = home / f"perf-{label}"
    out.mkdir()
    env = os.environ.copy()
    if noproj:
        env["KB_PERF_NOPROJ"] = "1"
    procs = [subprocess.Popen([sys.executable, str(HERE / "_perf_proc.py"), kind, str(i), str(out)], env=env,
                              stderr=subprocess.PIPE, stdout=subprocess.PIPE)
             for i, kind in enumerate(["rec"] * 6 + ["promo"] * 2)]
    time.sleep(1.0)
    (out / "go").write_text("1")
    for p in procs:
        assert p.wait(300) == 0, p.stderr.read().decode()
    lat, errs, by, hold, wait, phases = [], 0, {}, [], [], []
    for f in out.glob("lat-*.json"):
        d = json.loads(f.read_text())
        lat += d["lat"]
        errs += d["errors"]
        phases.append(d.get("phase"))
        hold += d.get("hold", [])
        wait += d.get("wait", [])
        by.setdefault(f.name.split("-")[1][:3], []).extend(d["lat"])
    lat.sort()
    q = lambda v, x: sorted(v)[max(0, int(len(v) * x) - 1)]  # noqa: E731
    return {"n": len(lat), "p50": round(lat[len(lat) // 2], 1), "p99": round(q(lat, 0.99), 1), "max": round(lat[-1], 1),
            "errors": errs, "hold_p50": round(sorted(hold)[len(hold) // 2], 1), "hold_p99": round(q(hold, 0.99), 1),
            "phase_p50": phases[:3], "wait_p50": round(sorted(wait)[len(wait) // 2], 1), **{f"{k}_p99": round(q(v, 0.99), 1) for k, v in by.items()}}


@pytest.mark.perf
def test_write_p99(fp_open):
    inline = run_load(fp_open, False, "inline")
    project_pending()
    async_ = run_load(fp_open, True, "async")
    project_pending()
    print(f"\n게이트 안 투영: {inline}\n게이트 밖 비동기 투영: {async_}")
    assert inline["errors"] == 0 and async_["errors"] == 0
    assert inline["p99"] <= P99_MS, inline
