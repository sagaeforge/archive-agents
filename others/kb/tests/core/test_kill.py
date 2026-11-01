import os
import random
import signal
import subprocess
import sys
import threading
from pathlib import Path

from kb.core import ledger

HERE = Path(__file__).parent
ROUNDS = 100


def _drain(p, n_acks, acks, ev):
    for line in p.stdout:
        parts = line.split()
        if len(parts) == 3 and parts[0] == "ack":
            acks[parts[1]] = int(parts[2])
            if len(acks) >= n_acks:
                ev.set()


def test_sigkill_loses_no_acked_write(kb_home):
    rng = random.Random(11)
    acked: dict[str, int] = {}
    for rnd in range(ROUNDS):
        procs = [subprocess.Popen([sys.executable, str(HERE / "_kill_writer.py"), f"r{rnd}p{j}"],
                                  stdout=subprocess.PIPE, text=True, env=os.environ.copy()) for j in range(2)]
        got: dict[str, int] = {}
        ev = threading.Event()
        want = rng.randint(1, 6)
        ths = [threading.Thread(target=_drain, args=(p, want, got, ev), daemon=True) for p in procs]
        [t.start() for t in ths]
        assert ev.wait(60), f"라운드 {rnd}: ack 없음"
        for p in procs:
            os.kill(p.pid, signal.SIGKILL)
        for p in procs:
            p.wait()
        [t.join(5) for t in ths]
        acked.update(got)
        c = ledger.open_ledger()
        try:
            v = ledger.verify_chain(c)
            assert v.ok, (rnd, v.errors)
            have = dict(c.execute("SELECT idem_key, seq FROM event"))
            lost = [k for k, s in acked.items() if have.get(k) != s]
            assert not lost, (rnd, lost[:5])
            assert ledger.integrity(c) == []
        finally:
            c.close()
    c = ledger.open_ledger()
    seqs = [r[0] for r in c.execute("SELECT seq FROM event ORDER BY seq")]
    assert seqs == list(range(1, len(seqs) + 1)) and len(seqs) >= len(acked) >= ROUNDS
    c.close()
