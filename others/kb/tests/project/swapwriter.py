"""test_swap_under_write.py가 띄우는 쓰기 프로세스. 게이트를 쥐고 원장에 쓰고 current gold에 투영한다."""
import json
import os
import sys
import threading
import time

from kb.core import cas, ledger
from kb.core.canon import canon_json, sha256_hex
from kb.core.gatelock import Gate
from kb.project import current_gold_path, gate_path, open_gold, project_tail


def commit(events):
    gate = Gate(gate_path())
    fd = gate.acquire(60)
    try:
        led = ledger.open_ledger()
        try:
            res = ledger.append(led, events)
            p = current_gold_path()
            if p is not None:
                g = open_gold(p)
                try:
                    while not project_tail(led, g, 100, 200).caught_up:
                        pass
                finally:
                    g.close()
            return res
        finally:
            led.close()
    finally:
        gate.release(fd)


def ev(kind, payload, subject, key, origin="external"):
    return {"kind": kind, "actor": "collector:swap", "origin": origin, "idem_key": key, "subject": subject, "payload": payload}


def writer(tag, n, ackf):
    for i in range(n):
        eid = f"e:concept:{tag}-{i}"
        key = f"swap:{eid}"
        res = commit([ev("entity.put", {"id": eid, "type": "Concept", "label": f"개념 {tag} {i}"}, eid, key)])
        with open(ackf, "a") as f:  # 확인 응답을 받은 뒤에만 적는다
            f.write(f"{eid} {res[0]['seq']} {key}\n")
            f.flush(); os.fsync(f.fileno())
        time.sleep(0.004)


def promoter(tag, n, ackf):
    for b in range(n):
        sid = f"n-{tag}{b}"
        paras = [f"{tag} 배치 {b} 문단 {k} 입니다." for k in range(6)]
        text = "\n\n".join(paras)
        pl, pos = [], 0
        for t in paras:
            a = text.index(t, pos)
            pl.append({"para_sha": sha256_hex(t), "start_cp": a, "end_cp": a + len(t), "heading_path": [], "table_header": None})
            pos = a + len(t)
        tsha, psha = cas.put(text.encode()), cas.put(canon_json(pl))
        eid = f"e:concept:{tag}-{b}"
        evs = [ev("entity.put", {"id": eid, "type": "Concept", "label": f"승격 {tag} {b}"}, eid, f"swap:{eid}"),
               ev("snapshot.captured", {"id": sid, "document_id": "d-" + sid, "source": "src:swap", "url": f"https://x.example/{sid}",
                                        "raw_sha": "b" * 64, "fetched_at": 1}, sid, f"swap:{sid}:c"),
               ev("snapshot.text", {"snapshot": sid, "text_sha": tsha, "text_format": "text", "extractor": "x@1", "paras_sha": psha},
                  sid, f"swap:{sid}:t")]
        for k in range(10):
            cid = f"c-{tag}{b}x{k}"
            evs.append(ev("claim.assert", {"id": cid, "subject": eid, "statement": f"{tag} {b} 주장 {k}", "kind": "state", "stance": "stated",
                                           "method": "llm", "verification": "quote_found",
                                           "evidence": [{"snapshot": sid, "selector_kind": "text_quote", "exact": "x"}]},
                          cid, f"swap:{cid}"))
        res = commit(evs)
        with open(ackf, "a") as f:
            f.write(f"{eid} {res[0]['seq']} swap:{eid}\n")
            f.flush(); os.fsync(f.fileno())
        time.sleep(0.01)


def main():
    mode, tag, n, outdir = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    while not os.path.exists(os.path.join(outdir, "go")):
        time.sleep(0.005)
    fn = writer if mode == "write" else promoter
    errs = []

    def run(t):
        try:
            fn(f"{tag}{t}", n, os.path.join(outdir, f"ack-{tag}{t}.txt"))
        except BaseException as e:  # noqa: BLE001
            errs.append(repr(e))
    ts = [threading.Thread(target=run, args=(t,)) for t in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    if errs:
        with open(os.path.join(outdir, f"err-{tag}.txt"), "w") as f:
            f.write("\n".join(errs))
        sys.exit(1)


if __name__ == "__main__":
    main()
