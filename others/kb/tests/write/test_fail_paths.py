import json
import time

import pytest

from kb.core import ledger, opsdb, spool
from kb.core.gatelock import Gate
from kb.project import current_gold_path, gate_path
from kb.write import WriteRejected, commit, put_record, tick_stage
from wrhelp import count_events, ev, gold_row, promote_events

REC = {"type": "Note", "title": "실패 경로", "body": "본문", "sensitivity": "internal"}


def test_projection_failure_keeps_commit_and_recover_catches_up(fp_open, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("주입된 투영 실패")
    with monkeypatch.context() as m:
        m.setattr("kb.write.engine.project_tail", boom)
        r = put_record(REC, "fp-1", "mcp", "s-a")
    assert r.seq and r.version == 1 and r.projected is False and any("projection_failed" in w for w in r.warnings)
    assert count_events("record.put") == 1
    assert gold_row("SELECT count(*) FROM node WHERE id=?", (r.id,))[0][0] == 0
    res = tick_stage.run()
    assert res.ok, res.errors
    assert res.detail["project"]["caught_up"] is True
    assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (r.id,)) == [("실패 경로",)]


def test_gate_timeout_spools_and_recover_reloads(fp_open):
    gate = Gate(gate_path())
    fd = gate.acquire(1)
    try:
        t0 = time.monotonic()
        evs = [ev("entity.put", {"id": "e:concept:spooled", "type": "Concept", "label": "스풀"}, "e:concept:spooled", "sp-1")]
        r = commit(evs, timeout=0.3)
        assert time.monotonic() - t0 < 3
    finally:
        gate.release(fd)
    assert r.spooled and r.reason == "gate_timeout" and not r.projected and r.seq is None
    assert len(list(spool.dir_of("in").glob("*.json"))) == 1
    assert count_events("entity.put") == 0
    assert commit(evs, timeout=0.3, spool_on_timeout=True).replayed is False  # 게이트가 비었으니 바로 쓴다
    assert count_events("entity.put") == 1
    res = tick_stage.run()
    assert res.ok and res.detail["reload"]["loaded"] == 1
    assert list(spool.dir_of("in").glob("*.json")) == []
    assert count_events("entity.put") == 1  # 재적재는 멱등


def test_spool_in_reloads_in_written_order(fp_open):
    """파일 이름은 해시다. 게이트 시간 초과가 같은 레코드에 겹쳐도 뒤에 쓴 것이 현재 버전이다."""
    gate = Gate(gate_path())
    fd = gate.acquire(1)
    try:
        for t in range(6):
            sid = f"e:concept:sporder{t}"
            for i in range(3):
                e = ev("entity.put", {"id": sid, "type": "Concept", "label": f"라벨 {i}"}, sid, f"spo-{t}-{i}")
                assert commit([e], timeout=0.02).spooled
                if i == 0:  # 같은 이벤트가 또 밀려도 처음 자리를 지키고 예외가 없다
                    e2 = ev("entity.put", {"id": sid, "type": "Concept", "label": f"라벨 {i}"}, sid, f"spo-{t}-{i}")
                    assert commit([e2], timeout=0.02).spooled
    finally:
        gate.release(fd)
    assert len(list(spool.dir_of("in").glob("*.json"))) == 18
    res = tick_stage.run()
    assert res.ok and res.detail["reload"] == {"loaded": 18, "failed": 0, "left": 0}
    for t in range(6):
        assert gold_row("SELECT label FROM node WHERE id=? AND expired_at IS NULL", (f"e:concept:sporder{t}",)) == [("라벨 2",)]


def test_spool_attribution_not_recomputed(fp_open):
    gate = Gate(gate_path())
    fd = gate.acquire(1)
    try:
        e = {"kind": "record.put", "actor": "agent:s-a", "on_behalf_of": "user:sagae", "origin": "first_party",
             "subject": "f-spool", "idem_key": "sp-attr", "payload": {"id": "f-spool", "type": "Note", "title": "t",
                                                                      "body": "b", "sensitivity": "internal"}}
        r = commit([e], timeout=0.2)
    finally:
        gate.release(fd)
    assert r.spooled
    tick_stage.run()
    row = ledger.open_ledger().execute("SELECT actor, on_behalf_of FROM event WHERE idem_key='sp-attr'").fetchone()
    assert tuple(row) == ("agent:s-a", "user:sagae")


def _failed_names():
    d = spool.dir_of("in") / ".failed"
    return sorted(p.name for p in d.glob("*.json")) if d.exists() else []


def _dlq():
    c = opsdb.connect()
    try:
        return c.execute("SELECT kind, ref, stage FROM dlq").fetchall(), c.execute("SELECT kind, detail FROM incident").fetchall()
    finally:
        c.close()


def rec_event(rid, key, body="b", **kw):
    return {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": rid, "idem_key": key,
            "payload": {"id": rid, "type": "Note", "title": "t", "body": body, "sensitivity": "internal"}, **kw}


def test_reload_conflicts_go_failed_dlq_and_alarm(fp_open):
    commit([rec_event("f-c1", "rc-1")])
    spool.put("in", {"v": 1, "events": [rec_event("f-c1", "rc-1", body="다른 내용")]})        # 멱등 충돌
    spool.put("in", {"v": 1, "events": [rec_event("f-c2", "rc-2", expected_version=9)]})     # 버전 충돌
    res = tick_stage.run()
    assert res.detail["reload"]["failed"] == 2 and res.detail["reload"]["loaded"] == 0
    assert len(_failed_names()) == 2 and list(spool.dir_of("in").glob("*.json")) == []
    dlq, inc = _dlq()
    assert [d[0] for d in dlq] == ["spool_reload", "spool_reload"]
    assert len(inc) == 2 and all(i[0] == "spool_reload_failed" and i[1].startswith("치명") for i in inc)
    assert count_events("record.put") == 1


def test_redacted_payload_is_rejected_in_commit_and_reload(fp_open):
    r = put_record(REC, "rd-1", "mcp", "s-a")
    led = ledger.open_ledger()
    try:
        pl = ledger.get_payload(led, ledger.record_head(led, r.id)[1])
        out = ledger.redact(led, r.id, "시험", "user:sagae")
    finally:
        led.close()
    assert out["removed"]
    e = {"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": r.id, "idem_key": "rd-new",
         "payload": dict(pl)}
    with pytest.raises(WriteRejected) as ei:
        commit([e])
    assert ei.value.code == "redacted_payload"
    assert count_events("record.put") == 1
    # 같은 레코드에 같은 내용을 새 키로 put_record해도 무연산이 아니라 거부다
    with pytest.raises(WriteRejected):
        put_record({**REC, "id": r.id, "expected_version": 2}, "rd-2", "mcp", "s-a")
    spool.put("in", {"v": 1, "events": [e]})
    res = tick_stage.run()
    assert res.detail["reload"]["failed"] == 1 and len(_failed_names()) == 1
    assert _dlq()[0][0][0] == "spool_reload"


def test_paragraph_budget_leaves_projected_false_and_tick_continues(fp_open):
    evs = promote_events("pb", 0, 150) + promote_events("pb", 1, 150)
    r = commit(evs)
    assert r.seq and not r.projected

    res = tick_stage.run()
    assert res.ok and res.detail["project"]["caught_up"]
    c = ledger.open_ledger()
    try:
        head = ledger.head(c)[0]
    finally:
        c.close()
    assert gold_row("SELECT v FROM meta WHERE k='applied_seq'")[0][0] == str(head)


def test_exactly_full_budget_is_projected(fp_open):
    r = commit(promote_events("ex", 0, 200))
    assert r.projected


def test_more_than_100_events_split_into_gate_holds(fp_open):
    evs = [ev("entity.put", {"id": f"e:concept:m{i}", "type": "Concept", "label": f"m{i}"}, f"e:concept:m{i}", f"many{i}")
           for i in range(230)]
    r = commit(evs)
    assert len(r.events) == 230 and r.projected and count_events("entity.put") == 230
    assert commit(evs).replayed
