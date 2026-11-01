import json

from ihelp import FAKE_PAT
from kb import ticket
from kb.core import spool
from kb.intake import core
from kb.write import put_record


def held():
    return {e["idem_key"]: e for _, o in spool.iter_items("fp-held") for e in o["events"]}


def test_kb_put_same_format_secret_and_author(sample):
    man, _ = sample
    core.run(man)
    intake_ev = held()
    k0 = next(k for k in intake_ev if k.startswith("intake:i-full:"))
    rec = {"type": "Artifact", "title": "MCP로 낸 자료", "body": "본문", "sensitivity": "internal",
           "props": {"session": "다른-세션", "topic": "t", "researched_on": "2026-10-31"}}
    r = put_record(rec, "mcp-k1", "mcp", session="sess-a")
    assert r.held
    e = held()["mcp-k1"]
    a = intake_ev[k0]
    assert e["kind"] == a["kind"] == "record.put" and e["origin"] == a["origin"] == "first_party"
    assert e["actor"] == a["actor"] == "agent:sess-a" and e["on_behalf_of"] == a["on_behalf_of"]
    assert set(e["payload"]) <= set(a["payload"]) | {"props"} and e["payload"]["type"] == a["payload"]["type"] == "Artifact"
    assert e["payload"]["props"]["session"] == "다른-세션"  # 자기 신고 표시값일 뿐 작성자를 바꾸지 않는다
    s = put_record({**rec, "body": f"x {FAKE_PAT}"}, "mcp-k2", "mcp", session="sess-a")
    assert any(w.startswith("secret_detected") for w in s.warnings)
    p = held()["mcp-k2"]["payload"]
    assert p["sensitivity"] == "secret" and p["props"]["quarantine"] is True


def test_kb_request_url_merges_into_intake_ticket(sample):
    man, _ = sample
    man["items"] = [i for i in man["items"] if i["id"] == "i-urls"]
    core.run(man)
    (row,) = ticket._open_rows()
    r = ticket.open_ticket(row["topic"], "세션이 더한 근거", "low", "https://example.org/extra", transport="mcp", session="sess-a")
    assert r["ticket"] == row["id"] and r["duplicates"] == 1
    (row2,) = ticket._open_rows()
    assert row2["urls"] == ["https://example.org/pub1", "https://example.org/extra"]
    assert core.run(man)["new_events"] == 0  # 다시 돌려도 더하지 않는다
