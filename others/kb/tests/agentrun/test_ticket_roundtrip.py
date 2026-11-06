"""kb_request -> kb_ticket_list -> ticket 머리 묶음 제출 -> ANSWERS 엣지 -> kb_ticket_close -> kb_status의 티켓 상태."""
import json

from helpers_mcp import caller

URL = "https://example.org/ypp"
DOC = b"# YPP\n\nThe YouTube Partner Program requires 1000 subscribers for monetization.\n"


def test_ticket_roundtrip(kbenv, monkeypatch):
    from kb import read
    from kb.collect import capturer
    from kb.collect.capturer import SnapshotRef
    from mhelp import capture
    default, coll = caller("default"), caller("collector")
    r = json.loads(default("kb_request", topic="YPP 진입 기준", reason="채널 설계", priority="high"))
    tid = r["ticket"]
    assert r["status"] == "queued"
    listed = coll("kb_ticket_list", status="queued")
    assert tid in listed
    sid = capture(URL, DOC)
    monkeypatch.setattr(capturer, "capture", lambda src, url, **kw: SnapshotRef(
        source=src.id, url=url, outcome="captured", status=200, snapshot=sid, new=True, bytes=len(DOC), content_type="text/markdown"))
    assert coll("kb_fetch", url=URL).split("\t")[0] == sid
    quote = next(ln for ln in coll("kb_source", id=sid).split("\n", 1)[1].splitlines() if ln.startswith("The YouTube Partner"))
    bundle = [
        {"item": "bundle", "contract": "kb-ingest/1", "batch_id": "tk-1", "producer": "agent:kb-collector", "domain": ["D"],
         "created_at": "2026-11-01T00:00:00Z", "ticket": tid},
        {"item": "entity", "ref": "e1", "key": "feature:ypp", "type": "Feature", "label": "YouTube Partner Program"},
        {"item": "claim", "ref": "c1", "subject": "e1", "statement": quote, "kind": "state", "stance": "stated",
         "evidence": {"snapshot": sid, "quote": quote}, "method": "llm"},
    ]
    rep = coll("kb_ingest_submit", bundle=bundle)
    assert "rejected=0" in rep and "accepted=2" in rep, rep
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    with read.reading(ctx) as con:
        data, _ = read.node_edges(con, ctx, tid, direction="in", rtypes=["ANSWERS"])
    assert any(e.get("rtype") == "ANSWERS" or e.get("type") == "ANSWERS" for e in data["items"]), data
    assert coll("kb_ticket_close", id=tid, status="done")
    from kb.serve.mcp import status_text   # kb_status와 같은 본문. 도구는 300토큰 예산에서 이 줄을 자른다
    st = status_text(None, tid, 3000)
    assert f"ticket\t{tid}\tdone" in st, st
