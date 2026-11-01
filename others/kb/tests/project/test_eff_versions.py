"""생존 판정의 eff_status 새 버전(ADR 7.2): FTS는 그대로, span만 닫고 연다."""
from kb.core import ledger
from projhelp import E, claim, entity, new_gold, snap_events
from kb.project import project_tail


def _verdict(target, status, liveness, at=None, **kw):
    p = {"target": target, "unit": "tool", "liveness": liveness, "status": status, "signals": [{"id": "M05"}],
         "decided_by": "agent:t"}
    p.update(kw)
    return E("survival.verdict", p, target, **({"at": at} if at else {}))


def _setup(led, kb_home):
    ledger.append(led, [entity("e:tool:x"), *snap_events(),
                        claim("c-state", "e:tool:x", "x는 위젯을 지원한다", "state"),
                        claim("c-how", "e:tool:x", "x에서 위젯을 켜는 방법은 설정이다", "howto"),
                        claim("c-ev", "e:tool:x", "x는 2026년에 출시됐다", "event", valid={"from": "2026-01-01"})])
    g = new_gold(kb_home, "eff")
    assert project_tail(led, g, None, 10 ** 6).caught_up
    return g


def _cur(g, cid):
    return g.execute("SELECT version, eff_status, status FROM node WHERE id=? AND expired_at IS NULL", (cid,)).fetchone()


def test_dead_verdict_versions_state_claims_without_touching_fts(led, kb_home):
    g = _setup(led, kb_home)
    fts_before = g.execute("SELECT count(*) FROM unit").fetchone()[0], [r[0] for r in g.execute("SELECT rowid FROM fts ORDER BY rowid")]
    spans_before = g.execute("SELECT count(*) FROM span").fetchone()[0]
    ledger.append(led, [_verdict("e:tool:x", "dead", "removed")])
    r = project_tail(led, g, None, 10 ** 6)
    assert r.caught_up
    assert _cur(g, "c-state") == (2, "dead", "active") and _cur(g, "c-how") == (2, "dead", "active")
    assert _cur(g, "c-ev") == (1, "active", "active"), "event는 영향이 없다"
    # 새 span이 열렸고 옛 span은 닫혔다. unit과 FTS는 그대로
    assert g.execute("SELECT count(*) FROM span").fetchone()[0] == spans_before + 3  # 대상 노드 label + 주장 2
    assert g.execute("SELECT eff_status FROM span WHERE ref_id='c-state' AND rec_to IS NULL").fetchall() == [("dead",)]
    assert g.execute("SELECT count(*) FROM span WHERE ref_id='c-state' AND rec_to IS NOT NULL").fetchone()[0] == 1
    assert (g.execute("SELECT count(*) FROM unit").fetchone()[0], [r[0] for r in g.execute("SELECT rowid FROM fts ORDER BY rowid")]) == fts_before
    # as-of: 판정 시각 앞에는 active
    at = g.execute("SELECT rec_to FROM span WHERE ref_id='c-state' AND rec_to IS NOT NULL").fetchone()[0]
    old = g.execute("SELECT eff_status FROM span WHERE ref_id='c-state' AND rec_from<=? AND (rec_to IS NULL OR rec_to>?) ORDER BY sid",
                    (at - 1, at - 1)).fetchall()
    assert old == [("active",)]
    # 판정 이벤트의 원장 행에는 주장 복사본이 없다
    assert not [e for e in ledger.iter_events(led, 0, 100) if e["kind"] == "claim.assert" and e["payload"].get("eff_status")]


def test_superseded_successor_and_revived(led, kb_home):
    g = _setup(led, kb_home)
    ledger.append(led, [entity("e:tool:y"), _verdict("e:tool:x", "superseded", "superseded", successor="e:tool:y")])
    project_tail(led, g, None, 10 ** 6)
    assert _cur(g, "c-state")[1] == "superseded"
    e = g.execute("SELECT src, dst, rtype FROM edge WHERE rtype='SUCCESSOR_OF' AND expired_at IS NULL").fetchall()
    assert e == [("e:tool:y", "e:tool:x", "SUCCESSOR_OF")]
    ledger.append(led, [_verdict("e:tool:x", "active", "revived")])
    project_tail(led, g, None, 10 ** 6)
    assert _cur(g, "c-state") == (3, "active", "active") and _cur(g, "c-how")[1] == "active"
    assert g.execute("SELECT eff_status FROM span WHERE ref_id='c-state' AND rec_to IS NULL").fetchall() == [("active",)]


def test_merged_subject_is_excluded(led, kb_home):
    ledger.append(led, [entity("e:tool:old"), entity("e:tool:new"), *snap_events(),
                        claim("c-m", "e:tool:old", "old는 위젯을 지원한다", "state"),
                        E("entity.merge", {"from": "e:tool:old", "into": "e:tool:new"})])
    g = new_gold(kb_home, "mg")
    project_tail(led, g, None, 10 ** 6)
    ledger.append(led, [_verdict("e:tool:old", "superseded", "superseded", successor="e:tool:new")])
    project_tail(led, g, None, 10 ** 6)
    assert _cur(g, "c-m") == (1, "active", "active"), "병합으로 superseded가 된 주어의 주장은 묶이지 않는다"
    assert g.execute("SELECT eff_status, merged_into FROM node WHERE id='e:tool:old' AND expired_at IS NULL").fetchone() == ("superseded", "e:tool:new")
