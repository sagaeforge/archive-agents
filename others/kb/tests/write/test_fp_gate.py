import json

from kb.cli import main
from kb.core import spool
from kb.write import fpgate, put_record
from wrhelp import add_drill, count_events

REC = {"type": "Note", "title": "보류 시험", "body": "보관될 본문 알파벳 zebra", "sensitivity": "internal"}


def held_files():
    d = spool.dir_of("fp-held")
    return sorted(d.glob("*.json")) if d.exists() else []


def test_closed_gate_holds_and_is_idempotent(wk):
    r = put_record(REC, "gate-k1", "mcp", "s-a")
    assert r.held and r.reason == "offsite_path_missing" and not r.projected and r.seq is None
    assert count_events() == 0
    assert len(held_files()) == 1
    r2 = put_record(REC, "gate-k1", "mcp", "s-a")
    assert r2.held and r2.id == r.id and len(held_files()) == 1 and count_events() == 0
    ev = json.loads(held_files()[0].read_text())["events"][-1]
    assert ev["payload"]["authored_at"] > 0 and ev["actor"] == "agent:s-a" and ev["on_behalf_of"] == "user:sagae"


def test_held_validation_still_runs(wk):
    import pytest
    from kb.write import WriteRejected
    with pytest.raises(WriteRejected):
        put_record({**REC, "sensitivity": "bogus"}, "gate-k2", "mcp", "s-a")
    assert held_files() == []


def test_cli_fp_status_list_open(wk, capsys, monkeypatch):
    put_record(REC, "gate-k3", "mcp", "s-a")
    assert main(["fp", "status", "--json"]) == 0
    st = json.loads(capsys.readouterr().out)
    assert st == {"held": 1, "open": False}
    assert main(["fp", "list", "--grep", "ZEBRA", "--json"]) == 0
    assert len(json.loads(capsys.readouterr().out)["items"]) == 1
    assert main(["fp", "list", "--grep", "없는단어", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["items"] == []
    assert main(["fp", "open", "--json"]) == 1  # 훈련 기록 없음
    assert "훈련" in json.loads(capsys.readouterr().out)["error"]
    assert main(["fp", "open", "--accept-single-copy", "--json"]) == 1  # 비 TTY
    assert "TTY" in json.loads(capsys.readouterr().out)["error"]
    assert not fpgate.is_open() and len(held_files()) == 1


def test_stale_or_failed_drill_does_not_open(wk):
    add_drill(ok=0)
    add_drill(ok=1, age_ms=8 * 24 * 3600 * 1000)
    assert not fpgate.open_fp().ok
    assert not fpgate.is_open()


def test_accept_single_copy_needs_tty_decision_and_phrase(wk):
    cfg = wk / "config"
    r = fpgate.open_fp(True, tty=True, confirm=lambda: fpgate.ACCEPT_PHRASE)
    assert not r.ok and "결정 2" in r.error
    (cfg / "decisions.toml").write_text("approved = [1, 2]\n")
    r = fpgate.open_fp(True, tty=True, confirm=lambda: "아니오")
    assert not r.ok and "문장" in r.error
    r = fpgate.open_fp(True, tty=True, confirm=lambda: fpgate.ACCEPT_PHRASE)
    assert r.ok and r.mode == "accept_single_copy" and fpgate.is_open()
