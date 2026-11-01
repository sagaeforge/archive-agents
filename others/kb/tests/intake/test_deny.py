import json
import os
import stat

import pytest

from ihelp import NODE
from kb.cli import main
from kb.core import spool
from kb.intake import core, deny
from kb.core import ledger


def test_missing_or_empty_blocks_plan_and_run_with_no_writes(sample, capsys):
    man, _ = sample
    p = deny.deny_path()
    p.unlink()
    for act in ("plan", "run"):
        assert main(["intake", act, "--json", "--manifest", "/nonexistent.yaml"]) == 1  # 매니페스트보다 먼저가 아니어도 exit 1
        capsys.readouterr()
    import kb.intake as intake
    for fn in (intake.plan, intake.run):
        with pytest.raises(intake.IntakeError) as e:
            fn(man)
        assert e.value.code == "E_DENY_MISSING"
    p.write_text("\n# 주석만\n")
    with pytest.raises(intake.IntakeError):
        intake.run(man)
    assert not list(spool.dir_of("fp-held").glob("*.json")) if spool.dir_of("fp-held").exists() else True
    assert not ledger.ledger_path().exists()


def test_cli_exit_1_when_missing(sample, tmp_path, capsys):
    man, _ = sample
    import yaml
    mp = tmp_path / "m.yaml"
    mp.write_text(yaml.safe_dump(man, allow_unicode=True))
    deny.deny_path().unlink()
    assert main(["intake", "run", "--json", "--manifest", str(mp)]) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "E_DENY_MISSING"
    assert not ledger.ledger_path().exists()


def test_deny_build_0600_and_no_names_in_output(env, capsys, tmp_path):
    deny.deny_path().unlink()
    nodes = tmp_path / "nodes.txt"
    nodes.write_text(f"{NODE}\n{NODE}-2\n")
    assert main(["intake", "deny-build", "--nodes", str(nodes), "--copy-dir", str(env / "copy"), "--json"]) == 0
    out = capsys.readouterr()
    assert NODE not in out.out and NODE not in out.err
    d = json.loads(out.out)
    assert d["sources"]["nodes"] == 2 and d["entries"] >= 3
    assert stat.S_IMODE(os.stat(deny.deny_path()).st_mode) == 0o600
    assert NODE in deny.deny_path().read_text()
    # 멱등: 다시 돌려도 항목이 늘지 않고 기존 항목을 유지한다
    assert main(["intake", "deny-build", "--copy-dir", str(env / "copy"), "--json"]) == 0
    d2 = json.loads(capsys.readouterr().out)
    assert d2["entries"] == d["entries"] and d2["added"] == 0


def test_deny_build_collects_internal_hosts_from_copy(env):
    (env / "copy" / "x.md").write_text("접속 mybox.lan 및 settings.local.json")
    r = deny.build(env / "copy", set())
    assert r["sources"]["copy_hosts"] == 1
    names = deny.load()
    assert "mybox.lan" in names and not any("settings.local" in n for n in names)


def test_node_name_never_reaches_events_logs_or_return(sample, capsys):
    man, _ = sample
    r = core.run(man)
    capsys.readouterr()
    assert NODE not in json.dumps(r) and r["scrubbed_lines"] >= 5
    blob = ""
    for _, o in spool.iter_items("fp-held"):
        blob += json.dumps(o, ensure_ascii=False)
    c = ledger.open_ledger()
    try:
        blob += json.dumps(c.execute("SELECT * FROM event").fetchall(), default=str)
        blob += json.dumps(c.execute("SELECT body FROM payload").fetchall(), default=str)
    finally:
        c.close()
    assert NODE not in blob and NODE.upper() not in blob
    v = core.verify(man)
    assert v["deny_hits"] == 0 and v["internal_addr_hits"] == 0 and v["by_treat_mismatch"] == 0 and v["deny_entries"] >= 1
