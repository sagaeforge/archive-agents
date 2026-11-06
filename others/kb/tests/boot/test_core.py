import sqlite3

import pytest

from kb.core import config, conn, paths


def _mi(tmp_path, rows):
    f = tmp_path / "mountinfo"
    f.write_text("".join(rows))
    return str(f)


ROWS = [
    "1 0 8:1 / / rw - ext4 /dev/sda rw\n",
    "2 1 0:5 / /tmp rw - tmpfs tmpfs rw\n",
    "3 1 0:6 / /mnt/c rw - 9p C:\\134 rw\n",
    "4 1 0:7 / /mnt/d rw - drvfs D: rw\n",
    "5 1 0:8 / /mnt/with\\040space rw - tmpfs tmpfs rw\n",
]


@pytest.mark.parametrize("p", ["/tmp/x/y", "/mnt/c/a", "/mnt/d", "/mnt/with space/q"])
def test_check_fs_rejects(tmp_path, p):
    with pytest.raises(paths.FsRejected):
        paths.check_fs(p, _mi(tmp_path, ROWS))


def test_check_fs_ok(tmp_path):
    assert paths.check_fs("/home/x", _mi(tmp_path, ROWS)) == "ext4"


def test_check_fs_real_tmp_rejected_or_ok():
    # 이 머신의 /tmp는 tmpfs다. 실제 mountinfo로도 거부되는지 본다.
    if paths.fstype_of("/tmp") == "tmpfs":
        with pytest.raises(paths.FsRejected):
            paths.check_fs("/tmp/x")


def test_share_dir(monkeypatch, repo):
    monkeypatch.delenv("KB_SHARE", raising=False)
    assert paths.share_dir() == repo
    monkeypatch.setenv("KB_SHARE", "/a/b")
    assert str(paths.share_dir()) == "/a/b"


def test_config_dir(monkeypatch):
    monkeypatch.setenv("KB_CONFIG_DIR", "/c/d")
    assert str(paths.config_dir()) == "/c/d"
    monkeypatch.delenv("KB_CONFIG_DIR")
    assert str(paths.config_dir()).endswith(".config/sagae-kb")


def test_config_defaults_and_decisions(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_CONFIG_DIR", str(tmp_path))
    assert config.get("collect.session_tick") is False
    assert config.get("read.allowed_hosts") == ["127.0.0.1", "localhost"]
    assert config.get("nope.x", 7) == 7
    assert config.decisions() == set() and not config.decision_ok(1)
    (tmp_path / "decisions.toml").write_text("approved=[1,3]\n")
    (tmp_path / "config.toml").write_text("[export]\nlocal_commit=true\n")
    assert config.decisions() == {1, 3} and config.decision_ok(3)
    assert config.get("export.local_commit") is True
    assert config.get("export.push_allowed") is False


def test_sqlite_too_old(kb_home, monkeypatch):
    monkeypatch.setattr(sqlite3, "sqlite_version_info", (3, 46, 1))
    with pytest.raises(conn.SqliteTooOld):
        conn.connect_rw(kb_home / "a.db", "FULL")


def test_connect_rw_ro(kb_home):
    if sqlite3.sqlite_version_info < conn.MIN_SQLITE:
        pytest.skip("SQLite 낮음")
    c = conn.connect_rw(kb_home / "a.db", "NORMAL")
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    c.execute("create table t(x)")
    c.execute("insert into t values (1)")
    r = conn.connect_ro(kb_home / "a.db")
    assert r.execute("select x from t").fetchone() == (1,)
    with pytest.raises(sqlite3.OperationalError):
        r.execute("insert into t values (2)")


def test_connect_ro_deadline(kb_home):
    if sqlite3.sqlite_version_info < conn.MIN_SQLITE:
        pytest.skip("SQLite 낮음")
    conn.connect_rw(kb_home / "a.db", "NORMAL").close()
    r = conn.connect_ro(kb_home / "a.db", deadline_s=0.05)
    with pytest.raises(sqlite3.OperationalError):
        r.execute("with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c").fetchone()


def test_connect_rw_rejects_tmpfs():
    if paths.fstype_of("/tmp") == "tmpfs":
        with pytest.raises(paths.FsRejected):
            conn.connect_rw("/tmp/zz-kb-test.db", "FULL")
