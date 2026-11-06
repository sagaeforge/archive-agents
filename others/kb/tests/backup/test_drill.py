"""전체 삭제 후 복원 -> 체인 -> 앵커 -> 재구축 -> 지문. 원장 사본 없이 내보내기만으로도 재구성한다."""
import json
import shutil
from pathlib import Path

import pytest

from bkhelp import held_item, inbox_files, open_fp, project, put, wipe
from kb.core import cas, ledger, opsdb
from kb.guard import anchor, drill, ship
from projhelp import snap_events


def _seed(bk):
    h = bk.home
    bk.write_config([{"id": "local-c", "kind": "local", "repo": str(h / "repos" / "local-c")}])
    bk.init()
    open_fp()
    put("공개", "공개 본문입니다", "public")
    put("내부", "내부 본문입니다", "internal")
    put("비공개", "NEEDLE-PRIVATE-9931", "private")
    put("비밀", "NEEDLE-SECRET-4417", "secret")
    led = ledger.open_ledger()
    ledger.append(led, snap_events())
    led.close()
    held_item()
    inbox_files(h)
    project()
    t = ship.load_targets()[0]
    return t, ship.load_secrets()


def _head():
    led = ledger.open_ledger()
    try:
        return ledger.head(led)
    finally:
        led.close()


def test_wipe_restore_chain_anchor_rebuild_fingerprint(bk):
    t, sec = _seed(bk)
    r = ship.ship(fingerprint=True)
    assert r["ok"], r
    head = _head()
    spool_files = sorted(p.name for p in (bk.home / "spool" / "fp-held").glob("*.json"))
    inbox = sorted(p.relative_to(bk.home / "inbox").as_posix() for p in (bk.home / "inbox").rglob("*.md"))
    assert spool_files and len(inbox) == 2
    wipe(bk.home)
    assert not ledger.ledger_path().exists()

    res = drill.drill_target(t, sec, level="full", keep=True)
    assert res["ok"], res
    assert res["chain"]["ok"] and res["chain"]["head_seq"] == head[0]
    assert res["anchor"]["ok"] and res["anchor"]["anchor_seq"] == head[0] and res["lost"] is None
    b = res["between"]
    assert b["rebuild"]["swapped"] and b["fp_match"] is True and b["fingerprint"] == b["fp_reference"]
    assert res["epoch"] == 1 and res["gold_epoch"] == 1, "복원은 항상 epoch을 올린다"
    home = Path(res["home"])
    assert sorted(p.name for p in (home / "spool" / "fp-held").glob("*.json")) == spool_files
    assert sorted(p.relative_to(home / "inbox").as_posix() for p in (home / "inbox").rglob("*.md")) == inbox
    # 비밀 본문은 restic 안에서 복원된 원장에 있다(암호화 경로)
    with drill.using_home(home):
        led = ledger.open_ledger()
        try:
            assert any(b"NEEDLE-SECRET-4417" in (row[0] if isinstance(row[0], bytes) else row[0].encode())
                       for row in led.execute("SELECT body FROM payload"))
            assert ledger.verify_chain(led).ok
        finally:
            led.close()
    c = opsdb.connect()
    try:
        row = c.execute("SELECT kind, target, ok FROM drill ORDER BY id DESC LIMIT 1").fetchone()
    finally:
        c.close()
    assert row == ("restore_full", "local-c", 1)


def test_rebuild_from_export_only_without_ledger_copy(bk):
    t, sec = _seed(bk)
    assert ship.ship()["ok"]
    head = _head()
    wipe(bk.home)
    root = bk.home / "restored"
    got = drill.restore_tiers(t, sec, root, ("t0",))
    home = Path(got["home"])
    (home / "ship" / "ledger.db").unlink()      # 원장 스냅샷이 없다
    assert (home / "ledger" / "export" / "MANIFEST.ndjson").exists()
    with drill.using_home(home):
        res = drill.restore_ledger(from_export=True)
        assert res["ok"] and res["source"] == "export"
        assert res["chain"]["ok"] and res["chain"]["head_seq"] == head[0]
        assert res["export"]["events"] == head[0]
        led = ledger.open_ledger()
        try:
            h2 = ledger.head(led)
            assert h2[0] == head[0] + 1, "epoch 이벤트 하나만 더 붙는다"
            assert led.execute("SELECT hash FROM event WHERE seq=?", (head[0],)).fetchone()[0] == head[1]
            assert ledger.verify_chain(led).ok
        finally:
            led.close()


def test_refuses_to_overwrite_existing_ledger(bk):
    _seed(bk)
    copy = bk.home / "x.db"
    shutil.copy(ledger.ledger_path(), copy)
    with pytest.raises(drill.DrillError):
        drill.restore_ledger(copy)


def test_tampered_copy_is_not_installed(bk):
    t, sec = _seed(bk)
    ship.ship()
    copy = bk.home / "bad.db"
    shutil.copy(bk.home / "ship" / "ledger.db", copy)
    import sqlite3
    con = sqlite3.connect(copy)
    con.execute("DROP TRIGGER event_no_update")
    con.execute("UPDATE event SET actor='user:evil' WHERE seq=2")
    con.commit()
    con.close()
    shutil.rmtree(bk.home / "ledger")
    res = drill.restore_ledger(copy)
    assert res["ok"] is False and not res["chain"]["ok"]
    assert not ledger.ledger_path().exists()
