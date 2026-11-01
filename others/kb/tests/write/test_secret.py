import hashlib

import pytest

from kb.write import WriteRejected, owner, put_record
from wrhelp import gold_row

TOKEN = "ghp_" + hashlib.sha256(b"a").hexdigest()[:36]
ENV = "API_SECRET_TOKEN=Zk3fQ9xLm2Vb7Rt8Yw1Ns4Hd6Jc0Pa5G"
KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----"


def rec(**kw):
    return {"type": "Note", "title": "비밀 시험", "body": "평범", "sensitivity": "internal", **kw}


@pytest.mark.parametrize("name,r", [
    ("본문 토큰", rec(body=f"토큰은 {TOKEN} 입니다")),
    ("본문 개인 키", rec(body=KEY)),
    ("본문 env", rec(body=f"설정\n{ENV}\n끝")),
    ("제목", rec(title=f"토큰 {TOKEN}")),
    ("props", rec(props={"memo": {"deep": [f"x {TOKEN}"]}})),
    ("링크", rec(links=[{"rtype": "LINKS_TO", "dst": "e:x:y"}, {"rtype": TOKEN, "dst": "e:x:z"}])),
])
def test_detected_becomes_secret_with_quarantine_and_warning(fp_open, name, r):
    res = put_record(r, "sec-" + name, "mcp", "s-a")
    assert any(w.startswith("secret_detected:") for w in res.warnings), res.warnings
    row = gold_row("SELECT sensitivity, props FROM node WHERE id=? AND expired_at IS NULL", (res.id,))[0]
    assert row[0] == 3
    assert b'"quarantine"' in row[1] or '"quarantine"' in str(row[1])
    import json
    pr = json.loads(row[1])
    assert pr["quarantine"] is True
    assert TOKEN not in json.dumps({k: pr[k] for k in pr if k.startswith("quarantine")})  # 표시에 비밀값이 새지 않는다


def test_plain_autoupdater_line_not_flagged(fp_open):
    res = put_record(rec(body="DISABLE_AUTOUPDATER=1\nFOO=bar"), "sec-ok", "mcp", "s-a")
    assert not res.warnings
    assert gold_row("SELECT sensitivity FROM node WHERE id=? AND expired_at IS NULL", (res.id,))[0][0] == 1


def test_secret_release_restores(fp_open):
    res = put_record(rec(body=f"{ENV}", sensitivity="private"), "sec-rel", "mcp", "s-a")
    with pytest.raises(WriteRejected) as ei:
        owner.release_secret(res.id, tty=False)
    assert ei.value.code == "tty_required"
    r2 = owner.release_secret(res.id, tty=True)
    assert r2.version == 2
    row = gold_row("SELECT sensitivity, props FROM node WHERE id=? AND expired_at IS NULL", (res.id,))[0]
    assert row[0] == 2 and (row[1] is None or "quarantine" not in str(row[1]))
    with pytest.raises(WriteRejected) as ei:
        owner.release_secret(res.id, tty=True)
    assert ei.value.code == "not_quarantined"


def test_owner_read_returns_secret_body_tty_only(fp_open):
    res = put_record(rec(body=f"{TOKEN}"), "sec-own", "mcp", "s-a")
    with pytest.raises(WriteRejected):
        owner.read_record(res.id, tty=False)
    got = owner.read_record(res.id, tty=True)
    assert got["body"] == TOKEN and got["sensitivity"] == "secret" and got["version"] == 1


def test_cli_owner_read_refuses_without_tty(fp_open, capsys):
    from kb.cli import main
    res = put_record(rec(), "sec-cli", "mcp", "s-a")
    assert main(["owner", "read", res.id]) == 1
