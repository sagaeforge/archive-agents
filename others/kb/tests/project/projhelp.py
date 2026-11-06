import itertools
import json
from pathlib import Path

from kb.project import create_gold

_n = itertools.count(1)
GOLDEN = Path(__file__).resolve().parents[1] / "golden" / "ledger.ndjson"


def E(kind, payload, subject=None, origin="external", actor="collector:t", at=None, **kw):
    n = next(_n)
    ev = {"kind": kind, "actor": actor, "origin": origin, "idem_key": f"t{n}", "payload": payload,
          "subject": subject, "at": at if at is not None else 1_800_000_000_000 + n * 1000}
    ev.update(kw)
    return ev


def golden_events():
    return [json.loads(x) for x in GOLDEN.read_text(encoding="utf-8").splitlines() if x]


def new_gold(kb_home, name):
    return create_gold(kb_home / "scratch" / f"{name}.db")


def put_doc(text_paras):
    """문단 목록을 표시 본문 + 문단 색인으로 CAS에 넣는다. (text_sha, paras_sha, paras)."""
    from kb.core import cas
    from kb.core.canon import canon_json, sha256_hex
    text, paras, pos = "", [], 0
    for t in text_paras:
        if text:
            text += "\n\n"
        a = len(text)
        text += t
        paras.append({"para_sha": sha256_hex(t), "start_cp": a, "end_cp": len(text), "heading_path": [], "table_header": None})
    return cas.put(text.encode()), cas.put(canon_json(paras)), paras


def snap_events(sid="n-1", url="https://a.example/doc", source="src:a", domain=None, paras=("첫 문단입니다.", "둘째 문단입니다."),
                raw="a" * 64):
    tsha, psha, _ = put_doc(list(paras))
    p = {"id": sid, "document_id": "d-" + sid, "source": source, "url": url, "raw_sha": raw, "fetched_at": 1}
    if domain is not None:
        p["domain"] = domain
    return [E("snapshot.captured", p, sid),
            E("snapshot.text", {"snapshot": sid, "text_sha": tsha, "text_format": "text", "extractor": "x@1", "paras_sha": psha}, sid)]


def claim(cid, subject, statement, kind="state", snap="n-1", **kw):
    p = {"id": cid, "subject": subject, "statement": statement, "kind": kind, "stance": "stated", "method": "llm",
         "verification": "quote_found", "evidence": [{"snapshot": snap, "selector_kind": "text_quote", "exact": statement}]}
    p.update(kw)
    return E("claim.assert", p, cid)


def entity(eid, label=None, **kw):
    t = eid.split(":")[1].capitalize()
    p = {"id": eid, "type": t, "label": label or eid}
    p.update(kw)
    return E("entity.put", p, eid)
