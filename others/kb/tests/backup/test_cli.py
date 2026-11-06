"""kb ship / drill / export 명령 연결."""
import json
import shutil

from bkhelp import local_spec, open_fp, put, wipe
from kb.cli import main
from kb.core import ledger
from kb.guard import ship


def _j(capsys):
    return json.loads(capsys.readouterr().out)


def test_init_ship_check_drill_and_restore_commands(bk, capsys):
    h = bk.home
    bk.write_config([local_spec(h)])
    assert main(["ship", "--init", "local-c", "--json"]) == 0
    assert _j(capsys)["id"] == "local-c"
    open_fp()
    put("공개", "본문", "public")
    assert main(["ship", "--json", "--fingerprint"]) == 0
    r = _j(capsys)
    assert r["ok"] and r["targets"][0]["result"] == "ok"
    assert main(["ship", "--if-dirty", "--json"]) == 0
    assert _j(capsys)["skipped"] == "clean"
    assert main(["drill", "check", "--json"]) == 0
    assert _j(capsys)["ok"]
    assert main(["drill", "restore", "--level", "ledger", "--json"]) == 0
    assert _j(capsys)["ok"]
    assert main(["export", "markdown", "--json"]) == 0
    assert _j(capsys)["records"] == 1
    # 원장 사본으로 복원 명령
    copy = h / "x.db"
    shutil.copy(h / "ship" / "ledger.db", copy)
    wipe(h)
    assert main(["drill", "restore", "--ledger", str(copy), "--json"]) == 0
    res = _j(capsys)
    assert res["ok"] and res["epoch"] == 1
    assert main(["drill", "restore", "--ledger", str(copy), "--json"]) == 1   # 이미 있다
    assert "원장이 이미 있다" in _j(capsys)["error"]


def test_bad_secrets_permission_is_refused(bk, capsys):
    bk.write_config([local_spec(bk.home)])
    (bk.cfg / "secrets.env").chmod(0o644)
    assert main(["ship", "--json"]) == 1
    assert "권한" in _j(capsys)["errors"][0]


def test_dry_run_without_targets_has_array_and_no_offsite(bk, capsys):
    assert main(["ship", "--dry-run", "--json"]) == 0
    r = _j(capsys)
    assert r["targets"] == [] and r["offsite"] is False
