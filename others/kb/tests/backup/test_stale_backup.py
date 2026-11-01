"""낡은 백업은 체인을 통과한다. 앵커만 유실을 드러내고, 복원은 앵커와 무관하게 epoch을 올린다."""
import shutil

from bkhelp import open_fp, put
from kb.core import ledger, opsdb
from kb.guard import anchor, drill, ship


def _setup(bk):
    h = bk.home
    bk.write_config([{"id": "local-c", "kind": "local", "repo": str(h / "repos" / "local-c")}])
    bk.init()
    open_fp()
    for i in range(3):
        put(f"앞 {i}", f"본문 {i}")
    assert ship.ship()["ok"]
    old_copy = h / "old-ledger.db"
    old_anchors = h / "old-anchors.ndjson"
    shutil.copy(h / "ship" / "ledger.db", old_copy)
    shutil.copy(anchor.anchors_path(), old_anchors)
    led = ledger.open_ledger()
    old_head = ledger.head(led)[0]
    led.close()
    for i in range(5):
        put(f"뒤 {i}", f"뒷 본문 {i}")
    ship.seal()     # 앵커가 새 머리로 간다(전송은 하지 않았다)
    led = ledger.open_ledger()
    new_head = ledger.head(led)[0]
    led.close()
    live = h / "live-anchors.ndjson"
    shutil.copy(anchor.anchors_path(), live)
    return old_copy, old_anchors, live, old_head, new_head


def test_stale_copy_passes_chain_but_anchor_shows_loss_and_epoch_rises(bk):
    old_copy, _oa, live, old_head, new_head = _setup(bk)
    assert new_head > old_head
    with drill.using_home(bk.home / "scratch1"):
        res = drill.restore_ledger(old_copy, anchors=[live])
        assert res["chain"]["ok"] and res["ok"]
        assert res["anchor"]["behind"] is True
        assert res["lost"] == {"from_seq": old_head + 1, "to_seq": new_head, "count": new_head - old_head}
        assert res["epoch"] == 1
        led = ledger.open_ledger()
        try:
            ev = ledger.iter_events(led, old_head, 5)[0]
            assert ev["kind"] == "schema.epoch_bumped"
            assert ev["payload"] == {"reason": "restore", "lost_from_seq": old_head + 1, "lost_to_seq": new_head}
            assert ledger.verify_chain(led).ok
        finally:
            led.close()
        c = opsdb.connect()
        try:
            assert c.execute("SELECT count(*) FROM incident WHERE kind='restore_loss'").fetchone()[0] == 1
        finally:
            c.close()


def test_epoch_rises_even_when_anchors_are_stale_too(bk):
    old_copy, old_anchors, _live, old_head, _n = _setup(bk)
    with drill.using_home(bk.home / "scratch2"):
        res = drill.restore_ledger(old_copy, anchors=[old_anchors])
        assert res["chain"]["ok"] and res["ok"]
        assert res["anchor"]["behind"] is False and res["lost"] is None, "앵커도 낡으면 유실을 알 수 없다"
        assert res["epoch"] == 1, "그래도 epoch은 오른다"
        led = ledger.open_ledger()
        try:
            ev = ledger.iter_events(led, old_head, 5)[0]
            assert ev["kind"] == "schema.epoch_bumped" and ev["payload"] == {"reason": "restore"}
        finally:
            led.close()


def test_anchor_mismatch_is_reported_as_not_ok(bk):
    old_copy, _oa, _live, old_head, _n = _setup(bk)
    forged = bk.home / "forged.ndjson"
    forged.write_text('{"at":1,"head_hash":"%s","seq":2}\n' % ("f" * 64))
    with drill.using_home(bk.home / "scratch3"):
        res = drill.restore_ledger(old_copy, anchors=[forged])
        assert res["ok"] is False and res["anchor"]["mismatch"][0]["seq"] == 2
        assert res["epoch"] == 1


def test_anchor_append_is_idempotent_and_tolerates_torn_tail(bk):
    open_fp()
    put("a", "본문")
    led = ledger.open_ledger()
    try:
        a1 = anchor.append_anchor(led)
        assert a1 and anchor.append_anchor(led) is None
        with open(anchor.anchors_path(), "ab") as f:
            f.write(b'{"seq": 99, "hea')   # 개행 없는 꼬리
        assert [x["seq"] for x in anchor.read_anchors()] == [a1["seq"]]
        assert anchor.ping_body() and '"seq"' in anchor.ping_body()
    finally:
        led.close()
