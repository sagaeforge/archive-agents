"""kb-first-collect 사고가 ops.db와 kb status에 나타나고, 표본 감사 결과가 런북에 있다 (WP-21). 실운영 읽기 전용."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path

import pytest

LIVE = Path("/home/user/sagae-kb-data")
REPO = Path(__file__).resolve().parents[2]


def _home() -> Path:
    return Path(os.environ.get("KB_HOME") or LIVE)


def _archives() -> list[Path]:
    return sorted((_home() / "ops" / "runs").glob("*-kb-first-collect.ndjson*"))


def _lines(p: Path) -> list[dict]:
    raw = p.read_bytes()
    if p.suffix == ".zst":
        from compression import zstd
        raw = zstd.decompress(raw)
    return [json.loads(x) for x in raw.decode().splitlines() if x.strip()]


def test_workflow_returns_incidents():
    src = (REPO / ".claude" / "workflows" / "kb-first-collect.js").read_text(encoding="utf-8")
    assert re.search(r"incidents: INCIDENTS", src)
    assert re.search(r"skipped: 'utilization', incidents: \[\]", src)


def test_incidents_reach_ops_and_status():
    if not _archives():
        pytest.skip("kb-first-collect 실행 기록 없음")
    from kb.agentrun import stream
    found = []
    for a in _archives():
        for ev in _lines(a):
            if ev.get("type") in ("result", "system", "assistant", "user"):
                found += list(stream.incidents_in(ev))
    if not found:
        return
    c = sqlite3.connect(f"file:{_home() / 'ops' / 'ops.db'}?mode=ro", uri=True)
    rows = [r[0] for r in c.execute("select detail from incident")]
    for inc in found:
        assert any(inc["detail"][:80] in r for r in rows), inc
    st = json.loads(subprocess.run([str(_home() / "runtime" / "bin" / "kb"), "status", "--json"], capture_output=True, text=True,
                                   env=dict(os.environ, KB_HOME=str(_home())), timeout=120).stdout)
    assert st["incidents"]["open"] >= 0 and isinstance(st["critical"], list)


def test_audit_mismatches_in_runbook():
    t = (REPO / "docs" / "runbooks" / "first-collection.md").read_text(encoding="utf-8")
    m = re.search(r"### 표본 감사.*?(?=\n### |\n## |\Z)", t, re.S)
    assert m, "결과 절에 표본 감사가 없다"
    assert "검사 50건" in m.group(0) and "불일치" in m.group(0)
