"""test_kill이 SIGKILL로 죽이는 쓰기 프로세스. 커밋 응답을 받은 뒤에만 ack 줄을 낸다."""
import sys

from kb.core import ledger
from kb.core.gatelock import Gate
from kb.core.ids import uuid7
from kb.core import paths

tag = sys.argv[1]
gate = Gate(paths.ledger_dir() / "gate.lock")
i = 0
while True:
    fd = gate.acquire(30)
    try:
        c = ledger.open_ledger()
        try:
            r = ledger.append(c, [{"kind": "record.put", "actor": "agent:kill", "origin": "first_party",
                                   "subject": f"f-{tag}-{i}", "idem_key": f"{tag}-{i}", "payload": {"i": i, "t": tag}}])[0]
        finally:
            c.close()
    finally:
        gate.release(fd)
    print(f"ack {tag}-{i} {r['seq']}", flush=True)
    i += 1
