"""collector 프로필 도구만으로 kb_fetch -> kb_source -> 정확한 인용구 -> kb_ingest_validate 수락(기록된 응답, 실제 모델 없음)."""
import json

from helpers_mcp import caller

URL = "https://example.org/widget"
DOC = b"# Widget Toolkit\n\nThe Widget Toolkit stores 5 widgets per page.\n"
PROFILE = "ops/job-settings/kb-collect.mcp.json"


def test_profile_file_registers_collector(repo):
    cfg = json.load(open(repo / PROFILE))
    srv = cfg["mcpServers"]["kb-collect"]
    assert srv["command"].endswith("/runtime/bin/kb-mcp") and srv["args"] == ["--profile", "collector"]


def test_recorded_collector_session(kbenv, monkeypatch):
    from mhelp import capture
    from kb.collect import capturer
    from kb.collect.capturer import SnapshotRef
    sid = capture(URL, DOC)
    monkeypatch.setattr(capturer, "capture", lambda src, url, **kw: SnapshotRef(
        source=src.id, url=url, outcome="captured", status=200, snapshot=sid, new=True, bytes=len(DOC), content_type="text/markdown"))
    call = caller("collector")
    # 에이전트가 쓰는 도구 이름이 전부 프로필에 있다
    tools = {t.name for t in __import__("asyncio").run(call.server.list_tools())}
    assert {"kb_fetch", "kb_source", "kb_ingest_validate", "kb_ingest_submit", "kb_ticket_list", "kb_ticket_close"} <= tools
    # 기록된 에이전트 행동: fetch -> source -> 본문 문장을 그대로 인용 -> validate
    assert call("kb_fetch", url=URL).split("\t")[0] == sid
    body = call("kb_source", id=sid).split("\n", 1)[1]
    quote = next(ln for ln in body.splitlines() if ln.startswith("The Widget Toolkit"))
    bundle = [
        {"item": "bundle", "contract": "kb-ingest/1", "batch_id": "e2e-1", "producer": "agent:kb-collector", "domain": ["E"],
         "created_at": "2026-11-01T00:00:00Z"},
        {"item": "entity", "ref": "e1", "key": "concept:widget-toolkit", "type": "Concept", "label": "Widget Toolkit"},
        {"item": "claim", "ref": "c1", "subject": "e1", "statement": quote, "kind": "state", "stance": "stated",
         "evidence": {"snapshot": sid, "quote": quote}, "method": "llm"},
    ]
    rep = call("kb_ingest_validate", bundle=bundle, fetch=False)
    assert "accepted=2" in rep and "rejected=0" in rep, rep
    # 인용구를 바꾸면 거부된다(게이트가 실제로 막는다)
    bundle[2]["evidence"]["quote"] = "The Widget Toolkit stores 9 widgets per page."
    bundle[2]["statement"] = bundle[2]["evidence"]["quote"]
    assert "rejected=1" in call("kb_ingest_validate", bundle=bundle, fetch=False)
