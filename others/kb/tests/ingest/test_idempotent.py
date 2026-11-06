"""같은 묶음 2회 제출: 두 번째 새 이벤트 0건. validate는 쓰지 않는다."""
import json

from kb import ingest
from kb.cli import main

from .conftest import FX, bundle, capture, event_count, gold, res, run, seed_snapshots


def test_first_batch_twice_writes_nothing_new(env):
    seed_snapshots()
    hdr, rows = ingest.read_path(str(FX / "first_batch.jsonl"))
    n0 = event_count()
    ingest.validate((hdr, rows), fetch=False)
    assert event_count() == n0                                   # validate는 쓰지 않는다
    a = ingest.submit((hdr, rows), fetch=False)
    assert a.new_events > 0 and a.summary()["rejected"] == 0, a.lines
    n1 = event_count()
    b = ingest.submit((hdr, rows), fetch=False)
    assert b.new_events == 0 and event_count() == n1, [x for x in b.lines if x["result"] != "accepted"]
    assert b.summary()["accepted"] == a.summary()["accepted"]


def test_same_claim_id_creates_no_new_claim(env):
    s = capture("https://example.org/w", b"# Widget Toolkit\n\nThe Widget Toolkit stores 5 widgets per page.\n")
    items = [{"item": "entity", "ref": "e1", "key": "concept:widget-toolkit", "type": "Concept", "label": "Widget Toolkit"},
             {"item": "claim", "ref": "c1", "subject": "e1", "statement": "Widget Toolkit stores 5 widgets per page.", "kind": "state",
              "stance": "stated", "evidence": {"snapshot": s, "quote": "stores 5 widgets per page"}, "method": "llm"}]
    a = run(items, write=True, batch="b1")
    n = event_count()
    # 다른 묶음, 다른 문장, 같은 주어와 같은 인용구 -> 같은 ID: 새 주장을 만들지 않는다
    items[1] = dict(items[1], statement="Widget Toolkit stores five widgets for every page.")
    b = run(items, write=True, batch="b2")
    assert res(b, "c1")["would_be"]["id"] == res(a, "c1")["would_be"]["id"] and res(b, "c1")["would_be"].get("existing")
    assert event_count() == n
    g = gold()
    try:
        assert g.execute("SELECT count(*) FROM claim c JOIN node n ON n.vid=c.vid WHERE n.expired_at IS NULL").fetchone()[0] == 1
    finally:
        g.close()


def test_cli_submit_twice_exit_codes(env, capsys):
    seed_snapshots()
    for _ in range(2):
        assert main(["ingest", "submit", str(FX / "first_batch.jsonl"), "--no-fetch", "--json"]) == 0
    last = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["summary"]
    assert last["new_events"] == 0
