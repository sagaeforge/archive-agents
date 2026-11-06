"""동기 도구가 오래 걸려도 이벤트 루프가 막히지 않는다(ping 왕복 50 ms 이하). 모든 도구가 async def가 아니다(소스 검사)."""
import ast
import threading
import time
from pathlib import Path

from kb.core.gatelock import Gate
from kb.project import gate_path

SRC = Path(__file__).resolve().parents[2] / "src" / "kb" / "serve"


def test_no_async_def_in_sources():
    for name in ("mcp.py", "mcp_collect.py"):
        tree = ast.parse((SRC / name).read_text(encoding="utf-8"))
        assert not [n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)], name


def test_ping_while_tool_blocks(server):
    gate = Gate(gate_path())
    fd = gate.acquire(5.0)       # kb_put이 게이트를 기다리는 동안 도구가 막힌다
    done = {}

    def call():
        t0 = time.monotonic()
        done["r"] = server.call("kb_put", record={"title": "격리 시험", "body": "b"}, idempotency_key="iso-1")
        done["dt"] = time.monotonic() - t0
    th = threading.Thread(target=call)
    th.start()
    time.sleep(0.15)
    rtts = []
    t_end = time.monotonic() + 0.4
    while time.monotonic() < t_end:
        t0 = time.monotonic()
        r = server.rpc("ping")
        rtts.append(time.monotonic() - t0)
        assert "result" in r
        time.sleep(0.03)
    gate.release(fd)
    th.join(15)
    assert "dt" in done and done["dt"] >= 0.5       # 도구는 실제로 막혀 있었다
    assert max(rtts) <= 0.05, max(rtts)
