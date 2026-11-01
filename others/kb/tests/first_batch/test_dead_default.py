"""kb live run이 죽은 것으로 판정한 주장은 기본 검색에서 state, howto로 나오지 않고, event는 남는다 (WP-21). 실운영 읽기 전용."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

import pytest

LIVE = Path("/home/user/sagae-kb-data")


def _home() -> Path:
    return Path(os.environ.get("KB_HOME") or LIVE)


def _gold() -> sqlite3.Connection:
    p = _home() / "derived" / "gold" / "current" / "graph.db"
    if not p.exists():
        pytest.skip(f"없음: {p}")
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def _search(q: str, *extra: str) -> list[dict]:
    kb = _home() / "runtime" / "bin" / "kb"
    if not kb.exists():
        pytest.skip("kb 미배포")
    p = subprocess.run([str(kb), "search", q, "--json", "--limit", "50", *extra], capture_output=True, text=True,
                       env=dict(os.environ, KB_HOME=str(_home())), timeout=120)
    assert p.returncode == 0, p.stderr[-300:]
    return json.loads(p.stdout)["data"]["items"]


def test_dead_claims_hidden_from_default_search():
    c = _gold()
    dead = c.execute("""SELECT n.id, n.label, cl.kind FROM node n JOIN head h ON h.id = n.id AND h.version = n.version JOIN claim cl ON cl.vid = n.vid
                        WHERE n.type='Claim' AND n.eff_status IN ('removed','superseded') LIMIT 8""").fetchall()
    print(f"dead_claims={len(dead)}")       # 0건이면 건수만 남기고 통과한다
    for nid, label, kind in dead:
        if kind not in ("state", "howto"):
            continue
        ids = {i["id"] for i in _search(label or "", "--kinds", "claim")}
        assert nid not in ids, (nid, label)


def test_events_kept_with_time():
    c = _gold()
    rows = c.execute("""SELECT n.id, n.valid_from FROM node n JOIN claim cl ON cl.vid = n.vid
                        WHERE n.type='Claim' AND cl.kind='event' AND n.status='active' LIMIT 20""").fetchall()
    for nid, vf in rows:
        assert vf is not None, nid
