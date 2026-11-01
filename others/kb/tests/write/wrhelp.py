import json
import sqlite3

from kb.core import cas, ledger, opsdb
from kb.core.canon import canon_json, sha256_hex
from kb.project import current_gold_path
from kb.write import commit


def open_fp_direct():
    return commit([{"kind": "system.fp_opened", "actor": "user:sagae", "origin": "system", "subject": "fp",
                    "idem_key": "fp-opened:test", "payload": {"mode": "drill"}}])


def add_drill(ok=1, age_ms=0, kind="restore_offsite"):
    import time
    c = opsdb.connect()
    try:
        c.execute("INSERT INTO drill(at, kind, target, ok, detail) VALUES(?,?,?,?,?)",
                  (int(time.time() * 1000) - age_ms, kind, "offsite-e", ok, "test"))
    finally:
        c.close()


def events(where="1=1", args=()):
    c = ledger.open_ledger()
    try:
        return c.execute(f"SELECT seq, kind, subject, actor, on_behalf_of, idem_key, payload_sha FROM event WHERE {where} ORDER BY seq", args).fetchall()
    finally:
        c.close()


def count_events(kind=None):
    c = ledger.open_ledger()
    try:
        if kind:
            return c.execute("SELECT count(*) FROM event WHERE kind=?", (kind,)).fetchone()[0]
        return c.execute("SELECT count(*) FROM event").fetchone()[0]
    finally:
        c.close()


def gold_row(sql, args=()):
    from kb.project import open_gold
    g = open_gold(current_gold_path())
    try:
        return g.execute(sql, args).fetchall()
    finally:
        g.close()


def ev(kind, payload, subject, key, origin="external", actor="collector:t"):
    return {"kind": kind, "actor": actor, "origin": origin, "idem_key": key, "subject": subject, "payload": payload}


def promote_events(tag, b, nparas=40, ncl=0):
    """snapshot.captured + snapshot.text(nparas 문단) [+ 주장]. 실제 크기 승격 표본."""
    sid = f"n-{tag}{b}"
    paras = [f"{tag} 배치 {b} 문단 {k} 입니다." for k in range(nparas)]
    text = "\n\n".join(paras)
    pl, pos = [], 0
    for t in paras:
        a = text.index(t, pos)
        pl.append({"para_sha": sha256_hex(t), "start_cp": a, "end_cp": a + len(t), "heading_path": [], "table_header": None})
        pos = a + len(t)
    tsha, psha = cas.put(text.encode()), cas.put(canon_json(pl))
    eid = f"e:concept:{tag}-{b}"
    evs = [ev("entity.put", {"id": eid, "type": "Concept", "label": f"승격 {tag} {b}"}, eid, f"pr:{eid}"),
           ev("snapshot.captured", {"id": sid, "document_id": "d-" + sid, "source": "src:swap", "url": f"https://x.example/{sid}",
                                    "raw_sha": "b" * 64, "fetched_at": 1}, sid, f"pr:{sid}:c"),
           ev("snapshot.text", {"snapshot": sid, "text_sha": tsha, "text_format": "text", "extractor": "x@1", "paras_sha": psha},
              sid, f"pr:{sid}:t")]
    for k in range(ncl):
        cid = f"c-{tag}{b}x{k}"
        evs.append(ev("claim.assert", {"id": cid, "subject": eid, "statement": f"{tag} {b} 주장 {k}", "kind": "state",
                                       "stance": "stated", "method": "llm", "verification": "quote_found",
                                       "evidence": [{"snapshot": sid, "selector_kind": "text_quote", "exact": "x"}]},
                      cid, f"pr:{cid}"))
    return evs
