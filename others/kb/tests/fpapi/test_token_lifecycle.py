"""3.3: 합성 api-tokens만 사용. CLI TTY는 시험 대역으로 만든다."""
import re
import stat
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from kb.cli import main
from kb.serve import http as H
from kb.write import tty
from test_http_write import api, data, problem  # noqa: F401
from test_write_core import core  # noqa: F401


@pytest.fixture
def terminal(monkeypatch):
    monkeypatch.setattr(tty, "is_tty", lambda: True)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)


def issue(capsys, label="loupe", scope="editor"):
    assert main(["token", "create", "--scope", scope, "--label", label]) == 0
    token = capsys.readouterr().out.strip()
    assert token.startswith("kbt_") and "\n" not in token
    return token


def token_id(token):
    import hashlib
    digest = hashlib.sha256(token.encode()).hexdigest()
    row = next(line for line in H.tokens_path().read_text().splitlines() if digest in line)
    identifiers = re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", row)
    assert len(identifiers) == 1, "해시 행에는 독립 uuid7 tok_id가 있어야 한다"
    assert uuid.UUID(identifiers[0]).version == 7
    return identifiers[0]


def test_default_expiry_is_180_days_and_tok_id_is_uuid7(api, terminal, capsys):
    before = datetime.now(timezone.utc)
    token = issue(capsys)
    after = datetime.now(timezone.utc)
    assert token_id(token)
    text = H.tokens_path().read_text()
    assert token not in text
    assert stat.S_IMODE(H.tokens_path().stat().st_mode) == 0o600
    # Storage format is deliberately not prescribed: inspect timestamp values, not column positions.
    times = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in
             re.findall(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)", text)]
    assert any(before + timedelta(days=180, seconds=-1) <= at <= after + timedelta(days=180)
               for at in times), "기본 만료는 발급 시각 + 180일"


@pytest.mark.parametrize("label", ["Loupe", "-loupe", "a" * 33, "loupe space", ""])
def test_invalid_app_labels_are_rejected_without_token_file_changes(api, label):
    path = H.tokens_path()
    before = path.read_bytes() if path.exists() else None
    with pytest.raises(ValueError):
        H.create_token("editor", label)
    assert (path.read_bytes() if path.exists() else None) == before


def test_live_labels_unique_and_revoked_label_reusable(api, terminal, capsys):
    old = issue(capsys)
    before = H.tokens_path().read_bytes()
    with pytest.raises(ValueError):
        H.create_token("editor", "loupe")
    assert H.tokens_path().read_bytes() == before
    assert main(["token", "revoke", "--label", "loupe"]) == 0
    capsys.readouterr()
    assert H.tokens_path().read_bytes().startswith(before)
    new = issue(capsys)
    assert token_id(new) != token_id(old)
    assert H.token_scope(old) is None and H.token_scope(new) == "editor"


def test_rotation_appends_revocation_and_changes_tok_id(api, terminal, capsys):
    old = issue(capsys)
    old_id, before = token_id(old), H.tokens_path().read_bytes()
    assert main(["token", "rotate", "--label", "loupe"]) == 0
    new = capsys.readouterr().out.strip()
    assert new != old and token_id(new) != old_id
    assert H.tokens_path().read_bytes().startswith(before)
    problem(api.create(old), 401, "token_invalid")
    assert api.create(new).status == 201


def test_expired_bearer_is_401_for_socket_reads_and_writes(api, monkeypatch):
    class OldClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz or timezone.utc) - timedelta(days=181)

    with monkeypatch.context() as patch:
        patch.setattr(H, "datetime", OldClock)
        expired = api.token()
    problem(api.create(expired), 401, "token_invalid")
    problem(api.call("GET", "/v1/meta", expired), 401, "token_invalid")


@pytest.mark.parametrize("operation", ["create", "rotate", "revoke"])
def test_token_management_requires_tty(api, terminal, capsys, monkeypatch, operation):
    issue(capsys)
    monkeypatch.setattr(tty, "is_tty", lambda: False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    before = H.tokens_path().read_bytes()
    args = ["token", operation, "--label", "other" if operation == "create" else "loupe"]
    if operation == "create":
        args += ["--scope", "editor"]
    assert main(args) != 0
    assert H.tokens_path().read_bytes() == before


def test_revoked_bearer_is_401_on_socket_read(api, terminal, capsys):
    token = issue(capsys)
    assert main(["token", "revoke", "--label", "loupe"]) == 0
    problem(api.call("GET", "/v1/meta", token), 401, "token_invalid")
    problem(api.create(token), 401, "token_invalid")
