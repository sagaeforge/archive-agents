import statistics
import time

import pytest

from kb.core import ledger, paths
from kb.core.gatelock import Gate

pytestmark = pytest.mark.perf


def test_single_write_p99(kb_home):
    assert paths.check_fs(kb_home) == "ext4"
    gate = Gate(kb_home / "gate.lock")
    ms = []
    for i in range(400):
        t0 = time.perf_counter()
        fd = gate.acquire(5)
        try:
            c = ledger.open_ledger()
            try:
                ledger.append(c, [{"kind": "record.put", "actor": "user:sagae", "origin": "first_party",
                                   "subject": f"f-{i}", "idem_key": f"p{i}", "payload": {"i": i, "t": "x" * 200}}])
            finally:
                c.close()
        finally:
            gate.release(fd)
        ms.append((time.perf_counter() - t0) * 1000)
    ms = ms[20:]
    q = statistics.quantiles(ms, n=100)
    print(f"p50={q[49]:.1f} p95={q[94]:.1f} p99={q[98]:.1f} max={max(ms):.1f} ms")
    assert q[98] <= 50
