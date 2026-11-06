"""E: 마운트 확인. 가짜 findmnt와 실패 주입 restic 래퍼로 돌고 /mnt/e에 쓰지 않는다."""
import json
import time
from pathlib import Path

import pytest

from bkhelp import PW, local_spec, offsite_spec
from kb.core import opsdb
from kb.guard import drill, ship
from kb.write import fpgate
from wrhelp import add_drill  # noqa: F401  (경로 확인용)


@pytest.fixture
def two(bk):
    """local-c + offsite-e, 마운트 정상."""
    h = bk.home
    (h / "fake-e").mkdir()
    bk.write_config([local_spec(h), offsite_spec(h)])
    bk.set_mount(str(h / "fake-e"))
    bk.init()
    return bk


def _res(r, tid):
    return next(x for x in r["targets"] if x["id"] == tid)


def _dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


def test_mounted_offsite_gets_data(two):
    r = ship.ship()
    assert r["ok"] and _res(r, "offsite-e")["result"] == "ok" and _res(r, "local-c")["result"] == "ok"
    assert two.snapshots("offsite-e", "t0") and two.snapshots("local-c", "t0")
    assert r["notices"] == [] and r["critical"] == []


@pytest.mark.parametrize("case,reason", [
    ("not_mounted", "not_mountpoint"),
    ("no_metadata", "option_missing:metadata"),
    ("bad_marker", "marker_mismatch"),
    ("wrong_source", "source_mismatch"),
    ("wrong_fs", "fstype_mismatch"),
])
def test_guard_failures_skip_only_offsite(two, case, reason):
    h = two.home
    mp = str(h / "fake-e")
    if case == "not_mounted":
        two.set_not_mounted()
    elif case == "no_metadata":
        two.set_mount(mp, options=r"rw,noatime,aname=drvfs;path=E:\;uid=1000")
    elif case == "bad_marker":
        (h / "fake-e" / "kb-restic" / ".kb-offsite-id").write_text("other-disk\n")
    elif case == "wrong_source":
        two.set_mount(mp, source="F:\\")
    elif case == "wrong_fs":
        two.set_mount(mp, fstype="ext4")
    before = _dir_bytes(h / "fake-e")
    r = ship.ship()
    assert _res(r, "offsite-e")["result"] == "unavailable" and _res(r, "offsite-e")["reason"] == reason
    assert _res(r, "local-c")["result"] == "ok", "건너뜀이 local-c를 막지 않는다"
    assert r["ok"], "건너뜀은 실패가 아니다"
    assert _dir_bytes(h / "fake-e") == before, "쓰기 0바이트"
    assert any(n["code"] == "offsite_unmounted" and n["reason"] == reason for n in r["notices"])
    c = opsdb.connect()
    try:
        row = c.execute("SELECT dims FROM metric WHERE name='target_unavailable'").fetchone()
    finally:
        c.close()
    assert json.loads(row[0]) == {"reason": reason, "target": "offsite-e"}


def test_unmounted_empty_dir_gets_nothing_at_all(bk):
    """마운트가 빠진 /mnt/e: 대상 경로가 아예 생기지 않는다."""
    h = bk.home
    bk.write_config([local_spec(h), offsite_spec(h, sub="gone-e")])
    bk.set_not_mounted()
    bk.init() if False else None
    ship.init_repo(ship.load_targets()[0], ship.load_secrets())
    r = ship.ship()
    assert _res(r, "offsite-e")["result"] == "unavailable"
    assert not (h / "gone-e").exists()


def test_io_error_fails_only_that_target_then_rechecks(two, monkeypatch):
    monkeypatch.setenv("KB_RESTIC_BIN", two.wrapper())
    off = next(t for t in ship.load_targets() if t.id == "offsite-e")
    monkeypatch.setenv("KB_FAIL_REPO", off.repo)
    r = ship.ship()
    assert not r["ok"]
    assert _res(r, "offsite-e")["result"] == "failed" and "input/output" in _res(r, "offsite-e")["error"]
    assert _res(r, "local-c")["result"] == "ok"
    assert ship.state_get("ship.recheck.offsite-e") == "1"
    # 드라이브가 돌아온 다음 주기: unlock -> check -> backup 순서, 그 대상만 이어 전송
    monkeypatch.delenv("KB_FAIL_REPO")
    n = len(two.calls())
    r2 = ship.ship()
    assert r2["ok"] and _res(r2, "offsite-e")["result"] == "ok" and _res(r2, "local-c")["result"] == "clean"
    seq = [c.split(" ", 1)[1].split()[0] for c in two.calls()[n:] if c.startswith(off.repo)]
    assert seq.index("unlock") < seq.index("check") < seq.index("backup")
    assert ship.state_get("ship.recheck.offsite-e") is None


def test_remount_resumes_on_next_beat(two):
    two.set_not_mounted()
    r = ship.ship()
    assert _res(r, "offsite-e")["result"] == "unavailable"
    assert not two.snapshots("offsite-e", "t0")
    two.set_mount(str(two.home / "fake-e"))
    r2 = ship.ship(if_dirty=True)
    assert _res(r2, "offsite-e")["result"] == "ok", "마운트를 되살리면 같은 데이터를 이어 전송한다"
    assert two.snapshots("offsite-e", "t0")
    assert r2["notices"] == []


def test_offsite_drill_blocked_while_unmounted_and_fp_stays_closed(two):
    t = next(t for t in ship.load_targets() if t.id == "offsite-e")
    sec = ship.load_secrets()
    ship.ship(fingerprint=True)
    two.set_not_mounted()
    r = drill.drill_target(t, sec, offsite=True)
    assert r["ran"] is False and r["reason"].startswith("unavailable:")
    c = opsdb.connect()
    try:
        assert c.execute("SELECT count(*) FROM drill WHERE kind='restore_offsite'").fetchone()[0] == 0
    finally:
        c.close()
    o = fpgate.open_fp()
    assert not o.ok and "훈련" in o.error
    two.set_mount(str(two.home / "fake-e"))
    r = drill.drill_target(t, sec, offsite=True)
    assert r["ran"] and r["ok"], r
    o = fpgate.open_fp()  # --accept-single-copy 없이
    assert o.ok and o.mode == "drill"


def test_offsite_age_thresholds(two):
    now = int(time.time() * 1000)
    day = 86_400_000
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, "ship.ok.offsite-e.t0", str(now - 12 * 3600_000))
        opsdb.tick_state_set(c, "ship.ok.offsite-e.t1", str(now - 2 * day))
    finally:
        c.close()
    assert ship.health(now)["critical"] == []
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, "ship.ok.offsite-e.t0", str(now - day - 1000))
    finally:
        c.close()
    crit = ship.health(now)["critical"]
    assert [(x["code"], x["tier"]) for x in crit] == [("offsite_age", "t0")]
    c = opsdb.connect()
    try:
        opsdb.tick_state_set(c, "ship.ok.offsite-e.t1", str(now - 3 * day - 1000))
    finally:
        c.close()
    assert {x["tier"] for x in ship.health(now)["critical"]} == {"t0", "t1"}


def test_no_offsite_configured_means_no_age_alarm(bk):
    bk.write_config([local_spec(bk.home)])
    h = ship.health(int(time.time() * 1000) + 90 * 86_400_000)
    assert h == {"critical": [], "notices": [], "offsite": False}


def test_dry_run_writes_nothing(two):
    def snap():
        return sorted(str(p) for p in two.home.rglob("*") if not p.name.endswith(("-shm", "-wal")))
    before = snap()
    r = ship.ship(dry_run=True)
    assert r["dry_run"] and isinstance(r["targets"], list) and r["offsite"] is True
    assert {x["id"] for x in r["targets"]} == {"local-c", "offsite-e"}
    assert before == snap()
