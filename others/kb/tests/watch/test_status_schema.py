"""kb status --json이 schemas/cli/status.schema.json을 통과한다. 빈 저장소와 채운 저장소 모두."""
import json

import jsonschema

from kb.cli import main
from kb.core import opsdb
from conftest import REPO, mk_source
from test_by_domain import seed_gold

SCHEMA = json.loads((REPO / "schemas" / "cli" / "status.schema.json").read_text())


def validate(capsys):
    assert main(["status", "--json"]) == 0
    d = json.loads(capsys.readouterr().out)
    jsonschema.validate(d, SCHEMA)
    return d


def test_empty_store(env, capsys):
    d = validate(capsys)
    assert d["ok"] is True and d["counts"]["claims_active"] == 0 and d["incidents"]["open"] == 0


def test_populated_store_with_findings(env, set_registry, capsys):
    set_registry([mk_source("src:multi", domain=("C", "D", "E"))])
    seed_gold(env)
    opsdb.record_incident("other", "시험")
    d = validate(capsys)
    assert d["ok"] is False and d["counts"]["snapshots"] == 2 and d["incidents"]["open"] == 1
    assert d["data_as_of"] is not None


def test_status_does_not_create_files(env, capsys, monkeypatch):
    import shutil
    shutil.rmtree(env.home / "ops", ignore_errors=True)
    main(["status", "--json"])
    capsys.readouterr()
    assert not (env.home / "ops").exists(), "kb status는 읽기 전용이다"
