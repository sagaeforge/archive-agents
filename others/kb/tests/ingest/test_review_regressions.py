"""리드 검토 재현 사례: 유령 엔티티, 멱등 충돌로 잃는 쓰기, 기존 주장의 엣지, 판정 일치."""
import pytest

from kb.core import ledger

from .conftest import capture, event_count, gold, res, run

DOC = b"""# Tools

Gadget Engine stores 5 widgets per page. Gadget Engine ships 3 modes by default.
"""
ENT = {"item": "entity", "ref": "e1", "key": "concept:gadget-engine", "type": "Concept", "label": "Gadget Engine"}
OTHER = {"item": "entity", "ref": "e2", "key": "concept:orbit-cache", "type": "Concept", "label": "Orbit Cache"}


@pytest.fixture
def snap(env):
    return capture("https://example.org/gadget", DOC)


def new_claim(snap, ref, quote, statement):
    return {"item": "claim", "ref": ref, "subject": "__new__", "subject_new": {"label": "Gadget Engine", "type": "Concept"},
            "statement": statement, "kind": "state", "stance": "stated", "method": "llm",
            "evidence": {"snapshot": snap, "quote": quote}}


def plain(snap, ref="c1", subject="e1", **kw):
    return {"item": "claim", "ref": ref, "subject": subject, "statement": "Gadget Engine stores 5 widgets per page.",
            "kind": "state", "stance": "stated", "method": "llm",
            "evidence": {"snapshot": snap, "quote": "stores 5 widgets per page"}, **kw}


def kinds():
    led = ledger.open_ledger()
    try:
        return [r[0] for r in led.execute("SELECT kind FROM event ORDER BY seq")]
    finally:
        led.close()


def node(nid):
    g = gold()
    try:
        return g.execute("SELECT type, liveness, status FROM node WHERE id=? AND expired_at IS NULL", (nid,)).fetchone()
    finally:
        g.close()


def edges(rtype):
    g = gold()
    try:
        return g.execute("SELECT src, dst FROM edge WHERE rtype=? AND expired_at IS NULL", (rtype,)).fetchall()
    finally:
        g.close()


@pytest.mark.parametrize("write", [False, True])
def test_rejected_claim_leaves_no_ghost_subject(snap, write):
    rep = run([new_claim(snap, "c1", "this quote is not in the document", "Gadget Engine has no such text."),
               new_claim(snap, "c2", "stores 5 widgets per page", "Gadget Engine stores 5 widgets per page.")], write=write)
    assert res(rep, "c1")["code"] == "E_QUOTE_NOT_FOUND" and res(rep, "c2")["result"] == "accepted"
    if write:
        assert kinds().count("entity.put") == 1 and kinds().count("claim.assert") == 1
        assert node("e:concept:gadget-engine") is not None


def test_claim_rejected_by_bad_depends_on_leaves_no_ghost(snap):
    c1 = dict(new_claim(snap, "c1", "stores 5 widgets per page", "Gadget Engine stores 5 widgets per page."),
              depends_on=["e:concept:missing"])
    rep = run([c1, new_claim(snap, "c2", "ships 3 modes by default", "Gadget Engine ships 3 modes by default.")], write=True)
    assert res(rep, "c1")["code"] == "E_REF" and res(rep, "c2")["result"] == "accepted"
    assert kinds().count("entity.put") == 1 and node("e:concept:gadget-engine") is not None


def test_commit_rejection_rolls_back_batch_state(snap, monkeypatch):
    from kb import write
    from kb.write.errors import WriteRejected
    real, calls = write.commit, []

    def flaky(events, *a, **k):
        if any(e["kind"] == "claim.assert" for e in events) and not calls:
            calls.append(1)
            raise WriteRejected("schema_invalid", "시험")
        return real(events, *a, **k)
    monkeypatch.setattr(write, "commit", flaky)
    rep = run([new_claim(snap, "c1", "stores 5 widgets per page", "Gadget Engine stores 5 widgets per page."),
               new_claim(snap, "c2", "ships 3 modes by default", "Gadget Engine ships 3 modes by default.")], write=True)
    assert res(rep, "c1")["result"] == "rejected" and res(rep, "c2")["result"] == "accepted"
    assert kinds().count("entity.put") == 1 and node("e:concept:gadget-engine") is not None


def series(snap):
    return {"item": "series", "ref": "s1", "key": "s:chart", "metric": "chart_rank", "unit": "rank", "snapshot": snap,
            "parser": "kworb@1", "points": [{"period": "2026-10-01", "value": 1}]}


def test_series_points_survive_define_conflict(snap):
    run([series(snap)], write=True, producer="agent:a", batch="s-a")
    item = dict(series(snap), points=[{"period": "2026-10-02", "value": 2}])
    rep = run([item], write=True, producer="agent:b", batch="s-b")          # 같은 정의, 다른 actor
    assert res(rep, "s1")["result"] == "accepted" and rep.new_events == 1
    assert kinds().count("series.batch") == 2 and kinds().count("series.define") == 1
    g = gold()
    try:
        assert g.execute("SELECT count(*) FROM series_obs WHERE series_id='s:chart'").fetchone()[0] == 2
    finally:
        g.close()


def test_series_replay_by_other_actor_writes_nothing(snap):
    run([series(snap)], write=True, producer="agent:a", batch="s-a")
    n = event_count()
    rep = run([series(snap)], write=True, producer="agent:b", batch="s-b")
    assert res(rep, "s1")["result"] == "accepted" and res(rep, "s1")["would_be"]["existing"]
    assert rep.new_events == 0 and event_count() == n


def test_existing_claim_gets_answers_and_depends_edges(snap):
    run([ENT, plain(snap)], write=True, batch="b1")
    rep = run([ENT, OTHER, plain(snap, depends_on=["e2"])], write=True, batch="b2", ticket="t-abc123")
    r = res(rep, "c1")
    assert r["result"] == "accepted" and r["would_be"]["existing"] and kinds().count("claim.assert") == 1
    cid = r["would_be"]["id"]
    assert edges("ANSWERS") == [(cid, "t-abc123")]
    assert edges("DEPENDS_ON") == [(cid, "e:concept:orbit-cache")]
    n = event_count()
    assert run([ENT, OTHER, plain(snap, depends_on=["e2"])], write=True, batch="b2", ticket="t-abc123").new_events == 0
    assert event_count() == n


def test_second_batch_for_same_ticket_keeps_other_edges(snap):
    run([ENT, OTHER, plain(snap)], write=True, batch="b1", ticket="t-abc123")
    rep = run([ENT, OTHER, plain(snap, depends_on=["e2"])], write=True, batch="b2", ticket="t-abc123")
    assert res(rep, "c1")["result"] == "accepted" and len(edges("DEPENDS_ON")) == 1 and len(edges("ANSWERS")) == 1


def test_object_ref_is_resolved(snap):
    rep = run([ENT, OTHER, plain(snap, object="e2", predicate="depends_on")], write=True)
    assert res(rep, "c1")["result"] != "rejected"
    led = ledger.open_ledger()
    try:
        import json
        p = json.loads(led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha "
                                "WHERE e.kind='claim.assert'").fetchone()[0])
    finally:
        led.close()
    assert p["object"] == "e:concept:orbit-cache"


def test_user_edge_without_evidence_is_held_in_both_paths(snap):
    items = [ENT, OTHER, {"item": "edge", "ref": "x1", "src": "e1", "dst": "e2", "rtype": "USES"}]
    v = run(items, producer="user:sagae")
    s = run(items, producer="user:sagae", write=True)
    assert res(v, "x1")["result"] == res(s, "x1")["result"] == "held"
    assert res(s, "x1")["code"] == "H_FP_CLOSED"


def test_record_conflict_is_a_row_not_a_crash(snap):
    rec = {"item": "record", "ref": "r1", "title": "메모", "body": "본문", "sensitivity": "internal"}
    run([rec], write=True, producer="user:sagae")
    rep = run([dict(rec, body="고친 본문"), ENT], write=True, producer="user:sagae")
    assert res(rep, "r1")["result"] == "rejected" and res(rep, "e1")["result"] == "accepted"
    assert rep.summary()["rejected"] == 1


def test_entity_r6_props_rejected_alike_and_no_ghost(snap):
    bad = dict(ENT, props={"opportunity_score": 9})
    claim = plain(snap)
    v = run([bad, claim])
    s = run([bad, claim], write=True)
    assert res(v, "e1")["code"] == res(s, "e1")["code"] == "E_R6_SCORE"
    assert res(v, "c1")["code"] == res(s, "c1")["code"] == "E_REF"
    assert "entity.put" not in kinds()


@pytest.mark.parametrize("state", ["deprecated", "partial"])
def test_liveness_states_use_survival_verdict(env, state):
    url = "https://docs.example.org/widget"
    s = capture(url, b"# Widget\n\nWidget status text for the toolkit page.\n")
    ent = dict(ENT, props={})
    live = {"item": "liveness", "ref": "l1", "target": "e1", "unit": "concept", "state": state, "decided_by": "agent:x",
            "signals": [{"id": "M05", "snapshot": s}]}
    from kb.ingest.process import Processor
    import kb.ingest.process as proc
    orig = Processor._mk_snap

    def primary(self, sid, props):                       # 시험 레지스트리 없이 1차 출처로 둔다
        info = orig(self, sid, props)
        info.trust = "primary"
        return info
    proc.Processor._mk_snap = primary
    try:
        rep = run([ent, live], write=True, domain=("E",))
    finally:
        proc.Processor._mk_snap = orig
    assert res(rep, "l1")["result"] == "accepted", rep.lines
    assert res(rep, "l1")["would_be"]["status"] == "active"
    assert "survival.verdict" in kinds()
    assert tuple(node("e:concept:gadget-engine"))[1:] == (state, "active")
