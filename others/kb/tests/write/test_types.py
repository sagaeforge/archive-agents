import json
import shutil

from kb.cli import main
from kb.write import put_record, sync_schema, types
from wrhelp import count_events, gold_row


def test_sync_registers_types_and_predicates_once(wk):
    s1 = sync_schema()
    assert s1["types_written"] == s1["types_total"] >= 52 and s1["predicates_written"] == s1["predicates_total"] >= 30
    n = count_events()
    s2 = sync_schema()
    assert s2["events"] == 0 and count_events() == n  # 내용이 같으면 쓰지 않는다
    rows = dict((r[0], json.loads(r[1])) for r in gold_row("SELECT name, schema_json FROM type_def WHERE kind='node'"))
    assert rows["Note"]["x-kb-overview"] is True and rows["Series"]["x-kb-overview"] is True
    assert rows["Platform"]["x-kb-overview"] is True
    for t in ("Repo", "Package", "Person", "Channel", "Video", "Keyword", "Metric", "Claim", "Snapshot", "Source",
              "Document", "Ticket"):
        assert rows[t]["x-kb-overview"] is False, t
    ov = sorted(k for k, v in rows.items() if v["x-kb-overview"])
    assert ov == sorted("Platform Product Feature Tool Model Org Concept Technique Policy Note Decision Artifact "
                        "Learning Project Record Series".split())


def test_missing_overview_key_defaults_by_group():
    assert types.in_overview({"x-kb-group": "user"}, None) is True
    assert types.in_overview({"x-kb-group": "world"}, None) is False
    assert types.in_overview({"x-kb-group": "world", "x-kb-overview": True}, None) is True
    assert types.in_overview(None, "user") is True


def test_changed_file_bumps_version(wk, tmp_path, monkeypatch):
    from kb.core import paths
    share = tmp_path / "share"
    shutil.copytree(paths.share_dir() / "schemas", share / "schemas")
    monkeypatch.setenv("KB_SHARE", str(share))
    sync_schema()
    f = share / "schemas" / "types" / "Repo.json"
    d = json.loads(f.read_text())
    d["x-kb-overview"] = True
    f.write_text(json.dumps(d))
    s = sync_schema()
    assert s["types_written"] == 1
    r = gold_row("SELECT version, schema_json FROM type_def WHERE name='Repo' AND kind='node' ORDER BY version")
    assert [x[0] for x in r] == [1, 2] and json.loads(r[1][1])["x-kb-overview"] is True


def test_decision_props_validated(fp_open):
    import pytest
    from kb.write import WriteRejected
    with pytest.raises(WriteRejected) as ei:
        put_record({"type": "Decision", "title": "d", "body": "b", "props": {"status": "maybe"}}, "ty-1", "inbox")
    assert ei.value.code == "schema_invalid"
    assert put_record({"type": "Decision", "title": "d", "body": "b", "props": {"status": "accepted"}}, "ty-2", "inbox").version == 1


def test_cli_schema_sync(wk, capsys):
    assert main(["schema", "sync", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["types_written"] >= 52
