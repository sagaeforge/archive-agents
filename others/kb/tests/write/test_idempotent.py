import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from kb.core import ledger
from kb.write import IdemConflict, VersionConflict, WriteRejected, put_record
from wrhelp import count_events

HERE = Path(__file__).parent
REC = {"type": "Note", "title": "멱등 시험", "body": "본문 [[e:product:claude-code]]", "sensitivity": "internal"}


def test_eight_processes_same_key(fp_open):
    go = fp_open / "go"
    procs = [subprocess.Popen([sys.executable, str(HERE / "_put_proc.py"), "idem-k1", json.dumps(REC), str(go)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(8)]
    time.sleep(0.5)
    go.write_text("1")
    outs = []
    for p in procs:
        o, e = p.communicate(timeout=60)
        assert p.returncode == 0, (o, e)
        outs.append(json.loads(o))
    assert sum(1 for o in outs if not o["replayed"]) == 1, outs
    assert sum(1 for o in outs if o["replayed"]) == 7, outs
    assert len({o["id"] for o in outs}) == 1
    assert {o["version"] for o in outs} == {1}
    assert count_events("record.put") == 1


def test_same_key_different_content_rejected(fp_open):
    r1 = put_record(REC, "idem-k2", "mcp", "s-a")
    assert not r1.replayed and r1.version == 1
    with pytest.raises(IdemConflict):
        put_record({**REC, "body": "다른 본문"}, "idem-k2", "mcp", "s-a")
    with pytest.raises(IdemConflict):  # 귀속이 다르면 같은 키를 다른 이벤트로 본다
        put_record(REC, "idem-k2", "mcp", "s-b")
    r2 = put_record(REC, "idem-k2", "mcp", "s-a")
    assert r2.replayed and r2.id == r1.id and r2.seq == r1.seq


def test_update_requires_expected_version_and_same_content_is_noop(fp_open):
    r1 = put_record(REC, "idem-k3", "mcp", "s-a")
    upd = {**REC, "id": r1.id, "body": "수정본"}
    with pytest.raises(WriteRejected) as ei:
        put_record(upd, "idem-k3b", "mcp", "s-a")
    assert ei.value.code == "expected_version_required"
    with pytest.raises(VersionConflict):
        put_record({**upd, "expected_version": 5}, "idem-k3b", "mcp", "s-a")
    r2 = put_record({**upd, "expected_version": 1}, "idem-k3b", "mcp", "s-a")
    assert r2.version == 2 and not r2.replayed
    n = count_events("record.put")
    r3 = put_record({**upd, "expected_version": 2}, "idem-k3c", "mcp", "s-a")  # 내용 같음 -> 새 버전 없음
    assert r3.version == 2 and r3.replayed and count_events("record.put") == n
    r4 = put_record({**upd, "expected_version": 1}, "idem-k3b", "mcp", "s-a")  # 갱신 재시도는 첫 응답
    assert r4.replayed and r4.version == 2


def test_unknown_type_registers_provisional_and_retries(fp_open):
    r = put_record({**REC, "type": "Weirdo"}, "idem-k4", "mcp", "s-a")
    assert r.version == 1
    assert count_events("schema.type_defined") == 1
    r2 = put_record({**REC, "type": "Weirdo", "title": "둘째"}, "idem-k5", "mcp", "s-a")
    assert r2.version == 1 and count_events("schema.type_defined") == 1
    c = ledger.open_ledger()
    try:
        row = c.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='schema.type_defined'").fetchone()
    finally:
        c.close()
    d = json.loads(row[0])
    assert d["status"] == "provisional" and d["schema_json"]["x-kb-overview"] is True


def test_big_body_goes_to_raw_fp(fp_open):
    from kb.core import cas
    body = "큰 본문 " * 20000
    r = put_record({**REC, "body": body}, "idem-k6", "mcp", "s-a")
    c = ledger.open_ledger()
    try:
        head = ledger.record_head(c, r.id)
        pl = ledger.get_payload(c, head[1])
    finally:
        c.close()
    assert "body" not in pl and cas.get(pl["body_sha"], "fp").decode() == body


def test_wikilinks_become_links_to_edges(fp_open):
    from wrhelp import gold_row
    r = put_record({**REC, "body": "[[e:product:claude-code]] 와 [[e:tool:rtk|rtk]], [[자유 텍스트]]"}, "idem-k7", "mcp", "s-a")
    assert any(w.startswith("link_not_id") for w in r.warnings)
    rows = gold_row("SELECT dst, rtype FROM edge WHERE src=? AND expired_at IS NULL ORDER BY dst", (r.id,))
    assert [(a, b) for a, b in rows] == [("e:product:claude-code", "LINKS_TO"), ("e:tool:rtk", "LINKS_TO")]


def test_tombstone(fp_open):
    from kb.write import tombstone_record
    from wrhelp import gold_row
    r = put_record(REC, "idem-k8", "mcp", "s-a")
    t = tombstone_record(r.id, "시험", "idem-k8t", "mcp", "s-a")
    assert t.seq > r.seq
    assert gold_row("SELECT status FROM node WHERE id=? AND expired_at IS NULL", (r.id,))[0][0] == "dead"
    with pytest.raises(WriteRejected):
        tombstone_record("f-nope", "x", "idem-k8u", "mcp", "s-a")
