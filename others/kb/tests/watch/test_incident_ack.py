"""미확인 사고는 치명. kb incident ack 뒤 open 0, 노트 보존."""
import json

from kb.cli import main
from kb.core import opsdb
from kb.guard import status
from conftest import codes


def test_unacked_incident_is_critical_until_ack(env, capsys):
    i1 = opsdb.record_incident("global_file_change", "~/.claude/x 변경", "~/.claude/x")
    i2 = opsdb.record_incident("external_send", "개인 정보 포함 요청")
    st = status.build()
    assert st["ok"] is False and st["incidents"]["open"] == 2
    inc = next(x for x in st["critical"] if x["code"] == "incident_open")
    assert inc["ids"] == [i1, i2] and inc["count"] == 2
    assert [x["id"] for x in st["incidents"]["items"]] == [i1, i2]

    assert main(["incident", "ack", str(i1), "--note", "사용자에게 보고함"]) == 0
    capsys.readouterr()
    st = status.build()
    assert st["incidents"]["open"] == 1 and "incident_open" in codes(st["critical"])

    assert main(["incident", "ack", str(i2), "--note", "오탐 확인"]) == 0
    capsys.readouterr()
    st = status.build()
    assert st["incidents"]["open"] == 0 and "incident_open" not in codes(st["critical"])
    assert st["ok"] is True

    assert main(["incident", "list", "--all", "--json"]) == 0
    rows = {r["id"]: r for r in json.loads(capsys.readouterr().out)["items"]}
    assert rows[i1]["ack_note"] == "사용자에게 보고함" and rows[i2]["ack_note"] == "오탐 확인"
    assert rows[i1]["acked_at"] is not None


def test_ack_requires_note_and_is_idempotent_safe(env, capsys):
    i = opsdb.record_incident("other", "x")
    assert main(["incident", "ack", str(i), "--note", "  "]) == 2
    assert opsdb.ack_incident(i, "첫 노트") is True
    assert main(["incident", "ack", str(i), "--note", "덮어쓰기 시도"]) == 1     # 이미 닫힘: 첫 노트를 보존
    capsys.readouterr()
    c = opsdb.connect()
    assert c.execute("SELECT ack_note FROM incident WHERE id=?", (i,)).fetchone()[0] == "첫 노트"
    c.close()


def test_list_shows_only_open_by_default(env, capsys):
    a = opsdb.record_incident("other", "열림")
    b = opsdb.record_incident("other", "닫힘")
    opsdb.ack_incident(b, "ok")
    assert main(["incident", "list", "--json"]) == 0
    d = json.loads(capsys.readouterr().out)
    assert [r["id"] for r in d["items"]] == [a] and d["open"] == 1
