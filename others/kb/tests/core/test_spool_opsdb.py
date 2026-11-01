import json
import re
import sqlite3

import pytest

from kb.core import conn as _conn
from kb.core import opsdb, paths, spool


def test_spool_roundtrip(kb_home):
    p = spool.put("in", {"b": 1, "a": "한"})
    assert p.parent == paths.spool_dir() / "in" and p.suffix == ".json"
    assert spool.put("in", {"a": "한", "b": 1}) == p  # 같은 내용은 같은 파일
    assert [x for _, x in spool.iter_items("in")] == [{"a": "한", "b": 1}]
    assert not list(p.parent.glob(".tmp*"))
    f = spool.put("fp-held", {"x": 1}, name="abc")
    assert f.name == "abc.json"
    dst = spool.mark_failed(p)
    assert dst.parent.name == ".failed" and not p.exists()
    assert list(spool.iter_items("in")) == []
    with pytest.raises(ValueError):
        spool.put("bogus", {})
    with pytest.raises(ValueError):
        spool.put("in", {}, name="../x")


def test_opsdb_basics(kb_home):
    c = opsdb.connect()
    assert c.execute("PRAGMA user_version").fetchone()[0] == opsdb.USER_VERSION
    names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"source_state", "url_state", "robots_cache", "fetch_log", "circuit", "queue", "candidate", "review", "dlq", "run",
            "tick_state", "metric", "incident", "query_log", "drill", "boot_test"} <= names
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    rid = opsdb.record_run(c, "tick")
    opsdb.record_run(c, "tick", run_id=rid, outcome="ok", detail={"n": 1})
    assert c.execute("SELECT outcome, detail FROM run WHERE id=?", (rid,)).fetchone() == ("ok", '{"n": 1}')
    i = opsdb.record_incident(c, "other", "x")
    assert opsdb.ack_incident(c, i, "확인") and not opsdb.ack_incident(c, i, "again")
    opsdb.record_metric(c, "m", 3, {"a": 1})
    opsdb.tick_state_set(c, "last_tick_at", 5)
    assert opsdb.tick_state_get(c, "last_tick_at") == "5" and opsdb.tick_state_get(c, "nope", "d") == "d"


def test_queue_round_robin_and_dedupe(kb_home):
    c = opsdb.connect()
    for i in range(3):
        assert opsdb.queue_put(c, "l2_para", f"g{i}", domain="G")
    assert opsdb.queue_put(c, "l2_para", "a0", domain="A")
    assert not opsdb.queue_put(c, "l2_para", "a0", domain="A")
    got = opsdb.queue_take(c, "l2_para", 2)
    assert {g["domain"] for g in got} == {"G", "A"}
    assert len(opsdb.queue_take(c, "l2_para", 10)) == 2
    assert opsdb.queue_take(c, "l2_para", 10) == []
    opsdb.queue_done(c, "l2_para", "a0", requeue_at=0)
    assert [g["ref"] for g in opsdb.queue_take(c, "l2_para", 5)] == ["a0"]
    opsdb.queue_put(c, "recapture", "later", next_at=2**60)
    assert opsdb.queue_take(c, "recapture", 5) == []


def test_version_mismatch_and_corrupt_recreated(kb_home):
    c = opsdb.connect()
    opsdb.tick_state_set(c, "k", "v")
    c.execute("PRAGMA user_version=99")
    c.close()
    c = opsdb.connect()
    assert c.execute("PRAGMA user_version").fetchone()[0] == opsdb.USER_VERSION
    assert opsdb.tick_state_get(c, "k") is None
    assert list(opsdb.ops_path().parent.glob("ops.db.old-*"))
    c.close()
    opsdb.ops_path().write_bytes(b"not a database" * 100)
    c = opsdb.connect()
    assert c.execute("PRAGMA user_version").fetchone()[0] == opsdb.USER_VERSION
    c.close()


def test_without_conn_arg(kb_home):
    opsdb.tick_state_set("a", "b")
    assert opsdb.tick_state_get("a") == "b"


def test_spool_name_collision_keeps_first(kb_home):
    p = spool.put("in", {"v": "first"}, name="k")
    with pytest.raises(spool.SpoolConflict):
        spool.put("in", {"v": "second"}, name="k")
    assert spool.put("in", {"v": "first"}, name="k") == p
    assert [x for _, x in spool.iter_items("in")] == [{"v": "first"}]
    assert not list(p.parent.glob(".tmp*"))


def test_mark_failed_never_overwrites(kb_home):
    for v in ("first", "second", "third", "third"):
        dst = spool.mark_failed(spool.put("in", {"v": v}, name="k"))
    failed = paths.spool_dir() / "in" / ".failed"
    got = sorted(json.loads(f.read_bytes())["v"] for f in failed.iterdir())
    assert got == ["first", "second", "third"] and dst.exists()


def test_broken_item_does_not_stop_iteration(kb_home):
    good = spool.put("in", {"a": "1"}, name="z")
    bad = good.with_name("a.json")
    bad.write_bytes(b'{"truncat')
    assert [x for _, x in spool.iter_items("in")] == [{"a": "1"}]
    assert not bad.exists() and (bad.parent / ".failed" / "a.json").read_bytes() == b'{"truncat'


def test_ddl_matches_adr(kb_home, repo):
    adr = (repo / "docs/adr/0001-architecture.md").read_text(encoding="utf-8")
    sec = adr[adr.index("### 7.11"):adr.index("## 8. ")]
    want = set(re.findall(r"CREATE TABLE (\w+)\(", sec))
    c = opsdb.connect()
    have = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert want and want == have - {"sqlite_sequence"}
    assert {r[1] for r in c.execute("PRAGMA table_info(url_state)")} >= {"source_id", "url", "discovered_from"}


def test_taken_item_comes_back_after_lease(kb_home):
    c = opsdb.connect()
    opsdb.queue_put(c, "l2_para", "p1")
    assert opsdb.queue_take(c, "l2_para", 5, lease_ms=-1)[0]["attempts"] == 1
    # 작업자가 죽었다. 다시 연 뒤 임대가 끝나 있으면 다시 꺼낸다
    c.close()
    c = opsdb.connect()
    assert not opsdb.queue_put(c, "l2_para", "p1")
    got = opsdb.queue_take(c, "l2_para", 5)
    assert [(g["ref"], g["attempts"]) for g in got] == [("p1", 2)]
    assert opsdb.queue_take(c, "l2_para", 5) == []  # 임대 중에는 나오지 않는다
    opsdb.queue_done(c, "l2_para", "p1")
    assert c.execute("SELECT count(*) FROM queue").fetchone()[0] == 0


def test_queue_reclaim(kb_home):
    c = opsdb.connect()
    opsdb.queue_put(c, "page", "u1")
    opsdb.queue_put(c, "live", "u2")
    opsdb.queue_take(c, "page", 1)
    opsdb.queue_take(c, "live", 1)
    assert opsdb.queue_reclaim(c, "page") == 1
    assert [g["ref"] for g in opsdb.queue_take(c, "page", 1)] == ["u1"]
    assert opsdb.queue_take(c, "live", 1) == []
    assert opsdb.queue_reclaim(c) == 2


@pytest.mark.parametrize("code", [sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_CANTOPEN,
                                  sqlite3.SQLITE_IOERR, sqlite3.SQLITE_FULL])
def test_transient_open_error_keeps_ops_db(kb_home, monkeypatch, code):
    c = opsdb.connect()
    opsdb.record_incident(c, "other", "미확인 사고")
    c.close()

    def fail(*a, **k):
        e = sqlite3.OperationalError("주입")
        e.sqlite_errorcode = code
        raise e

    monkeypatch.setattr(_conn, "connect_rw", fail)
    with pytest.raises(sqlite3.OperationalError):
        opsdb.connect()
    monkeypatch.undo()
    monkeypatch.setenv("KB_HOME", str(kb_home))
    assert not list(opsdb.ops_path().parent.glob("ops.db.old-*"))
    c = opsdb.connect()
    assert c.execute("SELECT count(*) FROM incident").fetchone()[0] == 1


def test_real_lock_does_not_move_ops_db(kb_home):
    c = opsdb.connect()
    opsdb.record_incident(c, "other", "미확인 사고")
    c.close()
    holder = sqlite3.connect(opsdb.ops_path(), isolation_level=None)
    holder.execute("PRAGMA locking_mode=EXCLUSIVE")
    holder.execute("BEGIN EXCLUSIVE")
    with pytest.raises(sqlite3.OperationalError):
        opsdb.connect()
    holder.execute("COMMIT")
    holder.close()
    assert not list(opsdb.ops_path().parent.glob("ops.db.old-*"))
    assert opsdb.connect().execute("SELECT count(*) FROM incident").fetchone()[0] == 1


def test_empty_file_is_filled_in_place(kb_home):
    opsdb.ops_path().parent.mkdir(parents=True)
    opsdb.ops_path().write_bytes(b"")
    c = opsdb.connect()
    assert c.execute("PRAGMA user_version").fetchone()[0] == opsdb.USER_VERSION
    assert not list(opsdb.ops_path().parent.glob("ops.db.old-*"))


def test_iter_items_survives_races_and_deep_json(kb_home, monkeypatch):
    from kb.core import spool
    d = spool.dir_of("in")
    spool.put("in", {"a": 1}, name="a1")
    d.joinpath("b-deep.json").write_bytes(b"[" * 200000)
    d.joinpath("c-bad.json").write_bytes(b"{nope")
    spool.put("in", {"z": 1}, name="z9")
    real = spool.mark_failed
    calls = []

    def racy(path):  # 다른 프로세스가 먼저 처리한 경합을 흉내 낸다
        calls.append(path.name)
        path.unlink()
        return real(path)  # 이미 없으므로 FileNotFoundError

    monkeypatch.setattr(spool, "mark_failed", racy)
    got = [p.name for p, _ in spool.iter_items("in")]
    assert got == ["a1.json", "z9.json"] and sorted(calls) == ["b-deep.json", "c-bad.json"]
    monkeypatch.setattr(spool, "mark_failed", real)
    d.joinpath("b-deep.json").write_bytes(b"[" * 200000)
    assert [p.name for p, _ in spool.iter_items("in")] == ["a1.json", "z9.json"]
    assert (d / ".failed" / "b-deep.json").exists()
