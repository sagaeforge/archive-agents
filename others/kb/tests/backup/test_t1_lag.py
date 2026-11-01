"""T1(raw/objects)은 하루 주기라 복원본의 원장이 객체보다 앞선다. 재구축은 끝까지 가고 없는 객체를 넘긴다."""
from pathlib import Path

from bkhelp import open_fp, project
from kb.core import cas, ledger, opsdb
from kb.guard import drill, ship
from projhelp import snap_events


def test_rebuild_after_t1_lag_records_gaps_and_recapture(bk):
    h = bk.home
    bk.write_config([{"id": "local-c", "kind": "local", "repo": str(h / "repos" / "local-c")}])
    bk.init()
    open_fp()
    led = ledger.open_ledger()
    ledger.append(led, snap_events(sid="n-a", url="https://a.example/x", paras=("A 첫 문단", "A 둘째 문단")))
    led.close()
    project()
    r = ship.ship()
    assert r["ok"] and {x["tier"] for x in r["targets"][0]["tiers"]} == {"t0", "t1", "t3"}
    # 하루가 안 지났다: 새 객체는 T0 원장에만 있다
    evs = snap_events(sid="n-b", url="https://b.example/x", paras=("B 첫 문단", "B 둘째 문단"))
    new_objs = [evs[1]["payload"]["text_sha"], evs[1]["payload"]["paras_sha"]]
    led = ledger.open_ledger()
    ledger.append(led, evs)
    led.close()
    project()
    r2 = ship.ship(if_dirty=True)
    assert [x["tier"] for x in r2["targets"][0]["tiers"]] == ["t0"], "T1은 아직 만기가 아니다"
    t, sec = ship.load_targets()[0], ship.load_secrets()
    from bkhelp import wipe
    wipe(h)
    res = drill.drill_target(t, sec, level="full", keep=True)
    assert res["ok"], res
    b = res["between"]
    assert b["rebuild"]["swapped"] and b["rebuild"]["missing"] >= 1
    assert b["gaps"]["gaps"] >= 1 and b["gaps"]["queued"] >= 1
    home = Path(res["home"])
    with drill.using_home(home):
        for sha in new_objs:
            assert not cas.exists(sha)
        led = ledger.open_ledger()
        try:
            n = led.execute("SELECT count(*) FROM event WHERE kind='gap.recorded'").fetchone()[0]
            assert n >= 1 and ledger.verify_chain(led).ok
        finally:
            led.close()
        c = opsdb.connect()
        try:
            q = c.execute("SELECT ref FROM queue WHERE kind='recapture'").fetchall()
        finally:
            c.close()
        assert ("n-b",) in q
