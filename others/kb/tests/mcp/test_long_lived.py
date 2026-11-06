"""긴 수명: current 교체와 옛 빌드 삭제가 호출을 깨지 않고, KB_MCP_SUPERVISED=1이면 runtime/venv 교체를 감지해 유휴에서 끝난다."""
import json
import os
import shutil
import threading
import time

from kb.core.gatelock import Gate
from kb.project import current_build, gate_path, gold_root, rebuild
from kb.write import put_record

from mhelp import fake_kb, lines, wait_for


def note(title, body, key):
    r = put_record({"title": title, "body": body}, key, "mcp", session="ll")
    assert r.projected, r
    return r.id


def cards(m, q):
    t, err, _ = m.call("kb_search", q=q, k=50, budget=6000)
    assert not err, t
    return t


def runtime(kbenv):
    rt = kbenv.home / "runtime"
    for n in ("venv-A", "venv-B"):
        (rt / n).mkdir(parents=True, exist_ok=True)
    point(rt, "venv-A")
    return rt


def point(rt, to):
    tmp = rt / "venv.new"
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(to)
    os.replace(tmp, rt / "venv")


def sup(kbenv, name):
    d = kbenv.home / "fake"
    d.mkdir(exist_ok=True)
    log = d / f"{name}.log"
    log.unlink(missing_ok=True)
    return {"KB_MCP_SUPERVISED": "1", "KB_MCP_WATCH_S": "0.2", "KB_SHIP_BIN": fake_kb(d, log)}, log


def test_gold_swap_and_old_build_deleted(factory, kbenv):
    m = factory()
    assert "swapalpha" not in cards(m, "swapalpha")
    a = note("교체 시험 알파", "swapalpha body", "ll-a")
    assert a in cards(m, "swapalpha")
    old = current_build()
    rebuild()
    assert current_build() != old
    b = note("교체 시험 베타", "swapbeta body", "ll-b")       # 새 빌드에만 있다
    t = cards(m, "swapbeta")
    assert b in t and a in cards(m, "swapalpha")
    shutil.rmtree(gold_root() / old)                            # 옛 빌드 삭제 뒤에도 호출이 성공한다
    assert b in cards(m, "swapbeta")


def test_supervised_exits_on_venv_swap_and_restart_works(factory, kbenv):
    rt = runtime(kbenv)
    env, log = sup(kbenv, "swap-idle")
    m = factory(env)
    assert m.call("kb_status")[1] is False
    point(rt, "venv-B")
    assert m.wait(5) == 0
    assert len(wait_for(lambda: lines(log), 2.0)) == 1
    m2 = factory(env)                                            # 다시 띄운 서버
    t, err, _ = m2.call("kb_search", q="hooks")
    assert not err and t.startswith("#kb v1")
    time.sleep(0.8)
    assert m2.p.poll() is None                                   # 교체가 없으면 계속 산다


def test_without_supervised_env_never_exits(factory, kbenv):
    rt = runtime(kbenv)
    log_env, _ = sup(kbenv, "swap-nosup")
    env = {k: v for k, v in log_env.items() if k != "KB_MCP_SUPERVISED"}
    m = factory(env)
    point(rt, "venv-B")
    time.sleep(1.2)
    assert m.p.poll() is None
    assert not m.call("kb_status")[1]
    point(rt, "venv-A")


def test_tools_list_refresh_does_not_keep_server_alive(factory, kbenv):
    rt = runtime(kbenv)
    env, log = sup(kbenv, "swap-refresh")
    m = factory(env)
    stop = threading.Event()

    def refresh():                      # tower의 60초 새로고침을 0.1초로 줄인 것
        while not stop.is_set():
            try:
                m.tools()
            except Exception:
                return
            time.sleep(0.1)
    th = threading.Thread(target=refresh, daemon=True)
    th.start()
    time.sleep(0.5)
    point(rt, "venv-B")
    assert m.wait(5) == 0
    stop.set()
    assert len(wait_for(lambda: lines(log), 2.0)) == 1


def test_in_flight_call_defers_exit_until_it_finishes(factory, kbenv):
    rt = runtime(kbenv)
    env, log = sup(kbenv, "swap-busy")
    m = factory(env)
    gate = Gate(gate_path())
    fd = gate.acquire(5.0)
    out = {}

    def call():
        out["r"] = m.call("kb_put", record={"title": "처리 중 호출", "body": "b"}, idempotency_key="ll-busy")
    th = threading.Thread(target=call)
    th.start()
    time.sleep(0.4)
    point(rt, "venv-B")
    time.sleep(1.3)
    assert m.p.poll() is None, "처리 중 호출이 있는데 끝났다"
    gate.release(fd)
    th.join(15)
    text, err, _ = out["r"]
    assert not err and json.loads(text)["id"].startswith("f-")  # 응답은 나갔다
    assert m.wait(5) == 0
    assert len(wait_for(lambda: lines(log), 2.0)) == 1
