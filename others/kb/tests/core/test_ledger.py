import json
import sqlite3

import pytest

from kb.core import ledger, paths
from kb.core.canon import CanonError, canon_json, sha256_hex


def test_canon():
    assert canon_json({"b": 1, "a": [True, None, "한"]}) == '{"a":[true,null,"한"],"b":1}'.encode()
    for bad in (1.5, {"x": float("nan")}, {"x": [0.1]}, {1: 2}):
        with pytest.raises(CanonError):
            canon_json(bad)
    assert sha256_hex("a") == sha256_hex(b"a")


def test_append_chain_and_replay(led, mk):
    r = ledger.append(led, [mk(), mk("entity.put", {"id": "e:tool:x", "type": "Tool", "label": "x"}, subject="e:tool:x")])
    assert [x["seq"] for x in r] == [1, 2]
    v = ledger.verify_chain(led)
    assert v.ok and v.events == 2 and v.head_seq == 2
    e = ledger.iter_events(led, 0, 10)
    assert e[1]["prev_hash"] == e[0]["hash"] and e[0]["prev_hash"] == ledger.GENESIS
    assert ledger.row_hash(e[0]) == e[0]["hash"]


def test_idempotent_and_conflict(led, mk):
    a = mk(idem="same")
    r1 = ledger.append(led, [a])[0]
    r2 = ledger.append(led, [dict(a)])[0]
    assert r2["replayed"] and r2["seq"] == r1["seq"] and r2["hash"] == r1["hash"] and r2["version"] == 1
    assert led.execute("SELECT count(*) FROM event").fetchone()[0] == 1
    with pytest.raises(ledger.IdemConflict):
        ledger.append(led, [dict(a, payload={"다른": "내용"})])
    # 실패한 배치는 통째로 되돌린다
    with pytest.raises(ledger.IdemConflict):
        ledger.append(led, [mk(), dict(a, payload={"x": 1})])
    assert led.execute("SELECT count(*) FROM event").fetchone()[0] == 1
    assert ledger.verify_chain(led).ok


def test_expected_version(led, mk):
    rid = "f-abc"
    assert ledger.append(led, [mk(subject=rid, expected_version=0)])[0]["version"] == 1
    assert ledger.append(led, [mk(subject=rid, expected_version=1)])[0]["version"] == 2
    with pytest.raises(ledger.VersionConflict):
        ledger.append(led, [mk(subject=rid, expected_version=1)])
    assert ledger.record_head(led, rid)[0] == 2
    assert ledger.verify_chain(led).ok


def test_at_monotonic(led, mk):
    ledger.append(led, [mk()], now_ms=2_000_000)
    ledger.append(led, [mk()], now_ms=1_000_000)  # 시계가 뒤로 갔다
    a = [e["at"] for e in ledger.iter_events(led, 0, 10)]
    assert a == [2_000_000, 2_000_000]
    assert ledger.verify_chain(led).ok


def test_rejects_bad_input(led, mk):
    ledger.append(led, [mk()])
    for bad in (mk(kind="nope.x"), mk(origin="x"), mk(payload={"f": 1.5}), {**mk(), "idem_key": ""}):
        with pytest.raises(Exception):
            ledger.append(led, [bad])
    assert led.execute("SELECT count(*) FROM event").fetchone()[0] == 1


def test_meta_replay(led, mk):
    ledger.append(led, [mk("schema.epoch_bumped", {"reason": "restore"}), mk("system.fp_opened", {"mode": "drill"})])
    assert ledger.meta_get(led, "epoch") == "1" and ledger.meta_get(led, "fp_open")
    assert ledger.verify_chain(led).ok


def test_triggers(led, mk):
    ledger.append(led, [mk()])
    for sql in ("UPDATE event SET actor='x'", "DELETE FROM event", "UPDATE payload SET body=x'00'", "DELETE FROM payload"):
        with pytest.raises(sqlite3.DatabaseError):
            led.execute(sql)


def test_export_and_reseal(led, mk):
    ledger.append(led, [mk(subject="f-r1", payload={"body": "비밀"}), mk()])
    segs = ledger.export_segment(led)
    assert len(segs) == 1 and segs[0]["first_seq"] == 1 and segs[0]["last_seq"] == 2
    assert ledger.export_segment(led) == []
    lines = ledger.read_segment(segs[0]["file"])
    assert [ledger.row_hash(x) for x in lines] == [x["hash"] for x in lines]
    assert lines[0]["payload"] == {"body": "비밀"}
    ledger.append(led, [mk()])
    assert ledger.export_segment(led)[0]["first_seq"] == 3
    ledger.redact(led, "f-r1", "시험", "user:sagae")
    row = ledger.reseal_segment(led, 1)
    assert row["kind"] == "resealed" and row["lines"] == [1]
    assert ledger.read_segment(segs[0]["file"])[0]["payload"] == {"redacted": True}
    assert ledger.segment_sha(segs[0]["file"]) == row["sha256"]
    assert ledger.reseal_segment(led, 1) is None
    kinds = [r["kind"] for r in ledger.manifest_rows()]
    assert kinds == ["segment", "segment", "resealed"]


def test_new_ledger_reads_work(kb_home):
    c = ledger.open_ledger()
    assert ledger.head(c) == (0, ledger.GENESIS)
    assert ledger.iter_events(c, 0, 10) == []
    assert ledger.meta_get(c, "epoch") == "0"
    assert ledger.record_head(c, "f-x") is None
    assert ledger.export_segment(c) == []
    assert ledger.verify_chain(c).ok
    c.close()


def _crash_once(monkeypatch):
    real = ledger._append_manifest
    state = {"n": 0}

    def boom(row):
        state["n"] += 1
        if state["n"] == 1:
            raise KeyboardInterrupt("크래시 주입")
        real(row)

    monkeypatch.setattr(ledger, "_append_manifest", boom)


def _files():
    root = ledger.export_dir()
    return sorted(f.relative_to(root).as_posix() for f in root.rglob("*.ndjson.zst"))


def test_reseal_crash_before_manifest_recovers(led, mk, monkeypatch):
    ledger.append(led, [mk(subject="f-r", payload={"body": "비밀"}), mk()])
    seg = ledger.export_segment(led)[0]
    ledger.redact(led, "f-r", "t", "user:sagae")
    _crash_once(monkeypatch)
    with pytest.raises(KeyboardInterrupt):
        ledger.reseal_segment(led, 1)
    f = ledger.export_dir() / seg["file"]
    assert sha256_hex(f.read_bytes()) != ledger.segment_sha(seg["file"])
    assert ledger.read_segment(seg["file"])[0]["payload"] == {"redacted": True}
    row = ledger.reseal_segment(led, 1)
    assert row["kind"] == "resealed" and row["recovered"] and row["lines"] == [1]
    assert sha256_hex(f.read_bytes()) == ledger.segment_sha(seg["file"])
    assert ledger.reseal_segment(led, 1) is None


def test_export_crash_leaves_no_secret_behind(led, mk, monkeypatch):
    secret = b"secret-plain"
    ledger.append(led, [mk(subject="f-s", payload={"body": secret.decode()})])
    _crash_once(monkeypatch)
    with pytest.raises(KeyboardInterrupt):
        ledger.export_segment(led)
    assert len(_files()) == 1 and ledger.manifest_rows() == []
    ledger.append(led, [mk()])
    ledger.export_segment(led)
    ledger.redact(led, "f-s", "t", "user:sagae")
    ledger.reseal_segment(led, 1)
    listed = {r["file"] for r in ledger.manifest_rows()}
    assert set(_files()) == listed
    for rel in listed:
        assert all(secret.decode() not in str(x["payload"]) for x in ledger.read_segment(rel))


def test_orphan_swept_by_reseal_too(led, mk, monkeypatch):
    ledger.append(led, [mk(subject="f-s", payload={"body": "x"})])
    _crash_once(monkeypatch)
    with pytest.raises(KeyboardInterrupt):
        ledger.export_segment(led)
    ledger.redact(led, "f-s", "t", "user:sagae")
    with pytest.raises(ledger.LedgerError, match="세그먼트 없음"):
        ledger.reseal_segment(led, 1)
    assert _files() == []


def test_manifest_torn_tail_recovers(led, mk):
    ledger.append(led, [mk()])
    ledger.export_segment(led)
    with ledger.manifest_path().open("ab") as f:
        f.write(b'{"kind":"segm')
    assert len(ledger.manifest_rows()) == 1
    ledger.append(led, [mk()])
    assert ledger.export_segment(led)[0]["first_seq"] == 2
    assert ledger.manifest_path().read_bytes().count(b"\n") == 2
    assert [r["first_seq"] for r in ledger.manifest_rows()] == [1, 2]


def test_manifest_torn_row_of_real_segment_reexports(led, mk):
    ledger.append(led, [mk()])
    ledger.export_segment(led)
    raw = ledger.manifest_path().read_bytes()
    ledger.manifest_path().write_bytes(raw[:-20])  # 행 쓰기 도중 죽음
    assert ledger.manifest_rows() == []
    seg = ledger.export_segment(led)[0]
    assert seg["first_seq"] == 1 and _files() == [seg["file"]]


def test_manifest_damage_in_the_middle_is_an_error(led, mk):
    ledger.append(led, [mk()])
    ledger.export_segment(led)
    p = ledger.manifest_path()
    p.write_bytes(b"{broken\n" + p.read_bytes())
    with pytest.raises(ledger.LedgerError):
        ledger.manifest_rows()


def test_unknown_segment_is_not_deleted(led, mk):
    """MANIFEST를 잃었는데 원장에도 없는 세그먼트는 유일한 사본일 수 있다."""
    ledger.append(led, [mk()])
    seg = ledger.export_segment(led)[0]
    keep = (ledger.export_dir() / seg["file"]).read_bytes()
    ledger.manifest_path().unlink()
    other = ledger.open_ledger(paths.ledger_dir() / "other.db")
    ledger.append(other, [mk()])
    stray = ledger.export_dir() / "1999" / "01" / "000000000001-000000000001.ndjson.zst"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(keep)
    with pytest.raises(ledger.LedgerError, match="원장에도 없는"):
        ledger.export_segment(other)
    assert stray.read_bytes() == keep
    other.close()


def test_reseal_refuses_tampered_segment(led, mk):
    ledger.append(led, [mk(subject="f-r", payload={"body": "진짜"})])
    seg = ledger.export_segment(led)[0]
    lines = ledger.read_segment(seg["file"])
    lines[0]["payload"] = {"body": "가짜"}
    (ledger.export_dir() / seg["file"]).write_bytes(
        ledger._zst(b"".join(canon_json(x) + b"\n" for x in lines)))
    with pytest.raises(ledger.LedgerError, match="변조"):
        ledger.reseal_segment(led, 1)


# ---- 리드 검증 재현 시험 ----
import sqlite3 as _sq

import pytest as _pt

from kb.core import ledger as _L


@_pt.mark.parametrize("field", ["subject", "on_behalf_of", "generated_by", "event_id"])
@_pt.mark.parametrize("bad", [123, 1.5, b"x", ["a"], True])
def test_rejects_non_str_columns(led, mk, field, bad):
    with _pt.raises(_L.LedgerError):
        _L.append(led, [mk(**{field: bad})])
    assert _L.verify_chain(led).ok and _L.head(led)[0] == 0


@_pt.mark.parametrize("v", [0, -1, 99, True, "1", 1.0])
def test_rejects_bad_v(led, mk, v):
    with _pt.raises(_L.LedgerError):
        _L.append(led, [mk(v=v)])
    assert _L.verify_chain(led).ok and _L.head(led)[0] == 0


def test_valid_v_and_none_columns_ok(led, mk):
    _L.append(led, [mk(v=1, on_behalf_of=None, generated_by="g")])
    assert _L.verify_chain(led).ok


def test_insert_or_replace_blocked(led, mk):
    _L.append(led, [mk(), mk()])
    row = led.execute("SELECT * FROM event WHERE seq=1").fetchone()
    for col, val in (("seq", 1), ("event_id", row[1]), ("idem_key", row[10])):
        data = list(row)
        data[0], data[1], data[10] = 1, row[1], row[10]
        if col == "seq":
            data[1], data[10] = "new-id", "new-idem"
        elif col == "event_id":
            data[0], data[10] = 99, "new-idem"
        else:
            data[0], data[1] = 99, "new-id"
        with _pt.raises(_sq.DatabaseError):
            led.execute("INSERT OR REPLACE INTO event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", data)
    sha = led.execute("SELECT sha FROM payload LIMIT 1").fetchone()[0]
    with _pt.raises(_sq.DatabaseError):
        led.execute("INSERT OR REPLACE INTO payload VALUES(?,?)", (sha, b"{}"))
    assert led.execute("SELECT count(*) FROM event").fetchone()[0] == 2
    assert _L.verify_chain(led).ok


def test_export_refuses_gap_after_restore(led, mk, kb_home):
    _L.append(led, [mk() for _ in range(3)])
    bak = kb_home / "old.db"
    b = _sq.connect(bak)
    led.backup(b)
    b.close()
    _L.export_segment(led)
    _L.append(led, [mk() for _ in range(2)])
    _L.export_segment(led)
    # 낡은 백업(seq 3까지)에서 복원한 원장
    old = _sq.connect(bak, isolation_level=None)
    old.execute("PRAGMA journal_mode=WAL")
    _L.append(old, [mk(idem="different-a"), mk(idem="different-b"), mk(idem="different-c")])
    with _pt.raises(_L.LedgerError):
        _L.export_segment(old)
    old.close()


def _rewrite_segment(seg, lines):
    (ledger.export_dir() / seg["file"]).write_bytes(
        ledger._zst(b"".join(canon_json(x) + b"\n" for x in lines)))


def _three(led, mk):
    ledger.append(led, [mk(subject=f"f-{n}", payload={"body": f"{n}-살아있음"}) for n in "abc"])
    return ledger.export_segment(led)[0]


def test_reseal_refuses_live_body_marked_redacted(led, mk):
    """변조로 지워진 살아 있는 줄이 다른 줄의 재봉인을 타고 유효한 봉인을 받으면 안 된다."""
    seg = _three(led, mk)
    lines = ledger.read_segment(seg["file"])
    lines[1]["payload"] = {"redacted": True}
    _rewrite_segment(seg, lines)
    before = ledger.manifest_rows()
    ledger.redact(led, "f-a", "t", "user:sagae")
    with pytest.raises(ledger.LedgerError, match="살아 있는 본문"):
        ledger.reseal_segment(led, 1)
    assert ledger.manifest_rows() == before
    assert ledger.segment_sha(seg["file"]) == seg["sha256"]


def test_reseal_refuses_forged_line_with_own_hash(led, mk):
    """줄 안에서만 맞춘 해시는 원장의 해시와 달라 통과하지 못한다."""
    seg = _three(led, mk)
    lines = ledger.read_segment(seg["file"])
    lines[2]["actor"] = "user:forged"
    lines[2]["hash"] = ledger.row_hash(lines[2])
    _rewrite_segment(seg, lines)
    with pytest.raises(ledger.LedgerError, match="변조"):
        ledger.reseal_segment(led, 1)


def test_reseal_refuses_extra_key(led, mk):
    seg = _three(led, mk)
    lines = ledger.read_segment(seg["file"])
    lines[0]["note"] = "덧붙인 내용"
    _rewrite_segment(seg, lines)
    with pytest.raises(ledger.LedgerError, match="형식"):
        ledger.reseal_segment(led, 1)


def test_reseal_recovery_with_genuine_body_equal_to_mark(led, mk, monkeypatch):
    """본문이 진짜로 표지와 같은 레코드가 있어도 행 기록 직전 크래시를 복구한다."""
    ledger.append(led, [mk(subject="f-g", payload={"redacted": True}), mk(subject="f-r", payload={"body": "비밀"})])
    seg = ledger.export_segment(led)[0]
    ledger.redact(led, "f-r", "t", "user:sagae")
    with monkeypatch.context() as m:
        m.setattr(ledger, "_append_manifest", lambda row: (_ for _ in ()).throw(RuntimeError("crash")))
        with pytest.raises(RuntimeError):
            ledger.reseal_segment(led, 1)
    row = ledger.reseal_segment(led, 1)
    assert row["recovered"] and row["lines"] == [2]
    assert ledger.read_segment(seg["file"])[0]["payload"] == {"redacted": True}
    assert ledger.reseal_segment(led, 1) is None


def test_reseal_recovery_counts_new_redact_too(led, mk, monkeypatch):
    """행을 못 쓴 재봉인 뒤에 다른 줄이 또 지워져도 두 줄 모두 행에 남고 봉인이 일치한다."""
    seg = _three(led, mk)
    ledger.redact(led, "f-a", "t", "user:sagae")
    with monkeypatch.context() as m:
        m.setattr(ledger, "_append_manifest", lambda row: (_ for _ in ()).throw(RuntimeError("crash")))
        with pytest.raises(RuntimeError):
            ledger.reseal_segment(led, 1)
    ledger.redact(led, "f-b", "t", "user:sagae")
    row = ledger.reseal_segment(led, 1)
    assert row["recovered"] and row["lines"] == [1, 2]
    assert ledger.segment_sha(seg["file"]) == row["sha256"]
    assert ledger.reseal_segment(led, 1) is None


@pytest.mark.parametrize("change", [
    {"on_behalf_of": "user:other"}, {"on_behalf_of": None}, {"generated_by": "m2"}, {"generated_by": None},
])
def test_idem_conflict_on_attribution(led, mk, change):
    a = mk(idem="attr", on_behalf_of="user:sagae", generated_by="m1")
    assert not ledger.append(led, [a])[0]["replayed"]
    assert ledger.append(led, [dict(a)])[0]["replayed"]
    with pytest.raises(ledger.IdemConflict):
        ledger.append(led, [{**a, **change}])


def test_idem_conflict_on_explicit_v(led, mk, monkeypatch):
    a = mk(idem="ver", v=1)
    ledger.append(led, [a])
    monkeypatch.setattr(ledger.upcast, "current_v", lambda kind: 2)
    with pytest.raises(ledger.IdemConflict):
        ledger.append(led, [{**a, "v": 2}])
    # v를 안 준 재시도는 코드 판이 올라가도 첫 응답을 받는다
    assert ledger.append(led, [{k: x for k, x in a.items() if k != "v"}])[0]["replayed"]
