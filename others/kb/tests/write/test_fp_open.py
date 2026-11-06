import json

from kb.core import ledger, spool
from kb.write import fpgate, put_record
from kb.write.tick_stage import run as recover
from wrhelp import add_drill, count_events, gold_row
from test_fp_gate import held_files

REC = {"type": "Decision", "title": "채널 첫 시리즈", "body": "개발 일지로 시작한다", "sensitivity": "internal",
       "props": {"status": "accepted"}}


def test_open_drains_held_and_preserves_authored_at(wk):
    r = put_record(REC, "open-k1", "mcp", "s-a")
    assert r.held
    authored = json.loads(held_files()[0].read_text())["events"][-1]["payload"]["authored_at"]
    add_drill()
    res = fpgate.open_fp()
    assert res.ok and res.mode == "drill" and res.drained == 1 and res.failed == 0
    assert held_files() == []
    assert count_events("system.fp_opened") == 1 and count_events("record.put") == 1
    rows = gold_row("SELECT label, valid_from, author, on_behalf_of FROM node WHERE id=? AND expired_at IS NULL", (r.id,))
    assert rows == [("채널 첫 시리즈", authored, "agent:s-a", "user:sagae")]
    # 재실행 멱등
    res2 = fpgate.open_fp()
    assert res2.ok and res2.already_open and res2.drained == 0
    assert count_events("record.put") == 1 and count_events("system.fp_opened") == 1
    # 열린 뒤 같은 키 재시도는 첫 응답
    r3 = put_record(REC, "open-k1", "mcp", "s-a")
    assert not r3.held and r3.replayed and r3.version == 1 and r3.id == r.id
    # 새 쓰기는 바로 원장으로
    r4 = put_record({**REC, "title": "둘째"}, "open-k2", "mcp", "s-a")
    assert not r4.held and r4.projected and r4.version == 1


def test_open_hits_search_via_gold(wk):
    put_record(REC, "open-k5", "inbox")
    add_drill()
    fpgate.open_fp()
    rows = gold_row("SELECT count(*) FROM unit WHERE sha IS NOT NULL")
    assert rows[0][0] >= 1


def test_open_twice_with_new_drill_is_still_one_open(wk):
    add_drill()
    assert fpgate.open_fp().ok
    add_drill()
    assert fpgate.open_fp().already_open


def test_cli_open_with_drill(wk, capsys):
    from kb.cli import main
    put_record(REC, "open-k9", "mcp", "s-a")
    add_drill()
    assert main(["fp", "open", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] and out["mode"] == "drill" and out["drained"] == 1
    assert main(["fp", "status", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == {"held": 0, "open": True}


def _head(rid):
    c = ledger.open_ledger()
    try:
        return ledger.record_head(c, rid)
    finally:
        c.close()


def test_same_id_held_writes_land_in_written_order(wk):
    """파일 이름은 해시다. 어떤 키든 뒤 응답이 현재 버전이어야 한다(재현: 8건 중 5건이 뒤집혔다)."""
    for t in range(8):
        rid = f"f-order{t}"
        for i in range(3):
            r = put_record({**REC, "id": rid, "title": f"제목 {i}"}, f"ord-{t}-{i}", "mcp", "s-a")
            assert r.held
    add_drill()
    res = fpgate.open_fp()
    assert res.ok and res.drained == 24 and res.failed == 0
    for t in range(8):
        rid = f"f-order{t}"
        assert _head(rid)[0] == 3
        assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (rid,)) == [("제목 2",)]


def test_expected_version_chain_while_held_applies_in_order(wk):
    """계약대로 id와 expected_version으로 갱신한 보류 쓰기가 VersionConflict로 .failed에 가지 않는다."""
    for t in range(8):
        rid = f"f-chain{t}"
        put_record({**REC, "id": rid, "title": "처음"}, f"ch-{t}-0", "mcp", "s-a")
        put_record({**REC, "id": rid, "title": "둘째", "expected_version": 1}, f"ch-{t}-1", "mcp", "s-a")
        put_record({**REC, "id": rid, "title": "셋째", "expected_version": 2}, f"ch-{t}-2", "mcp", "s-a")
    add_drill()
    res = fpgate.open_fp()
    assert res.ok and res.drained == 24 and res.failed == 0
    assert not (spool.dir_of("fp-held") / ".failed").exists()
    for t in range(8):
        rid = f"f-chain{t}"
        assert _head(rid)[0] == 3
        assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (rid,)) == [("셋째",)]


def test_retry_keeps_first_position(wk):
    """같은 키 재시도는 처음 자리를 지킨다. 뒤에 쓴 것을 앞지르지 않는다."""
    rid = "f-retry1"
    put_record({**REC, "id": rid, "title": "앞"}, "rt-0", "mcp", "s-a")
    put_record({**REC, "id": rid, "title": "뒤"}, "rt-1", "mcp", "s-a")
    assert put_record({**REC, "id": rid, "title": "앞"}, "rt-0", "mcp", "s-a").held
    assert len(held_files()) == 2
    add_drill()
    assert fpgate.open_fp().drained == 2
    assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (rid,)) == [("뒤",)]


def test_list_held_in_written_order_and_tick_drains_same_way(wk):
    titles = [f"제목 {i}" for i in range(6)]
    for i, t in enumerate(titles):
        put_record({**REC, "title": t}, f"ls-{i}", "mcp", "s-a")
    assert [x["title"] for x in fpgate.list_held()] == titles
    from wrhelp import open_fp_direct
    open_fp_direct()  # 개방 뒤 적재가 끊겨 tick이 잇는 경우
    detail = recover().detail
    assert detail["held"]["loaded"] == 6 and held_files() == []
    labels = [x[0] for x in gold_row("SELECT label FROM node WHERE type='Decision' ORDER BY valid_from, rowid")]
    assert labels == titles
