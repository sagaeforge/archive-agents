import pytest

from kb.cli import main
from kb.write import WriteRejected, author, put_record
from wrhelp import events, gold_row

REC = {"type": "Note", "title": "작성자", "body": "본문", "sensitivity": "internal"}


def last(rid):
    return events("subject=? AND kind='record.put'", (rid,))[-1]


def test_author_field_is_schema_rejected(fp_open):
    for extra in ({"author": "user:sagae"}, {"actor": "x"}, {"on_behalf_of": "x"}, {"origin": "external"},
                  {"source_url": "https://x"}, {"quote": "q"}):
        with pytest.raises(WriteRejected) as ei:
            put_record({**REC, **extra}, "au-bad", "mcp", "s-a")
        assert ei.value.code == "schema_invalid"
    assert events("kind='record.put'") == []


def test_mcp_session_and_default(fp_open, monkeypatch):
    r = put_record(REC, "au-1", "mcp", "sess-7f3a")
    row = last(r.id)
    assert (row[3], row[4]) == ("agent:sess-7f3a", "user:sagae")
    monkeypatch.setenv("KB_MCP_SESSION", "tower")
    r = put_record({**REC, "title": "t2"}, "au-2", "mcp")
    assert (last(r.id)[3], last(r.id)[4]) == ("agent:tower", "user:sagae")
    monkeypatch.delenv("KB_MCP_SESSION")
    r = put_record({**REC, "title": "t3"}, "au-3", "mcp")
    assert last(r.id)[3] == "agent:" + author.process_session() and author.process_session().startswith("s-")
    assert gold_row("SELECT author, on_behalf_of FROM node WHERE id=? AND expired_at IS NULL", (r.id,))[0] == (
        last(r.id)[3], "user:sagae")


def test_cli_tty_and_non_tty(fp_open):
    r = put_record(REC, "au-4", "cli", tty=True)
    assert (last(r.id)[3], last(r.id)[4]) == ("user:sagae", None)
    r = put_record({**REC, "title": "n"}, "au-5", "cli", tty=False)
    assert (last(r.id)[3], last(r.id)[4]) == ("agent:cli", None)


def test_cli_command_non_tty_is_agent_cli(fp_open, tmp_path, capsys):
    import json
    f = tmp_path / "r.json"
    f.write_text(json.dumps({"record": REC, "idempotency_key": "au-6"}))
    assert main(["put", "-f", str(f), "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert last(out["id"])[3] == "agent:cli"
    # 같은 호출 재시도는 첫 응답
    assert main(["put", "-f", str(f), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["replayed"] is True


def test_inbox_and_intake(fp_open):
    r = put_record(REC, "au-7", "inbox")
    assert (last(r.id)[3], last(r.id)[4]) == ("user:sagae", None)
    r = put_record({**REC, "title": "i"}, "au-8", "intake", "research-s9")
    assert (last(r.id)[3], last(r.id)[4]) == ("agent:research-s9", "user:sagae")
    with pytest.raises(WriteRejected):
        put_record({**REC, "title": "j"}, "au-9", "intake")
    with pytest.raises(WriteRejected):
        put_record({**REC, "title": "k"}, "au-10", "bogus")
