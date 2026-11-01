"""test_swap_real이 띄우는 쓰기 프로세스. kb.write 경로만 쓴다."""
import os
import sys
import threading
import time

from kb.write import commit, put_record

tag, n, outdir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
while not os.path.exists(os.path.join(outdir, "go")):
    time.sleep(0.005)
errs = []


def run(t):
    ack = os.path.join(outdir, f"ack-{tag}{t}.txt")
    try:
        for i in range(n):
            key = f"sw:{tag}{t}:{i}"
            if i % 2:
                r = put_record({"type": "Note", "title": f"쓰기 {tag}{t} {i}", "body": "본문"}, key, "mcp", f"s-{tag}")
                rid = r.id
            else:
                rid = f"e:concept:{tag}{t}-{i}"
                commit([{"kind": "entity.put", "actor": "collector:swap", "origin": "external", "idem_key": key,
                         "subject": rid, "payload": {"id": rid, "type": "Concept", "label": f"개념 {tag}{t} {i}"}}])
            with open(ack, "a") as f:
                f.write(f"{rid} {key}\n")
                f.flush()
                os.fsync(f.fileno())
            time.sleep(0.004)
    except BaseException as e:  # noqa: BLE001
        errs.append(repr(e))


ts = [threading.Thread(target=run, args=(t,)) for t in range(2)]
[t.start() for t in ts]
[t.join() for t in ts]
if errs:
    open(os.path.join(outdir, f"err-{tag}.txt"), "w").write("\n".join(errs))
    sys.exit(1)
