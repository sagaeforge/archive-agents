"""민감도·상태 필터는 visibility 함수 하나를 지난다. 숨김은 개수와 패싯에도 적용된다."""
import re
from pathlib import Path

import pytest

from kb import read
from .rhelp import E, claim, entity, record, snap, verdict

SRC = Path(__file__).resolve().parents[2] / "src" / "kb" / "read"
FORBIDDEN = [r"sensitivity\s*(<=|>=|<|>)\s*\?", r"eff_status\s*=\s*\?", r"verification\s+IN\b", r"FROM\s+head\b", r"JOIN\s+head\b"]


def test_filter_sql_lives_only_in_ctx():
    assert (SRC / "ctx.py").exists()
    for f in sorted(SRC.glob("*.py")):
        if f.name == "ctx.py":
            continue
        text = f.read_text(encoding="utf-8")
        for pat in FORBIDDEN:
            assert not re.search(pat, text, re.I), f"{f.name}에 필터 SQL이 있다: {pat}"


def test_every_listing_uses_visibility_sql():
    for name in ("nodes", "graph", "facets", "changes", "history", "series", "snapshots", "catalog", "cards"):
        assert "visibility_sql" in (SRC / f"{name}.py").read_text(encoding="utf-8"), name


@pytest.fixture
def world(w):
    w.add(entity("e:tool:pub", "공개도구"), snap(), claim("c-ok", "e:tool:pub", "공개도구는 위젯을 지원한다"),
          claim("c-nr", "e:tool:pub", "공개도구는 달을 지원한다", verification="needs_review"),
          record("f-int", "내부 메모", "internal"), record("f-priv", "비공개 메모", "private"), record("f-sec", "비밀 메모", "secret"),
          entity("e:tool:dead", "죽은도구"), entity("e:tool:old", "옛도구"), entity("e:tool:new", "새도구"))
    w.add(verdict("e:tool:dead", "dead", "removed"), E("entity.merge", {"from": "e:tool:old", "into": "e:tool:new"}))
    return w


def test_private_and_secret_are_404(world):
    with world.rd() as (con, c):
        assert read.get_node(con, c, "f-int")["label"] == "내부 메모"
        for nid in ("f-priv", "f-sec", "nope-1", "bad id", "r-1", "ev-1"):
            with pytest.raises(read.NotFound):
                read.get_node(con, c, nid)
        for fn in (read.node_body, read.history):
            with pytest.raises(read.NotFound):
                fn(con, c, "f-priv")
        for fn in (read.node_claims, read.node_edges, read.neighbors):
            with pytest.raises(read.NotFound):
                fn(con, c, "f-priv")


def test_dead_superseded_merged_direct_lookup_ok(world):
    with world.rd() as (con, c):
        d = read.get_node(con, c, "e:tool:dead")
        assert d["status"] == "dead" and d["liveness"] == "removed"
        m = read.get_node(con, c, "e:tool:old")
        assert (m["status"], m["merged_into"], m["merged_into_final"]) == ("superseded", "e:tool:new", "e:tool:new")
        # 목록에는 없다
        ids = [x["id"] for x in read.list_nodes(con, c)[0]["items"]]
        assert "e:tool:dead" not in ids and "e:tool:old" not in ids and "e:tool:new" in ids


def test_needs_review_claim_direct_200_with_verification(world):
    with world.rd() as (con, c):
        assert read.get_claim(con, c, "c-nr")["verification"] == "needs_review"
        assert read.get_node(con, c, "c-nr")["verification"] == "needs_review"
        assert [x["id"] for x in read.get_node(con, c, "e:tool:pub")["claims"]] == ["c-ok"]
        assert [x["id"] for x in read.node_claims(con, c, "e:tool:pub")[0]["items"]] == ["c-ok"]
    with world.rd(include_unverified=True) as (con, c):
        assert [x["id"] for x in read.node_claims(con, c, "e:tool:pub")[0]["items"]] == ["c-nr", "c-ok"]


def test_counts_and_facets_apply_hiding(world):
    with world.rd() as (con, c):
        data, page = read.list_nodes(con, c, type="Note")
        assert [x["id"] for x in data["items"]] == ["f-int"] and page["total"] == 1
        f = read.facets(con, c, filter=None)
        types = {x["value"]: x["count"] for x in f["facets"]["type"]}
        assert types.get("Note") == 1 and f["total"] == sum(types.values())
        m = read.meta(con, c)
        assert m["counts"]["claims"] == 1  # c-nr(needs_review)은 기본 필터에서 빠진다
        cat = read.catalog(con, c)
        assert {t["name"]: t["count"] for t in cat["node_types"]}["Note"] == 1
        n_day = sum(x["count"] for x in read.counts(con, c, bucket="day")["series"])
    with world.rd(max_sensitivity="private") as (con, c):
        assert sum(x["count"] for x in read.counts(con, c, bucket="day")["series"]) == n_day + 1  # f-priv
    with world.rd(max_sensitivity="private") as (con, c):  # 라이브러리 수준 상향(CLI는 못 올린다)
        assert read.list_nodes(con, c, type="Note")[1]["total"] == 2
