"""sources-inventory 9장, sources-inventory-g 10장의 죽은 데이터 사례가 기본 검색에 활성으로 나오지 않는다 (WP-21). 실운영 읽기 전용."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

import pytest

LIVE = Path("/home/user/sagae-kb-data")
# 저장소 라벨, 기대 상태, 후속 라벨(sources-inventory-g 10장). 대표 표본이다.
SEED = [
    ("RooCodeInc/Roo-Code", "removed", None),
    ("continuedev/continue", "removed", None),
    ("coder/agentapi", "removed", None),
    ("microsoft/autogen", "superseded", "microsoft/agent-framework"),
    ("openai/swarm", "superseded", "openai/openai-agents-python"),
    ("opencode-ai/opencode", "superseded", "charmbracelet/crush"),
]


def _home() -> Path:
    return Path(os.environ.get("KB_HOME") or LIVE)


def _gold() -> sqlite3.Connection:
    p = _home() / "derived" / "gold" / "current" / "graph.db"
    if not p.exists():
        pytest.skip(f"없음: {p}")
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def _head(c, label: str):
    return c.execute("""SELECT n.id, n.eff_status FROM node n JOIN head h ON h.id = n.id AND h.version = n.version
                        WHERE n.type='Repo' AND lower(n.label)=lower(?)""", (label,)).fetchone()


@pytest.mark.parametrize("label,state,successor", SEED)
def test_seed_marked_dead(label, state, successor):
    c = _gold()
    row = _head(c, label)
    assert row is not None, f"적재 안 됨: {label}"
    assert row[1] == state, (label, row[1])
    if successor:
        s = _head(c, successor)
        assert s is not None, f"후속 적재 안 됨: {successor}"
        n = c.execute("SELECT count(*) FROM edge WHERE src=? AND dst=? AND type='SUCCESSOR_OF'", (s[0], row[0])).fetchone()[0]
        assert n >= 1, (label, successor)


@pytest.mark.parametrize("label,state,successor", SEED)
def test_seed_not_in_default_search(label, state, successor):
    c = _gold()
    row = _head(c, label)
    if row is None:
        pytest.fail(f"적재 안 됨: {label}")
    kb = _home() / "runtime" / "bin" / "kb"
    p = subprocess.run([str(kb), "search", label, "--json", "--limit", "50", "--kinds", "claim"], capture_output=True, text=True,
                       env=dict(os.environ, KB_HOME=str(_home())), timeout=120)
    assert p.returncode == 0, p.stderr[-300:]
    hits = [i for i in json.loads(p.stdout)["data"]["items"] if i.get("subject") == row[0] and i.get("kind") in ("state", "howto")]
    assert hits == [], hits
