"""사실 투영 엣지, SUCCESSOR_OF, 엣지 민감도, 병합 끝, 민감도 상향의 sub=1 행."""
from kb.core import ids, ledger
from kb.project import project_tail
from projhelp import E, claim, entity, new_gold, snap_events


def run(led, kb_home, evs, name="fe"):
    ledger.append(led, evs)
    g = new_gold(kb_home, name)
    r = project_tail(led, g, None, 10 ** 6)
    assert r.caught_up and not r.quarantined
    return g


def rec(rid, sens, links=None, title="기록"):
    p = {"id": rid, "type": "Note", "title": title, "body": "본문 " + rid, "sensitivity": ["public", "internal", "private", "secret"][sens]}
    if links:
        p["links"] = links
    return E("record.put", p, rid, origin="first_party", actor="user:sagae")


def test_fact_edge_points_at_evidence_claim(led, kb_home):
    g = run(led, kb_home, [entity("e:tool:a"), entity("e:tool:b"), *snap_events(),
                           claim("c-obj", "e:tool:a", "a는 b에 의존한다", "state", predicate="depends_on", object="e:tool:b")])
    row = g.execute("SELECT src, rtype, dst, claim_id, props, status FROM edge WHERE claim_id='c-obj'").fetchone()
    assert row[:4] == ("e:tool:a", "depends_on", "e:tool:b", "c-obj") and b'"claim":"c-obj"' in row[4] and row[5] == "active"
    assert g.execute("SELECT id FROM edge WHERE claim_id='c-obj'").fetchone()[0] == ids.edge_id("e:tool:a", "depends_on", "e:tool:b", {"claim": "c-obj"})
    # 철회하면 엣지 상태가 따라간다
    ledger.append(led, [E("claim.withdraw", {"id": "c-obj", "reason": "사라짐"}, "c-obj")])
    project_tail(led, g, None, 10 ** 6)
    assert g.execute("SELECT status FROM edge WHERE claim_id='c-obj' AND expired_at IS NULL").fetchone()[0] == "superseded"


def test_successor_of_and_edge_sensitivity_max(led, kb_home):
    g = run(led, kb_home, [
        entity("e:tool:old"), entity("e:tool:new"),
        E("survival.verdict", {"target": "e:tool:old", "unit": "tool", "liveness": "superseded", "status": "superseded",
                               "signals": [{"id": "M01"}], "successor": "e:tool:new", "decided_by": "a"}, "e:tool:old"),
        rec("f-pub", 0), rec("f-sec", 3, links=[{"rtype": "LINKS_TO", "dst": "e:tool:new"}]),
        rec("f-int", 1, links=[{"rtype": "LINKS_TO", "dst": "f-pub"}]),
        E("edge.put", {"id": "r-x", "src": "f-pub", "rtype": "USES", "dst": "e:tool:new", "sensitivity": "private"}, "r-x"),
    ])
    assert g.execute("SELECT src,dst FROM edge WHERE rtype='SUCCESSOR_OF'").fetchall() == [("e:tool:new", "e:tool:old")]
    sens = {r[0]: r[1] for r in g.execute("SELECT dst, sensitivity FROM edge WHERE rtype='LINKS_TO'")}
    assert sens == {"e:tool:new": 3, "f-pub": 1}, "양끝 노드의 최댓값"
    assert g.execute("SELECT sensitivity FROM edge WHERE id='r-x'").fetchone()[0] == 2, "명시 민감도"
    assert g.execute("SELECT sensitivity FROM head WHERE id='r-x'").fetchone()[0] == 2


def test_merge_chain_final(led, kb_home):
    g = run(led, kb_home, [entity("e:tool:a"), entity("e:tool:b"), entity("e:tool:c"),
                           E("entity.merge", {"from": "e:tool:b", "into": "e:tool:c"}),
                           E("entity.merge", {"from": "e:tool:a", "into": "e:tool:b"})])
    fin = dict(g.execute("SELECT id, merged_into_final FROM head WHERE kind='node'").fetchall())
    assert fin["e:tool:a"] == "e:tool:c" and fin["e:tool:b"] == "e:tool:c" and fin["e:tool:c"] is None
    # 반대 순서: 먼저 a->b, 그 뒤 b->c 이면 a의 끝도 c로 옮겨 간다
    g2 = run(led, kb_home, [entity("e:tool:p"), entity("e:tool:q"), entity("e:tool:r"),
                            E("entity.merge", {"from": "e:tool:p", "into": "e:tool:q"}),
                            E("entity.merge", {"from": "e:tool:q", "into": "e:tool:r"})], "fe2")
    fin2 = dict(g2.execute("SELECT id, merged_into_final FROM head WHERE kind='node'").fetchall())
    assert fin2["e:tool:p"] == "e:tool:r" and fin2["e:tool:q"] == "e:tool:r"


def test_sensitivity_raise_writes_sub1_row_without_key_clash(led, kb_home):
    g = run(led, kb_home, [rec("f-a", 1, links=[{"rtype": "LINKS_TO", "dst": "e:tool:z"}, {"rtype": "MENTIONS", "dst": "e:tool:z"}]),
                           entity("e:tool:z")])
    ledger.append(led, [E("record.put", {"id": "f-a", "type": "Note", "title": "기록", "body": "비밀", "sensitivity": "secret",
                                     "links": [{"rtype": "LINKS_TO", "dst": "e:tool:z"}, {"rtype": "MENTIONS", "dst": "e:tool:z"}]}, "f-a",
                         origin="first_party", actor="user:sagae")])
    project_tail(led, g, None, 10 ** 6)
    seq = g.execute("SELECT max(seq) FROM change WHERE sub=0").fetchone()[0]
    rows = g.execute("SELECT sub, kind, id, sensitivity FROM change WHERE seq=? ORDER BY sub", (seq,)).fetchall()
    assert rows[0][:3] == (0, "record.put", "f-a") and rows[0][3] == 3
    revoked = [r for r in rows if r[1] == "visibility.revoked"]
    assert revoked[0][0] == 1 and revoked[0][2] == "f-a" and all(r[3] == 0 for r in revoked)
    assert {r[2] for r in revoked} >= {"f-a"} and len(rows) == len({r[0] for r in rows})
    assert g.execute("SELECT sensitivity FROM head WHERE id='f-a'").fetchone()[0] == 3
    # 링크 엣지의 민감도도 따라 올랐고 해당 엣지가 폐기 행에 있다
    assert {r[0] for r in g.execute("SELECT sensitivity FROM edge WHERE src='f-a' AND expired_at IS NULL")} == {3}
    assert len(revoked) == 3
