"""kb agent run --scope public|sensitive: 인자, 기본 public, sensitive는 fp_open 전에 창 0건과 사유, --json이 agent-run 스키마를 통과."""
import json

import jsonschema
import pytest

from kb.cli import main
from kb.extract import settings

from . import helpers as H

SCHEMA = json.load(open(H.REPO / "schemas" / "cli" / "agent-run.schema.json"))


def _run(capsys, *argv):
    rc = main(["agent", "run", *argv, "--json"])
    return rc, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_default_scope_public(env, capsys):
    rc, out = _run(capsys, "--max-windows", "0")
    assert rc == 0 and out["scope"] == "public"
    jsonschema.validate(out, SCHEMA)


def test_sensitive_before_fp_open_zero_windows_with_reason(env, capsys, monkeypatch):
    import kb.write.fpgate as fp
    monkeypatch.setattr(fp, "is_open", lambda: False)
    with settings.override(**{"sllm.netns": False}):
        rc, out = _run(capsys, "--scope", "sensitive")
    assert rc == 0 and out["scope"] == "sensitive" and out["windows"] == 0 and out["reason"] == "fp_closed"
    jsonschema.validate(out, SCHEMA)


def test_bad_scope_rejected(env):
    with pytest.raises(SystemExit):
        main(["agent", "run", "--scope", "secret"])


def test_json_has_by_backend_and_scope_after_real_run(ent, capsys, monkeypatch):
    from kb.extract import runner
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    monkeypatch.setattr(runner, "default_backends", lambda: {"claude": f})
    with settings.override(**{"openrouter.enabled": False}):
        rc, out = _run(capsys, "--max-windows", "1")
    assert rc == 0 and out["windows"] == 1 and out["by_backend"] == {"claude": 1} and out["claims"] == 1
    jsonschema.validate(out, SCHEMA)
    assert out["queue_left"] == 0 and out["is_error"] is False
