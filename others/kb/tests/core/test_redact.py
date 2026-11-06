import sqlite3

import pytest

from kb.core import cas, conn, ledger
from kb.core.canon import sha256_hex, canon_json


def test_redact_keeps_chain_and_hides_body(led, mk):
    secret = {"id": "f-s1", "body": "토큰 abc123", "sensitivity": "secret"}
    ledger.append(led, [mk(subject="f-s1", payload=secret), mk(subject="f-ok", payload={"body": "남는다"})])
    head_before = ledger.iter_events(led, 0, 5)
    sha = sha256_hex(canon_json(secret))
    assert ledger.get_payload(led, sha) == secret
    r = ledger.redact(led, "f-s1", "비밀 유출", "user:sagae")
    assert r["removed"] == [sha] and r["shared"] == []
    v = ledger.verify_chain(led)
    assert v.ok, v.errors
    assert ledger.get_payload(led, sha) is None
    assert led.execute("SELECT count(*) FROM payload WHERE sha=?", (sha,)).fetchone()[0] == 0
    ev = ledger.iter_events(led, 0, 10)
    assert ev[0]["redacted"] and ev[0]["payload"] is None and not ev[1]["redacted"]
    # 체인 열은 그대로
    assert [(e["hash"], e["payload_sha"]) for e in ev[:2]] == [(e["hash"], e["payload_sha"]) for e in head_before]
    assert ledger.record_head(led, "f-s1")[0] == 2
    # 멱등
    assert ledger.redact(led, "f-s1", "비밀 유출", "user:sagae")["replayed"]


def test_shared_payload_not_deleted(led, mk):
    same = {"body": "동일"}
    ledger.append(led, [mk(subject="f-a", payload=same), mk(subject="f-b", payload=same)])
    r = ledger.redact(led, "f-a", "t", "user:sagae")
    assert r["removed"] == [] and len(r["shared"]) == 1
    assert ledger.get_payload(led, r["shared"][0]) == same
    assert ledger.verify_chain(led).ok


def test_event_table_immutable(led, mk):
    ledger.append(led, [mk(subject="f-x")])
    ledger.redact(led, "f-x", "t", "user:sagae")
    for sql in ("UPDATE event SET subject='y'", "DELETE FROM event", "DELETE FROM event WHERE seq=1"):
        with pytest.raises(sqlite3.DatabaseError):
            led.execute(sql)
    with pytest.raises(sqlite3.DatabaseError):
        led.execute("DELETE FROM payload")  # redact 밖에서는 못 지운다
    assert ledger.meta_get(led, "redact_gate") == "0"


def test_unrecorded_payload_loss_detected(led, mk):
    r = ledger.append(led, [mk(subject="f-q", payload={"a": "b"})])
    for name in ledger.TRIGGERS:
        led.execute(f"DROP TRIGGER {name}")
    led.execute("DELETE FROM payload")
    for ddl in ledger.TRIGGERS.values():
        led.execute(ddl)
    assert not ledger.verify_chain(led).ok


def test_export_reseal_and_cas_object(led, mk, kb_home):
    sha = cas.put(b"x" * 100, "fp")
    ledger.append(led, [mk(subject="f-b1", payload={"body_sha": sha, "body": "a"})])
    seg = ledger.export_segment(led)[0]
    r = ledger.redact(led, "f-b1", "t", "user:sagae")
    assert cas.delete(sha, "fp") and not cas.exists(sha, "fp")
    row = ledger.reseal_segment(led, 1)
    assert row and ledger.read_segment(seg["file"])[0]["payload"] == {"redacted": True}
    assert ledger.verify_chain(led).ok


def _sha(p):
    return sha256_hex(canon_json(p))


def test_redact_again_after_new_version(led, mk):
    a, b = {"body": "secret-1"}, {"body": "secret-2"}
    ledger.append(led, [mk(subject="f-a", payload=a)])
    r1 = ledger.redact(led, "f-a", "t", "user:sagae")
    ledger.append(led, [mk(subject="f-a", payload=b)])
    r2 = ledger.redact(led, "f-a", "t", "user:sagae")
    assert not r2["replayed"] and r2["removed"] == [_sha(b)] and r2["seq"] != r1["seq"]
    assert ledger.get_payload(led, _sha(b)) is None
    # 지울 것이 없으면 직전 redact를 재생하고 redact 이벤트의 본문은 건드리지 않는다
    r3 = ledger.redact(led, "f-a", "t", "user:sagae", idem_key="k3")
    assert r3["replayed"] and r3["seq"] == r2["seq"] and r3["removed"] == r2["removed"]
    v = ledger.verify_chain(led)
    assert v.ok, v.errors


def test_redact_idem_key_reuse_with_new_body_conflicts(led, mk):
    ledger.append(led, [mk(subject="f-a", payload={"body": "1"})])
    r = ledger.redact(led, "f-a", "t", "user:sagae", idem_key="k")
    assert ledger.redact(led, "f-a", "t", "user:sagae", idem_key="k")["seq"] == r["seq"]
    ledger.append(led, [mk(subject="f-a", payload={"body": "2"})])
    with pytest.raises(ledger.IdemConflict):
        ledger.redact(led, "f-a", "t", "user:sagae", idem_key="k")
    assert ledger.get_payload(led, _sha({"body": "2"})) == {"body": "2"}  # 되돌려졌다
    assert ledger.verify_chain(led).ok


def test_redacted_body_cannot_come_back(led, mk):
    same = {"body": "지운 비밀"}
    ledger.append(led, [mk(subject="f-a", payload=same)])
    ledger.redact(led, "f-a", "t", "user:sagae")
    n = led.execute("SELECT count(*) FROM event").fetchone()[0]
    for subject in ("f-b", "f-a"):
        with pytest.raises(ledger.RedactedPayload):
            ledger.append(led, [mk(subject=subject, payload=same)])
    assert led.execute("SELECT count(*) FROM event").fetchone()[0] == n
    assert ledger.iter_events(led, 0, 1)[0]["redacted"]
    assert ledger.verify_chain(led).ok


def test_replay_of_redacted_event_still_answers(led, mk):
    e = mk(subject="f-a", payload={"body": "x"}, idem="재전송")
    first = ledger.append(led, [e])[0]
    ledger.redact(led, "f-a", "t", "user:sagae")
    again = ledger.append(led, [dict(e)])[0]
    assert again["replayed"] and again["seq"] == first["seq"]


def test_verify_detects_redacted_body_put_back(led, mk):
    same = {"body": "x"}
    ledger.append(led, [mk(subject="f-a", payload=same)])
    ledger.redact(led, "f-a", "t", "user:sagae")
    led.execute("INSERT INTO payload(sha, body) VALUES(?,?)", (_sha(same), canon_json(same)))
    assert any("지운 본문" in e for e in ledger.verify_chain(led).errors)


def test_shared_body_goes_when_every_holder_is_redacted(led, mk):
    same = {"body": "둘이 쓰는 비밀"}
    ledger.append(led, [mk(subject="f-a", payload=same), mk(subject="f-b", payload=same)])
    assert ledger.redact(led, "f-a", "t", "user:sagae")["shared"] == [_sha(same)]
    assert ledger.redact(led, "f-a", "t", "user:sagae")["replayed"]
    r = ledger.redact(led, "f-b", "t", "user:sagae")
    assert r["removed"] == [_sha(same)] and ledger.get_payload(led, _sha(same)) is None
    assert ledger.verify_chain(led).ok


def test_holder_reusing_body_after_its_redact_still_counts(led, mk):
    same = {"body": "x"}
    ledger.append(led, [mk(subject="f-a", payload=same), mk(subject="f-b", payload=same)])
    ledger.redact(led, "f-a", "t", "user:sagae")
    ledger.append(led, [mk(subject="f-a", payload=same)])
    assert ledger.redact(led, "f-b", "t", "user:sagae")["removed"] == []
    assert ledger.get_payload(led, _sha(same)) == same


def test_decision_and_delete_are_one_transaction(led, mk, monkeypatch):
    """redact의 판정과 삭제 사이에 다른 연결이 끼어들 수 없다."""
    ledger.append(led, [mk(subject="f-a", payload={"body": "x"})])
    other = conn.connect_rw(ledger.ledger_path(), "FULL")
    other.execute("PRAGMA busy_timeout=0")
    plan = ledger._redact_plan
    blocked = []

    def racing_plan(c, rid):
        out = plan(c, rid)
        with pytest.raises(sqlite3.OperationalError):
            ledger.append(other, [mk(subject="f-b", payload={"body": "x"})])
        blocked.append(rid)
        return out

    monkeypatch.setattr(ledger, "_redact_plan", racing_plan)
    assert ledger.redact(led, "f-a", "t", "user:sagae")["removed"] == [_sha({"body": "x"})]
    assert blocked
    other.close()


def test_direct_append_cannot_delete_foreign_bodies(led, mk):
    keep = {"body": "다른 레코드"}
    ledger.append(led, [mk(subject="f-a", payload={"body": "a"}), mk(subject="f-b", payload=keep)])
    first = ledger.redact(led, "f-a", "t", "user:sagae")
    evidence = led.execute("SELECT payload_sha FROM event WHERE seq=?", (first["seq"],)).fetchone()[0]
    for sha in (_sha(keep), evidence):
        with pytest.raises(ledger.LedgerError):
            ledger.append(led, [mk("record.redact", {"id": "f-a", "reason": "r", "payload_shas": [sha]},
                                   subject="f-a", origin="system")])
    assert ledger.verify_chain(led).ok


def test_redact_unknown_record_refused(led):
    with pytest.raises(ledger.LedgerError):
        ledger.redact(led, "f-없음", "t", "user:sagae")
    assert ledger.head(led)[0] == 0


def test_redact_plaintext_gone_from_files(kb_home, mk):
    import sqlite3 as sq
    from kb.core import ledger as L
    needle = "ZZ-평문-표식-7f3a91"
    c = L.open_ledger()
    L.append(c, [mk(subject="f-sec", payload={"body": needle, "pad": "x" * 3000}), mk(subject="f-o")])
    L.redact(c, "f-sec", "유출", "user:sagae")
    p = L.ledger_path()
    data = p.read_bytes()
    wal = p.with_name(p.name + "-wal")
    if wal.exists():
        data += wal.read_bytes()
    assert needle.encode() not in data
    bk = kb_home / "bk.db"
    b = sq.connect(bk)
    c.backup(b)
    b.close()
    assert needle.encode() not in bk.read_bytes()
    assert L.verify_chain(c).ok
    c.close()


def _has(path, needle):
    wal = path.with_name(path.name + "-wal")
    return needle in path.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


def test_append_redact_on_plain_connection_leaves_no_plaintext(kb_home, mk):
    """저장소의 유일한 쓰기 연결 connect_rw로 append한 record.redact도 파일에 평문을 남기지 않는다."""
    needle = "NEEDLE-D8-SECRET"
    p = ledger.ledger_path()
    ledger.open_ledger().close()
    c = conn.connect_rw(p, "FULL")
    assert c.execute("PRAGMA secure_delete").fetchone()[0] == 0
    a = mk(subject="f-sec", payload={"body": needle, "pad": "x" * 3000})
    ledger.append(c, [a])
    sha = c.execute("SELECT payload_sha FROM event WHERE subject='f-sec'").fetchone()[0]
    r = ledger.append(c, [mk(kind="record.redact", subject="f-sec", origin="system",
                             payload={"id": "f-sec", "reason": "t", "payload_shas": [sha], "shared": []})])
    assert r[0]["wal_cleared"] is True
    assert ledger.get_payload(c, sha) is None and ledger.verify_chain(c).ok
    assert not _has(p, needle.encode())
    c.close()
    assert not p.read_bytes().count(needle.encode())


def test_redact_reports_wal_not_cleared_then_retry_clears(kb_home, mk):
    """읽기 연결이 체크포인트를 막으면 성공으로 숨기지 않고 알린다. 읽기가 끝난 뒤 재호출이 마무리한다."""
    needle = "NEEDLE-WAL-SECRET"
    c = ledger.open_ledger()
    c.execute("PRAGMA wal_autocheckpoint=0")
    c.execute("PRAGMA busy_timeout=100")
    ledger.append(c, [mk(subject="f-sec", payload={"body": needle})])
    p = ledger.ledger_path()
    ro = conn.connect_ro(p)
    ro.execute("BEGIN")
    ro.execute("SELECT count(*) FROM payload").fetchone()
    r = ledger.redact(c, "f-sec", "t", "user:sagae")
    assert r["removed"] and r["wal_cleared"] is False
    assert _has(p, needle.encode())
    ro.execute("ROLLBACK")
    ro.close()
    again = ledger.redact(c, "f-sec", "t", "user:sagae")
    assert again["replayed"] and again["wal_cleared"] is True
    assert not _has(p, needle.encode())
    assert ledger.flush_wal(c) is True
    c.close()


def test_redact_idem_key_reuse_for_other_record_conflicts(led, mk):
    ledger.append(led, [mk(subject="f-a", payload={"id": "f-a", "body": "a"}),
                        mk(subject="f-b", payload={"id": "f-b", "body": "b"})])
    ledger.redact(led, "f-a", "사유", "user:sagae", idem_key="K1")
    with pytest.raises(ledger.IdemConflict):
        ledger.redact(led, "f-b", "사유", "user:sagae", idem_key="K1")
