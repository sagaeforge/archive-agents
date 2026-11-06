"""카탈로그(/v1/schema), 봉투, 커서, 저하 표시, 읽기 시간 제한, kb get."""
import json

import pytest

from kb import read
from kb.cli import main
from kb.read.envelope import etag, make_cursor
from .rhelp import E, claim, entity, record, snap


def _defs(w):
    td = lambda n, v, **kw: E("schema.type_defined", {"name": n, "kind": "node", "version": v, "status": "active", "schema_json": kw})
    w.add(td("Repo", 1, properties={"stars": {"type": "integer", "x-kb-sortable": True}, "lang": {"type": "string"}}),
          td("Person", 1, **{"x-kb-overview": True}), td("Note", 1), td("Tool", 1),
          E("schema.type_defined", {"name": "USES", "kind": "edge", "version": 1, "status": "active",
                                    "schema_json": {"x-kb-from": ["Tool"], "x-kb-to": ["Tool"]}}),
          entity("e:repo:r", "R", props={"stars": 3}), entity("e:tool:a", "A"), entity("e:tool:b", "B"), entity("e:widget:w", "W"),
          snap(), claim("c-1", "e:tool:a", "a는 위젯을 지원한다", predicate="supports", value="x"), record("f-1", "메모"),
          E("edge.put", {"id": "r-ab", "src": "e:tool:a", "rtype": "USES", "dst": "e:tool:b"}))


def test_catalog(w):
    _defs(w)
    with w.rd() as (con, c):
        cat = read.catalog(con, c)
    nt = {t["name"]: t for t in cat["node_types"]}
    assert nt["Repo"]["group"] == "world" and nt["Repo"]["in_overview"] is False and nt["Repo"]["count"] == 1 and nt["Repo"]["status"] == "active"
    assert nt["Person"]["in_overview"] is True  # x-kb-overview: true
    assert nt["Note"]["in_overview"] is True and nt["Tool"]["in_overview"] is True  # 사용자 타입, ADR 초기값
    assert nt["Widget"]["status"] == "provisional" and nt["Widget"]["group"] == "world" and nt["Widget"]["in_overview"] is False
    assert nt["Claim"]["group"] == "fact" and nt["Snapshot"]["group"] == "evidence" and nt["Claim"]["in_overview"] is False
    assert {p["name"]: (p["type"], p["filterable"], p["sortable"]) for p in nt["Repo"]["properties"]} == {"stars": ("integer", True, True), "lang": ("string", True, False)}
    assert cat["overview_types"] == sorted(t for t, v in nt.items() if v["in_overview"]) and "Claim" not in cat["overview_types"]
    assert cat["sort_keys"]["*"] == ["id", "label", "recorded_at"] and cat["sort_keys"]["Repo"] == ["id", "label", "recorded_at", "stars"]
    assert cat["filter_keys"] == ["types", "origin", "status", "domain", "source", "author"]
    assert cat["enums"]["sensitivity"] == ["public", "internal", "private", "secret"] and set(cat["enums"]) == {
        "origin", "sensitivity", "status", "selector_kind", "claim_kind", "hit_kind", "stance", "method", "precision", "evidence_state"}
    et = {t["name"]: t for t in cat["edge_types"]}
    assert et["USES"]["count"] == 1 and et["USES"]["group"] == "structure" and et["USES"]["from"] == ["Tool"] and et["SNAPSHOT_OF"]["group"] == "source"
    assert [p["id"] for p in cat["predicates"]] == ["supports"]


def test_overview_default_types_come_from_catalog(w):
    _defs(w)
    with w.rd() as (con, c):
        data, _ = read.overview(con, c)
        assert {r[1] for r in data["nodes"]["rows"]} == {"Tool", "Note"}  # Repo, Widget은 개요 밖


def test_envelope_fields_etag_and_page(w):
    w.add(entity("e:tool:a", "A"))
    w.gold.execute("INSERT INTO meta(k,v) VALUES('build_id','g-000000001-ab12') ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    with w.rd(as_of_valid="2027-01-01", as_of_observed="2027-01-02T03:04:05.678Z") as (con, c):
        env = read.envelope(con, c, {"x": 1}, page={"next_cursor": None, "total": 1, "truncated": False})
        assert list(env) == ["schema_version", "epoch", "build_id", "data_as_of", "applied_seq", "as_of", "degraded", "data", "page"]
        assert env["schema_version"] == "0.3.1" and env["epoch"] == 1 and env["build_id"] == "g-000000001-ab12" and env["degraded"] == []
        assert env["as_of"] == {"valid": "2027-01-01T00:00:00Z", "observed": "2027-01-02T03:04:05.678Z"}
        assert env["data_as_of"].endswith("Z") and etag(env) == f'"1-{env["applied_seq"]}-g-000000001-ab12"'
    out = read.read(w.ctx(), read.get_node, "e:tool:a")
    assert out["data"]["id"] == "e:tool:a" and "page" not in out
    out = read.read(w.ctx(), read.list_nodes)
    assert out["page"]["total"] == 1


def test_degraded_from_ops_db(w, kb_home):
    from kb.core import opsdb
    w.add(entity("e:tool:a", "A"))
    ops = opsdb.connect()
    opsdb.tick_state_set(ops, "boot_path_unverified", "1")
    opsdb.tick_state_set(ops, "ledger_head_seq", "999999")
    opsdb.tick_state_set(ops, "behind_since_ms", "1000")  # 오래전부터 뒤처짐
    ops.close()
    with w.rd() as (con, c):
        assert read.envelope(con, c, {})["degraded"] == ["boot_path_unverified", "stale_build"]
    ops = opsdb.connect()
    opsdb.tick_state_set(ops, "behind_since_ms", str(2 ** 62))  # 방금 뒤처짐: 유예 안
    ops.close()
    with w.rd() as (con, c):
        assert read.envelope(con, c, {})["degraded"] == ["boot_path_unverified"]


def test_cursor_epoch_and_mismatch(w):
    w.add(*[entity(f"e:tool:t{i}", f"T{i}") for i in range(4)])
    with w.rd() as (con, c):
        _, p = read.list_nodes(con, c, limit=2)
        assert len(read.list_nodes(con, c, limit=2, cursor=p["next_cursor"])[0]["items"]) == 2
        with pytest.raises(read.CursorMismatch):
            read.list_nodes(con, c.with_(status="dead"), limit=2, cursor=p["next_cursor"])
    w.add(E("schema.epoch_bumped", {"reason": "restore"}, origin="system", actor="system:t"))
    with w.rd() as (con, c):
        with pytest.raises(read.EpochChanged):
            read.list_nodes(con, c, limit=2, cursor=p["next_cursor"])
        assert read.envelope(con, c, {})["epoch"] == 2


def test_read_timeout_and_not_ready(w, kb_home):
    from kb.read.ctx import rows
    with w.rd(deadline_s=0.05) as (con, c):
        with pytest.raises(read.ReadTimeout):
            rows(con, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<50000000) SELECT count(*) FROM c")
    with pytest.raises(read.NotReady):
        with read.reading(read.ReadCtx()):
            pass


def test_kb_get_cli(w, capsys):
    w.add(entity("e:tool:a", "A"), snap(), claim("c-1", "e:tool:a", "a는 위젯을 지원한다"),
          E("edge.put", {"id": "r-aa", "src": "e:tool:a", "rtype": "USES", "dst": "e:tool:a"}))
    db = str(w.path)
    assert main(["get", "e:tool:a", "--db", db, "--json"]) == 0
    env = json.loads(capsys.readouterr().out)
    assert env["data"]["id"] == "e:tool:a" and [c["id"] for c in env["data"]["claims"]] == ["c-1"] and env["data"]["edges"]["out"][0]["id"] == "r-aa"
    assert main(["get", "r-aa", "--db", db, "--json"]) == 0 and json.loads(capsys.readouterr().out)["data"]["rtype"] == "USES"
    assert main(["get", "e:tool:a", "--db", db, "--json", "--include", "backlinks"]) == 0
    assert "claims" not in json.loads(capsys.readouterr().out)["data"]
    assert main(["get", "nope", "--db", db, "--json"]) == 1
    err = json.loads(capsys.readouterr().err)
    assert (err["status"], err["code"]) == (404, "not_found")
    assert main(["get", "e:tool:a", "--db", db, "--json", "--include", "zzz"]) == 2
    assert json.loads(capsys.readouterr().err)["param"] == "include"
    assert main(["get", "c-1", "--db", db, "--cards"]) == 0
    assert capsys.readouterr().out.startswith("#kb v1 seq=")
    assert main(["get", "e:tool:a", "--db", db, "--as-of-observed", "2000-01-01"]) == 1
