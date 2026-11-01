"""SIGKILL 시험용 자식 프로세스. 가짜 네트워크를 깔고 tick을 돌다가 KILL 지점에서 스스로 SIGKILL을 맞는다.
환경: KILL=<지점>:<n>  (fetch: n번째 요청, after_cas: n번째 cas.put 직후, before_commit/after_commit: n번째 commit 앞/뒤)"""
import json
import os
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collect.fakenet import World  # noqa: E402

from kb.collect import capturer, hostpolicy  # noqa: E402

hostpolicy.DEFAULT_INTERVAL_S = 0.0
point, _, n = os.environ.get("KILL", "").partition(":")
n = int(n or 0)
count = {"fetch": 0, "after_cas": 0, "before_commit": 0, "after_commit": 0}


def hit(name):
    count[name] += 1
    if point == name and count[name] == n:
        os.kill(os.getpid(), signal.SIGKILL)


class W(World):
    pass


w = World()
spec = json.loads(os.environ["WORLD"])
for host, path, body in spec:
    def fn(headers, body=body):
        hit("fetch")
        from collect.fakenet import Resp
        return Resp(200, body.encode(), {"Content-Type": "text/plain"})
    w.route_fn(host, path, fn)
w.add("k.example", "/robots.txt", 404)


class MP:
    def setattr(self, obj, name, val):
        setattr(obj, name, val)


w.install(MP())
real_put = capturer.cas.put


def put(data, tier="objects"):
    r = real_put(data, tier=tier)
    hit("after_cas")
    return r


capturer.cas.put = put
import kb.write as kw  # noqa: E402
import kb.write.engine as eng  # noqa: E402

real_commit = eng.commit


def commit(events, *a, **k):
    hit("before_commit")
    r = real_commit(events, *a, **k)
    hit("after_commit")
    return r


kw.commit = commit
eng.commit = commit

from kb.collect.tick import run_tick  # noqa: E402

report, rc = run_tick(only=None)
print(json.dumps(report))
sys.exit(rc)
