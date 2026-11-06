"""FW5: 네 레코드 관계가 tombstone에서 닫히고 복원 판에서 다시 열린다."""
import pytest

from test_http_write import api  # noqa: F401
from test_write_core import core  # noqa: F401
from read.rhelp import E, entity, record
from kb import read
from kb.project import create_gold
from kb.project.build import replay
from kb.project.fingerprint import fingerprint_conn


@pytest.mark.parametrize("rtype", ["LINKS_TO", "PART_OF", "ABOUT", "PROMOTED_FROM"])
def test_tombstone_closes_edges_and_restore_reopens(api, rtype):
    w = api.world
    rid, target = "f-fw5-tombstone", "e:tool:fw5-target"
    links = [{"rtype": rtype, "dst": target}]
    w.add(entity(target), record(rid, "FW5 source", links=links))
    with w.rd() as (con, ctx):
        edges = read.node_edges(con, ctx, target, direction="in")[0]["items"]
        assert len(edges) == 1
    edge_id = w.gold.execute("SELECT id FROM edge WHERE src=? AND expired_at IS NULL", (rid,)).fetchone()[0]
    w.add(E("record.tombstone", {"id": rid, "reason": "synthetic delete"}, rid,
            origin="first_party", actor="user:sagae"))
    assert w.gold.execute("SELECT status FROM edge WHERE id=? AND expired_at IS NULL",
                          (edge_id,)).fetchone()[0] == "dead"
    with w.rd() as (con, ctx):
        assert read.node_edges(con, ctx, target, direction="in")[0]["items"] == []
        assert read.get_node(con, ctx, target, include="backlinks")["backlinks"] == []
        assert read.neighbors(con, ctx, target)["edges"]["rows"] == []
    w.add(record(rid, "FW5 restored", links=links))
    assert w.gold.execute("SELECT status FROM edge WHERE id=? AND expired_at IS NULL",
                          (edge_id,)).fetchone()[0] == "active"
    with w.rd() as (con, ctx):
        assert len(read.node_edges(con, ctx, target, direction="in")[0]["items"]) == 1
        if rtype == "LINKS_TO":
            assert [x["id"] for x in read.get_node(con, ctx, target, include="backlinks")["backlinks"]] == [rid]
    rebuilt = create_gold(api.home / "scratch" / "fw5-tombstone-replay.db")
    try:
        _, missing, quarantined = replay(w.led, rebuilt)
        assert not missing and not quarantined
        assert fingerprint_conn(rebuilt) == fingerprint_conn(w.gold)
    finally:
        rebuilt.close()
