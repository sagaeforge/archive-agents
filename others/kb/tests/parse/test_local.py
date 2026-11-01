"""O07 codex features list: 가짜 codex와 가짜 HOME에서만 돈다. 전역 파일을 건드리지 않는다."""
import os
import stat
from types import SimpleNamespace

from kb.parse import local, tick_stage
from kb.core import cas

from .conftest import fx, gold


def fake_codex(dirpath, body: str, code=0):
    p = dirpath / "codex"
    p.write_text(f"#!/bin/sh\necho \"HOME=$HOME CODEX_HOME=$CODEX_HOME\" >&2\ncat <<'EOF'\n{body}\nEOF\nexit {code}\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return p


def test_codex_features_job_captures_in_fake_home(env, monkeypatch, tmp_path):
    import yaml
    (env.share / "sources" / "domains" / "t.yaml").write_text(yaml.safe_dump({"sources": [{
        "id": "src:codex-features", "name": "x", "domain": ["G"], "class": "rel", "parser": "codex_features@1",
        "fetch": {"kind": "local_exec"}, "policy": {"enabled": False, "tos": "allowed", "robots": "enforce", "reason": "local_exec"}}]}))
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake_codex(bindir, fx("codex_features.txt").decode())
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    real_home = os.environ.get("HOME")
    out = local.codex_features()
    assert "captured" in out
    assert (env.home / "codex-home").is_dir() and os.environ.get("HOME") == real_home
    assert local.codex_features() == {"unchanged": True}
    ctx = SimpleNamespace(expired=lambda: False, counters={"parsed": 0}, warnings=[], errors=[], only=None)
    assert tick_stage.run(ctx).detail["parsed"] == 1
    con = gold()
    rows = con.execute("SELECT c.value FROM node n JOIN claim c ON c.vid=n.vid WHERE c.predicate='maintained_status' AND n.expired_at IS NULL "
                       "ORDER BY c.value").fetchall()
    assert [r[0] for r in rows] == ["experimental", "removed", "stable", "under_development"]


def test_codex_features_job_skips_without_binary(env, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    assert local.codex_features() == {"skipped": "no_codex"}


def test_codex_features_job_reports_failure(env, monkeypatch, tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake_codex(bindir, "boom", code=3)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    assert local.codex_features() == {"failed": "exit=3"}


def test_internal_job_is_registered():
    from pathlib import Path
    import yaml
    doc = yaml.safe_load((Path(__file__).resolve().parents[2] / "sources/internal.d/parse.yaml").read_text())
    j = doc["jobs"][0]
    assert j["run"] == "kb.parse.local:codex_features" and j["stage"] == 3
