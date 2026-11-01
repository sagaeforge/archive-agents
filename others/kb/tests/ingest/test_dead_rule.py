"""죽은 데이터 규칙: removed, superseded 주어의 state, howto는 기본 검색에서 제외(eff_status), event는 유지,
G 단위 entity의 liveness 누락은 E_LIVENESS_REQUIRED."""
from .conftest import capture, gold, res, run

DOC = b"""# Legacy Mode

Legacy Mode is a Claude Code feature. Legacy Mode prints a banner. Run Legacy Mode with the flag.

Legacy Mode was removed in 3.0 on 2026-03-01.
"""


def eff(cid):
    g = gold()
    try:
        return g.execute("SELECT eff_status, status FROM node WHERE id=? AND expired_at IS NULL", (cid,)).fetchone()
    finally:
        g.close()


def items(snap, state, extra_signal=None):
    live = {"state": state, "unit": "feature", "decided_by": "agent:x",
            "signals": [{"id": "M14", "snapshot": snap, "quote": "was removed in 3.0 on 2026-03-01"}]}
    if state == "superseded":
        live["successor"] = "e0"
    base = [{"item": "entity", "ref": "e0", "key": "feature:new-mode", "type": "Feature", "label": "New Mode",
             "liveness": {"state": "active", "unit": "feature", "decided_by": "agent:x",
                          "signals": [{"id": "M01", "snapshot": snap, "quote": "was removed in 3.0 on 2026-03-01"}]}},
            {"item": "entity", "ref": "e1", "key": "feature:legacy-mode", "type": "Feature", "label": "Legacy Mode", "liveness": live}]
    ev = lambda q: {"snapshot": snap, "quote": q}
    cl = lambda ref, q, st, kind, **k: {"item": "claim", "ref": ref, "subject": "e1", "statement": st, "kind": kind,
                                         "stance": "stated", "evidence": ev(q), "method": "llm", **k}
    return base + [
        cl("cs", "Legacy Mode prints a banner", "Legacy Mode prints a banner.", "state"),
        cl("ch", "Run Legacy Mode with the flag", "Legacy Mode is run with the flag.", "howto", stance="attributed", speaker="Docs"),
        cl("ce", "was removed in 3.0 on 2026-03-01", "Legacy Mode was removed in 3.0 on 2026-03-01.", "event",
           valid={"from": "2026-03-01", "precision": "day"})]


def check(state, expect_dead):
    snap = capture("https://code.claude.com/docs/en/legacy.md", DOC, source="src:cc-docs-en")
    rep = run(items(snap, state), write=True)
    assert rep.summary()["rejected"] == 0, rep.lines
    ids_ = {r: res(rep, r)["would_be"]["id"] for r in ("cs", "ch", "ce")}
    if expect_dead:
        assert eff(ids_["cs"])[0] == expect_dead and eff(ids_["ch"])[0] == expect_dead   # 기본 검색 제외
    assert eff(ids_["ce"])[0] == "active"                                                 # event는 시점을 붙여 유지
    g = gold()
    try:
        assert g.execute("SELECT status, liveness FROM node WHERE id='e:feature:legacy-mode' AND expired_at IS NULL").fetchone()[1] == state
    finally:
        g.close()
    return ids_


def test_removed_subject_state_and_howto_are_dead(env):
    check("removed", "dead")


def test_superseded_subject_state_and_howto_are_superseded(env):
    check("superseded", "superseded")
    g = gold()
    try:
        assert g.execute("SELECT src, dst FROM edge WHERE rtype='SUCCESSOR_OF' AND expired_at IS NULL").fetchall() == \
            [("e:feature:new-mode", "e:feature:legacy-mode")]
    finally:
        g.close()


def test_active_subject_stays_active(env):
    ids_ = check("active", None)
    assert eff(ids_["cs"])[0] == "active" and eff(ids_["ch"])[0] == "active"


def test_liveness_item_after_the_claims_kills_dependents(env):
    snap = capture("https://code.claude.com/docs/en/legacy.md", DOC, source="src:cc-docs-en")
    its = items(snap, "active")
    its.append({"item": "liveness", "ref": "l1", "target": "e1", "unit": "feature", "state": "removed", "decided_by": "agent:x",
                "signals": [{"id": "M14", "snapshot": snap, "quote": "was removed in 3.0 on 2026-03-01"}]})
    rep = run(its, write=True)
    assert rep.summary()["rejected"] == 0, rep.lines
    assert eff(res(rep, "cs")["would_be"]["id"])[0] == "dead" and eff(res(rep, "ch")["would_be"]["id"])[0] == "dead"
    assert eff(res(rep, "ce")["would_be"]["id"])[0] == "active"


def test_deprecated_and_partial_use_entity_liveness(env):
    snap = capture("https://code.claude.com/docs/en/legacy.md", DOC, source="src:cc-docs-en")
    its = items(snap, "active")
    for st in ("deprecated", "partial"):
        rep = run(its + [{"item": "liveness", "ref": "l1", "target": "e1", "unit": "feature", "state": st, "decided_by": "agent:x",
                          "signals": [{"id": "M09", "snapshot": snap, "quote": "was removed in 3.0 on 2026-03-01"}]}], write=True)
        assert res(rep, "l1")["result"] == "accepted", rep.lines
        g = gold()
        try:
            assert g.execute("SELECT liveness, status FROM node WHERE id='e:feature:legacy-mode' AND expired_at IS NULL").fetchone() == (st, "active")
        finally:
            g.close()


def test_g_unit_entity_without_liveness_is_rejected(env):
    for typ in ("Repo", "Package", "Feature", "Model", "Document"):
        r = run([{"item": "entity", "ref": "e1", "key": f"{typ.lower()}:x-one", "type": typ, "label": "x one"}])
        assert res(r, "e1")["code"] == "E_LIVENESS_REQUIRED", typ
    # A~F 도메인 엔티티와 G 비단위 타입은 liveness 없이 받는다
    r = run([{"item": "entity", "ref": "e1", "key": "document:yt-policy", "type": "Document", "label": "YT policy", "domain": ["A"]},
             {"item": "entity", "ref": "e2", "key": "concept:thing", "type": "Concept", "label": "thing"}])
    assert [x["result"] for x in r.lines] == ["accepted", "accepted"]


def test_g_subject_claim_without_liveness_is_held_for_review(env):
    """주어가 gold에 이미 있는 G 단위인데 생존 상태가 없으면 9단계가 R_LIVENESS_UNKNOWN으로 보류하고 queue(kind=live)에 넣는다."""
    from kb.write import commit
    from .conftest import queue_rows
    snap = capture("https://example.org/w", b"# Gadget\n\nGadget stores 5 items.\n")
    commit([{"kind": "entity.put", "actor": "t", "origin": "external", "subject": "e:repo:gadget", "idem_key": "t:e",
             "payload": {"id": "e:repo:gadget", "type": "Repo", "label": "Gadget", "domain": ["G"]}}], "t")
    from kb.write.engine import project_pending
    project_pending()
    its = [{"item": "claim", "ref": "c1", "subject": "e:repo:gadget", "statement": "Gadget stores 5 items.", "kind": "state",
            "stance": "stated", "evidence": {"snapshot": snap, "quote": "Gadget stores 5 items"}, "method": "llm"}]
    r = run(its)                                                  # validate: 큐에 넣지 않는다
    assert res(r, "c1")["result"] == "needs_review" and res(r, "c1")["code"] == "R_LIVENESS_UNKNOWN" and queue_rows("live") == []
    r = run(its, write=True)
    assert res(r, "c1")["code"] == "R_LIVENESS_UNKNOWN" and queue_rows("live") == ["e:repo:gadget"]
