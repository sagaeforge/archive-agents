"""--profile collector: 도구 8개, 일반 프로필에는 적재 도구 없음, kb_fetch 뒤 kb_source로 읽은 인용구가 kb_ingest_validate를 통과."""
import asyncio

import pytest

from mhelp import capture

COLLECTOR = {"kb_fetch", "kb_source", "kb_get", "kb_ingest_validate", "kb_ingest_submit", "kb_search", "kb_ticket_list",
             "kb_ticket_close"}
URL2 = "https://example.org/widget"
DOC2 = b"# Widget Toolkit\n\nThe Widget Toolkit stores 5 widgets per page.\n"


def test_profile_tools(factory):
    c = factory(args=("--profile", "collector"))
    assert {t["name"] for t in c.tools()} == COLLECTOR and len(c.tools()) == 8
    d = factory()
    names = {t["name"] for t in d.tools()}
    assert not names & {"kb_fetch", "kb_ingest_validate", "kb_ingest_submit", "kb_ticket_list", "kb_ticket_close"}


def test_record_items_rejected_in_collector_profile(factory):
    c = factory(args=("--profile", "collector"))
    hdr = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": "rj-1", "producer": "agent:kb-collector", "domain": ["E"],
           "created_at": "2026-11-01T00:00:00Z"}
    rec = {"item": "record", "ref": "r1", "type": "Note", "title": "t", "body": "b"}
    text, err, _ = c.call("kb_ingest_validate", bundle=[hdr, rec], fetch=False)
    assert not err and "rejected" in text and "accepted=0" in text


def test_fetch_then_source_then_validate(monkeypatch, kbenv):
    from kb.collect import capturer
    from kb.collect.capturer import SnapshotRef
    from kb.serve.mcp import build_server
    sid = capture(URL2, DOC2)

    def fake_capture(src, url, **kw):
        assert url == URL2
        return SnapshotRef(source=src.id, url=url, outcome="captured", status=200, snapshot=sid, new=True, bytes=len(DOC2),
                           content_type="text/markdown")
    monkeypatch.setattr(capturer, "capture", fake_capture)
    srv = build_server("collector")

    def call(name, **a):
        res = asyncio.run(srv.call_tool(name, a))
        blocks = res.content if hasattr(res, "content") else res
        return "\n".join(getattr(b, "text", "") for b in blocks)

    out = call("kb_fetch", url=URL2)
    assert out.split("\t")[0] == sid
    src = call("kb_source", id=sid)
    assert src.startswith("#src\t") and "range=" in src
    body = src.split("\n", 1)[1]
    quote = next(ln for ln in body.splitlines() if ln.startswith("The Widget Toolkit"))
    hdr = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": "cv-1", "producer": "agent:kb-collector", "domain": ["E"],
           "created_at": "2026-11-01T00:00:00Z"}
    ent = {"item": "entity", "ref": "e1", "key": "concept:widget-toolkit", "type": "Concept", "label": "Widget Toolkit"}
    cl = {"item": "claim", "ref": "c1", "subject": "e1", "statement": quote, "kind": "state", "stance": "stated",
          "evidence": {"snapshot": sid, "quote": quote}, "method": "llm"}
    rep = call("kb_ingest_validate", bundle=[hdr, ent, cl], fetch=False)
    assert "accepted=2" in rep and "rejected=0" in rep, rep
    sub = call("kb_ingest_submit", bundle=[hdr, ent, cl], fetch=False)
    assert "rejected=0" in sub
    again = call("kb_ingest_submit", bundle=[hdr, ent, cl], fetch=False)
    assert "new_events=0" in again


def test_ticket_tools(monkeypatch, kbenv):
    from kb import ticket
    from kb.serve.mcp import build_server
    t = ticket.open_ticket("컬렉터 시험 주제", "시험", "high", transport="cli")
    srv = build_server("collector")

    def call(name, **a):
        res = asyncio.run(srv.call_tool(name, a))
        blocks = res.content if hasattr(res, "content") else res
        return "\n".join(getattr(b, "text", "") for b in blocks)
    listing = call("kb_ticket_list", status="queued")
    assert t["ticket"] in listing
    closed = call("kb_ticket_close", id=t["ticket"], status="unanswerable", note="시험")
    assert '"status":"unanswerable"' in closed
    assert t["ticket"] not in call("kb_ticket_list", status="queued")
    with pytest.raises(Exception):
        call("kb_ticket_close", id=t["ticket"], status="bogus")
