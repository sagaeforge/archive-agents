import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from kb.write import commit, engine, put_record  # noqa: E402
from wrhelp import promote_events  # noqa: E402

kind, idx, outdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
WAIT, HOLD = [], []


class TimedGate(engine.Gate):
    def acquire(self, timeout=5.0):
        t = time.perf_counter()
        fd = super().acquire(timeout)
        WAIT.append((time.perf_counter() - t) * 1000)
        self._t = time.perf_counter()
        return fd

    def release(self, fd):
        HOLD.append((time.perf_counter() - self._t) * 1000)
        super().release(fd)


engine.Gate = TimedGate
PH = {"append": [], "project": []}
_orig_project, _orig_append = engine._project, engine.ledger.append


_PR = None
if os.environ.get("KB_PERF_PROF") and kind == "rec" and idx == 0 and not os.environ.get("KB_PERF_NOPROJ"):
    import cProfile
    _PR = cProfile.Profile()


def _tp(*a, **k):
    t = time.perf_counter()
    try:
        if _PR is not None:
            _PR.enable()
        return _orig_project(*a, **k)
    finally:
        if _PR is not None:
            _PR.disable()
        PH["project"].append((time.perf_counter() - t) * 1000)


def _ta(*a, **k):
    t = time.perf_counter()
    try:
        return _orig_append(*a, **k)
    finally:
        PH["append"].append((time.perf_counter() - t) * 1000)


engine._project = _tp
if os.environ.get("KB_PERF_NOPROJ"):
    _orig_project = lambda led, budget=200: (False, [])
engine.ledger.append = _ta
try:  # 장수 세션을 흉내 낸다: 규칙 컴파일과 스키마 적재 같은 첫 호출 비용은 재지 않는다
    put_record({"type": "Note", "title": "워밍업", "body": "x"}, f"warm:{kind}{idx}:{outdir[-8:]}", "mcp", f"s-{idx}")
except Exception as e:  # noqa: BLE001
    print(repr(e), file=sys.stderr)
WAIT.clear()
HOLD.clear()
while not os.path.exists(os.path.join(outdir, "go")):
    time.sleep(0.005)
lat, errs = [], 0
tag = f"{outdir[-6:]}{kind}{idx}"
N = int(os.environ.get("KB_PERF_N", "40"))
THINK = float(os.environ.get("KB_PERF_THINK", "0.010"))
for i in range(N if kind == "rec" else N // 2):
    evs = None
    if kind != "rec":  # 승격 입력(CAS 쓰기)은 수집기 쪽 비용이라 재지 않는다. 쓰기 호출 시간만 잰다
        evs = []
        for g in range(5):  # 게이트 보유당 200문단
            evs += promote_events(f"{tag}g{g}", i, 40)
        for e in evs:
            e["idem_key"] += f":{tag}"
    t0 = time.perf_counter()
    try:
        if kind == "rec":
            r = put_record({"type": "Note", "title": f"성능 {tag} {i}", "body": "문단\n\n둘째 문단입니다. " * 5},
                           f"perf:{tag}:{i}", "mcp", f"s-{idx}")
        else:
            commit(evs)
    except Exception as e:  # noqa: BLE001
        errs += 1
        print(repr(e), file=sys.stderr)
    lat.append((time.perf_counter() - t0) * 1000)
    time.sleep(0.010 if kind != "rec" else THINK)
if _PR is not None:
    import pstats
    pstats.Stats(_PR, stream=open(os.environ["KB_PERF_PROF"], "w")).sort_stats("tottime").print_stats(14)
json.dump({"phase": {k: sorted(v)[len(v) // 2] for k, v in PH.items() if v}, "lat": lat, "errors": errs, "wait": WAIT, "hold": HOLD}, open(os.path.join(outdir, f"lat-{kind}{idx}.json"), "w"))
