"""첫 적재가 결정적 경로만 썼는지 실운영 저장소를 읽기 전용으로 확인한다 (WP-25)."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest
import yaml

LIVE = Path("/home/user/sagae-kb-data")
REPO = Path(__file__).resolve().parents[2]


def _home() -> Path:
    p = os.environ.get("KB_HOME")
    return Path(p) if p else LIVE


def _ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        pytest.skip(f"없음: {path}")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def test_no_extract_run_in_ledger():
    c = _ro(_home() / "ledger" / "ledger.db")
    n = c.execute("select count(*) from event where kind like 'extract.run%'").fetchone()[0]
    assert n == 0


def test_no_agent_jobs_in_ops():
    c = _ro(_home() / "ops" / "ops.db")
    jobs = [r[0] for r in c.execute("select distinct job from run")]
    bad = [j for j in jobs if any(k in (j or "").lower() for k in ("agent", "extract", "llm", "claude", "codex", "l2"))]
    assert bad == [], bad


def test_no_denied_host_requests():
    deny = yaml.safe_load((REPO / "sources" / "host-policy.yaml").read_text(encoding="utf-8"))["deny"]
    c = _ro(_home() / "ops" / "ops.db")
    hit = []
    for host, outcome, status in c.execute("select host, outcome, status from fetch_log"):
        h = (host or "").lower()
        if any(h == d or h.endswith("." + d) for d in deny) and not str(outcome).startswith(("denied", "host_denied")):
            hit.append((h, outcome, status))
    assert hit == [], hit[:5]


def test_no_systemd_kb_units():
    """WP-25는 kb-agent 유닛을 설치하지 않는다. kb-tick, kb-read 유닛은 결정 3으로 합법이다."""
    d = Path.home() / ".config" / "systemd" / "user"
    if d.is_dir():
        assert [p.name for p in d.iterdir() if "kb-agent" in p.name.lower()] == []
