import time

from mhelp import Mcp


def test_cold_initialize_8_runs(kbenv):
    worst = 0.0
    for _ in range(8):
        t0 = time.monotonic()
        m = Mcp(dict(kbenv.env))
        try:
            m.init()
            worst = max(worst, time.monotonic() - t0)
        finally:
            m.kill()
    assert worst <= 2.0, worst
