"""읽기 시험 도우미: 원장에 이벤트를 넣고 gold로 투영한 뒤 읽기 코어로 읽는다."""
from __future__ import annotations

import itertools
from contextlib import contextmanager

from kb.core import cas, ledger
from kb.core.canon import canon_json, sha256_hex
from kb.project import create_gold, project_tail
from kb.read import ReadCtx, reading

_n = itertools.count(1)
T0 = 1_800_000_000_000  # 2027-01-15 08:00:00 UTC
DAY = 86_400_000


def E(kind, payload, subject=None, origin="external", actor="collector:t", at=None, **kw):
    n = next(_n)
    ev = {"kind": kind, "actor": actor, "origin": origin, "idem_key": f"r{n}", "payload": payload,
          "subject": subject, "at": at if at is not None else T0 + n * 1000}
    ev.update(kw)
    return ev


def put_doc(paras):
    text, plist = "", []
    for t in paras:
        if text:
            text += "\n\n"
        a = len(text)
        text += t
        plist.append({"para_sha": sha256_hex(t), "start_cp": a, "end_cp": len(text), "heading_path": [], "table_header": None})
    return cas.put(text.encode()), cas.put(canon_json(plist)), text


def snap(sid="n-1", url="https://a.example/doc", source="src:a", domain=None, paras=("첫 문단입니다.", "둘째 문단입니다."),
         raw="a" * 64, at=None, **extra):
    tsha, psha, _ = put_doc(list(paras))
    p = {"id": sid, "document_id": "d-" + sid, "source": source, "url": url, "raw_sha": raw, "fetched_at": T0,
         "content_type": "text/plain", "http_status": 200}
    p.update(extra)
    if domain is not None:
        p["domain"] = domain
    kw = {"at": at} if at else {}
    return [E("snapshot.captured", p, sid, **kw),
            E("snapshot.text", {"snapshot": sid, "text_sha": tsha, "text_format": "text", "extractor": "x@1", "paras_sha": psha}, sid, **kw)]


def claim(cid, subject, statement, kind="state", snap_id="n-1", at=None, **kw):
    p = {"id": cid, "subject": subject, "statement": statement, "kind": kind, "stance": "stated", "method": "llm",
         "verification": "quote_found", "evidence": [{"snapshot": snap_id, "selector_kind": "text_quote", "exact": statement}]}
    p.update(kw)
    return E("claim.assert", p, cid, **({"at": at} if at else {}))


def entity(eid, label=None, at=None, **kw):
    t = eid.split(":")[1].capitalize()
    p = {"id": eid, "type": t, "label": label or eid}
    p.update(kw)
    return E("entity.put", p, eid, **({"at": at} if at else {}))


def record(rid, title, sens="internal", body="본문", at=None, **kw):
    p = {"id": rid, "type": "Note", "title": title, "sensitivity": sens, "body": body}
    p.update(kw)
    return E("record.put", p, rid, origin="first_party", actor="user:sagae", **({"at": at} if at else {}))


def verdict(target, status, liveness, at=None, **kw):
    p = {"target": target, "unit": "tool", "liveness": liveness, "status": status, "signals": [{"id": "M05"}], "decided_by": "agent:t"}
    p.update(kw)
    return E("survival.verdict", p, target, **({"at": at} if at else {}))


class World:
    """원장 + gold. add()로 이벤트를 넣으면 바로 투영한다."""

    def __init__(self, kb_home, name="g"):
        self.led = ledger.open_ledger()
        self.path = kb_home / "scratch" / f"{name}.db"
        self.gold = create_gold(self.path)

    def add(self, *evs):
        flat = []
        for e in evs:
            flat.extend(e if isinstance(e, list) else [e])
        ledger.append(self.led, flat)
        assert project_tail(self.led, self.gold, None, 10 ** 6).caught_up
        return self

    def ctx(self, **kw):
        return ReadCtx.build(db_path=self.path, **kw)

    @contextmanager
    def rd(self, **kw):
        c = self.ctx(**kw)
        with reading(c) as con:
            yield con, c

    def close(self):
        self.gold.close()
        self.led.close()
