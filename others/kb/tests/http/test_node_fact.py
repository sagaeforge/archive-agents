"""패싯 요약 node_fact(gold_schema 3)와 현재 행 민감도가 원본 표에서 다시 계산한 값과 같고, 빠른 경로가 스캔 경로와 같다."""
import importlib
import json
from pathlib import Path

import pytest
from httphelp import E, World, claim, entity, record, seed, snap, verdict

from kb.core import ledger
from kb.project import create_gold
from kb.project.build import replay

F = importlib.import_module("kb.read.facets")
GOLDEN = Path(__file__).resolve().parents[1] / "golden" / "ledger.ndjson"


def expect_facts(g):
    """요약의 정의: 현재 버전이고 병합되지 않은 주장 밖 노드."""
    src = F.SRC_EXPR
    return sorted(g.execute(
        f"SELECT n.id, n.type, n.origin, n.eff_status, n.sensitivity, {src}, json_extract(CAST(n.props AS TEXT),'$.source'), "
        "(SELECT group_concat(domain) FROM (SELECT d.domain FROM node_domain d WHERE d.node_id=n.id ORDER BY d.domain)) "
        "FROM node n WHERE n.expired_at IS NULL AND n.merged_into IS NULL AND n.type<>'Claim'").fetchall())


def check_derived(g):
    assert sorted(g.execute("SELECT id, type, origin, eff_status, sensitivity, src, psrc, dom FROM node_fact").fetchall()) == expect_facts(g)
    for t in ("node", "edge"):
        bad = g.execute(f"SELECT x.id FROM {t} x JOIN head h ON h.id=x.id WHERE x.expired_at IS NULL AND x.sensitivity<>h.sensitivity").fetchall()
        assert bad == [], f"{t}의 현재 행 민감도가 head와 다르다"


def churn(w):
    """요약을 움직이는 이벤트를 전부 지나간다: 판정, 병합, 민감도 상승, 레코드 수정, 엣지, 주장, 문서 재수집."""
    seed(w)
    w.add(entity("e:tool:dead", "죽은 도구"), entity("e:tool:old", "옛 도구"), entity("e:tool:new", "새 도구"),
          E("edge.put", {"id": "r-03", "src": "e:tool:old", "rtype": "USES", "dst": "e:tool:new"}),
          E("edge.put", {"id": "r-04", "src": "e:tool:x", "rtype": "USES", "dst": "e:tool:new"}),
          snap("n-2", url="https://b.example/doc", source="src:b", domain="F", paras=("다른 문단입니다.", "셋째 문단입니다.")),
          snap("n-3", url="https://c.example/doc", source="src:a", domain="G", paras=("넷째 문단입니다.",)),
          claim("c-2", "e:tool:x", "다른 문단입니다", snap_id="n-2"),
          claim("c-3", "e:tool:new", "넷째 문단입니다", snap_id="n-3"),
          record("f-low", "낮은 메모", "public", body="공개 본문"))
    w.add(verdict("e:tool:dead", "dead", "removed"), E("entity.merge", {"from": "e:tool:old", "into": "e:tool:new"}),
          record("f-low", "낮은 메모", "private", body="올린 본문"), entity("e:tool:x", "도구 X 수정"))
    return w


def test_facts_follow_every_write(kb_home):
    w = churn(World(kb_home))
    try:
        check_derived(w.gold)
        assert w.gold.execute("SELECT COUNT(*) FROM node_fact WHERE id='e:tool:old'").fetchone()[0] == 0
        assert w.gold.execute("SELECT sensitivity FROM node_fact WHERE id='f-low'").fetchone()[0] == 2
    finally:
        w.close()


def test_facts_on_golden_replay(kb_home):
    led = ledger.open_ledger()
    ledger.append(led, [json.loads(x) for x in GOLDEN.read_text(encoding="utf-8").splitlines() if x])
    g = create_gold(kb_home / "scratch" / "golden.db")
    try:
        replay(led, g, missing="skip")
        assert g.execute("SELECT COUNT(*) FROM node_fact").fetchone()[0] > 0
        check_derived(g)
    finally:
        g.close()
        led.close()


CTXS = [{}, {"status": "all"}, {"status": "dead"}, {"types": "Tool"}, {"types": "Tool,Product"}, {"types": "Record", "status": "all"},
        {"origin": "first_party"}, {"origin": "external"}, {"source": "src:a"}, {"source": "src:b,src:a"}, {"source": "src:none"},
        {"domain": "F"}, {"domain": "none"}, {"domain": "F,none"}, {"max_sensitivity": "public"}, {"max_sensitivity": "secret"},
        {"source": "src:a", "origin": "external", "domain": "G", "status": "all"}, {"types": "Document"}, {"types": "Document", "source": "src:b"},
        {"types": "Snapshot", "source": "src:a"}]


@pytest.mark.parametrize("kw", CTXS, ids=lambda k: ",".join(f"{a}={b}" for a, b in k.items()) or "default")
def test_fast_path_equals_scan(kb_home, monkeypatch, kw):
    w = churn(World(kb_home))
    try:
        with w.rd(**kw) as (con, c):
            base = F._base(c)
            assert F._fact_facets(con, base) is not None, "빠른 경로를 타야 한다"
            got = F.facets(con, c)
            assert got == F._scan_facets(con, base, [], None)
            if kw.get("source") == "src:a" and kw.get("types") == "Snapshot":
                assert got["total"] == 2 and {x["value"] for x in got["facets"]["source"]} >= {"src:a", "src:b"}
    finally:
        w.close()


@pytest.mark.parametrize("kw", [{"types": "Claim"}, {"author": "user:sagae"}, {"as_of_observed": "2027-01-15T08:00:00Z"}])
def test_scan_only_requests(kb_home, kw):
    w = churn(World(kb_home))
    try:
        with w.rd(**kw) as (con, c):
            assert F._fact_facets(con, F._base(c)) is None
    finally:
        w.close()


def test_old_gold_without_summary_falls_back(kb_home, monkeypatch):
    w = churn(World(kb_home))
    try:
        with w.rd() as (con, c):
            real = F.facets(con, c)
        w.gold.execute("DROP TABLE node_fact")
        with w.rd() as (con, c):
            assert F.facets(con, c) == real
    finally:
        w.close()


def test_counts_day_floor_before_epoch(kb_home):
    """1970 이전 valid_from도 그날 0시로 내린다."""
    w = World(kb_home)
    try:
        w.add(entity("e:tool:a", "옛날"), entity("e:tool:b", "더 옛날"))
        w.gold.execute("BEGIN")
        w.gold.execute("UPDATE node SET valid_from=-1 WHERE id='e:tool:a'")
        w.gold.execute("UPDATE node SET valid_from=-86400000 WHERE id='e:tool:b'")
        w.gold.execute("COMMIT")
        with w.rd() as (con, c):
            out = F.counts(con, c, bucket="day", field="valid_from")
        assert [(x["start"][:10], x["count"]) for x in out["series"]] == [("1969-12-31", 2)]
    finally:
        w.close()
