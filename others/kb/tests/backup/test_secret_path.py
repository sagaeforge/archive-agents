"""secret, private는 restic 암호화 경로로만 나간다. 평문 내보내기와 git에는 없다."""
import subprocess
from pathlib import Path

from bkhelp import held_item, inbox_files, open_fp, put, tree_has
from kb.core import cas, ledger, spool
from kb.guard import drill, export_md, ship
from kb.guard.redact import _git

SECRET = b"NEEDLE-SECRET-4417"
PRIVATE = b"NEEDLE-PRIVATE-9931"


def _cfg(bk, local_commit=False):
    h = bk.home
    bk.write_config([{"id": "local-c", "kind": "local", "repo": str(h / "repos" / "local-c")}])
    bk.init()
    (bk.cfg / "config.toml").write_text(f"[export]\nlocal_commit = {'true' if local_commit else 'false'}\n")
    return ship.load_targets()[0], ship.load_secrets()


def test_secret_in_restic_not_in_plaintext_export_or_git(bk):
    t, sec = _cfg(bk, local_commit=True)
    open_fp()
    put("공개", "공개 본문입니다", "public")
    put("내부", "내부 본문입니다", "internal")
    put("비공개", PRIVATE.decode(), "private")
    put("비밀", SECRET.decode(), "secret")
    big = put("대용량", "NEEDLE-BIG-1 " + "가나다 " * 30000, "internal")
    assert cas.iter_shas("fp") is not None and list(cas.iter_shas("fp")), "64KB 초과 본문은 raw/fp에 있다"
    held_item()
    inbox_files(bk.home)
    assert ship.ship()["ok"]
    # restic: 비밀 본문이 원장 사본에 있고, raw/fp, spool/fp-held, inbox 경로가 스냅샷에 든다
    ls = ship.run_restic(t, ["ls", "latest", "--tag", "t0", "--host", "kb"], sec).stdout
    for part in ("/raw/fp/", "/spool/fp-held/", "/inbox/", "/ledger/export/", "/ship/ledger.db", "/ledger/anchors.ndjson"):
        assert part in ls, part
    root = bk.home / "r"
    ship.run_restic(t, ["restore", "latest", "--tag", "t0", "--target", str(root)], sec)
    assert any("ship/ledger.db" in p for p in tree_has(root, SECRET))
    assert any("ship/ledger.db" in p for p in tree_has(root, PRIVATE))
    # 평문 내보내기와 git
    r = export_md.export_markdown()
    assert r["records"] == 3 and r["committed"] is True and r["pushed"] is False
    ex = export_md.export_root()
    assert tree_has(ex / "records", SECRET) == [] and tree_has(ex / "records", PRIVATE) == []
    log = _git(ex, "log", "-p", "--all").stdout
    assert SECRET.decode() not in log and PRIVATE.decode() not in log
    assert "공개 본문입니다" in log and "NEEDLE-BIG-1" in log
    assert "anchor: seq=" in _git(ex, "log", "-1", "--format=%B").stdout


def test_export_is_deterministic_and_local_commit_defaults_off(bk):
    _cfg(bk)
    open_fp()
    put("공개", "본문", "public")
    r1 = export_md.export_markdown()
    first = {p.name: p.read_bytes() for p in (export_md.export_root() / "records").glob("*.md")}
    r2 = export_md.export_markdown()
    assert r1["committed"] is False and r2["wrote"] == 0
    assert first == {p.name: p.read_bytes() for p in (export_md.export_root() / "records").glob("*.md")}
    assert not (export_md.export_root() / ".git").exists(), "기본은 자동 커밋 없음(결정 13)"
    # 민감도가 올라가면 파일이 사라진다
    put("공개", "본문", "secret", key="bk-up", id="f-up1")


def test_held_write_wakes_if_dirty(bk):
    _cfg(bk)
    r0 = put("보류1", "본문1")      # fp 닫힘: spool/fp-held에만 있다
    assert r0.held
    s1 = ship.ship(if_dirty=True)
    assert s1["ok"] and "skipped" not in s1
    led = ledger.open_ledger()
    head = ledger.head(led)
    led.close()
    s2 = ship.ship(if_dirty=True)
    assert s2.get("skipped") == "clean"
    r1 = put("보류2", "본문2")
    assert r1.held
    led = ledger.open_ledger()
    assert ledger.head(led) == head, "held 쓰기는 원장을 바꾸지 않는다"
    led.close()
    s3 = ship.ship(if_dirty=True)
    assert "skipped" not in s3 and s3["targets"][0]["result"] == "ok", "그래도 spool 변경이 전송을 깨운다"
    # inbox 변경도 마찬가지
    assert ship.ship(if_dirty=True).get("skipped") == "clean"
    inbox_files(bk.home)
    assert "skipped" not in ship.ship(if_dirty=True)
