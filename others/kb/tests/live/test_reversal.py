"""번복(M17): verdict만 새로 쓴다. revived 뒤 묶였던 주장이 기본 읽기로 돌아오고 이력이 남는다.
죽은 대상에 DEPENDS_ON 하는 howto 주장은 suspect + 대기열."""
from kb import read
from kb.core import ids
from kb.live import decide, effects, reviewq, rules, runner, signals as S, verdict
from kb.live.model import Decision, Item, Sig
from kb.project import current_gold_path
from kb.read import ReadCtx, reading

from .conftest import capture, commit, ev, gold, node, put_entity, source

TXT = "The widget switch is enabled in settings."


def claims_of(nid, **kw):
    ctx = ReadCtx.build(db_path=current_gold_path(), **kw)
    with reading(ctx) as con:
        return sorted(x["id"] for x in read.node_claims(con, ctx, nid)[0]["items"])


def llm_claim(subject, key, kind, snap):
    cid = ids.claim_id_llm(subject, key)
    commit([ev("claim.assert", {"id": cid, "subject": subject, "statement": key, "kind": kind, "stance": "stated", "method": "llm",
                                "verification": "quote_found", "evidence": [{"snapshot": snap, "selector_kind": "text_quote", "exact": TXT}]},
                  subject, key=f"claim:{cid}")])
    return cid


def kill(target, snap, unit="feature"):
    d = Decision(target, unit, "removed", [Sig("M12", "removed", snap, "x is no longer available")])
    con = gold()
    try:
        p = verdict.build(d, "live-rules@1", con)
    finally:
        con.close()
    verdict.write(p)


def test_revival_restores_bound_claims_and_keeps_history(env):
    source()
    put_entity("e:feature:wid", "Feature", "widget", liveness="active")
    snap = capture("https://docs.example/wid", TXT.encode())
    state = llm_claim("e:feature:wid", "widget is on", "state", snap)
    event = llm_claim("e:feature:wid", "widget shipped in 2026", "event", snap)
    assert claims_of("e:feature:wid") == sorted([state, event])
    kill("e:feature:wid", snap)
    assert claims_of("e:feature:wid") == [event]                    # state 주장이 기본 읽기에서 빠졌다
    assert node("e:feature:wid")["eff_status"] == "dead"
    # M17 번복 후보는 사람 대기열로 간다
    m17 = S.m17_reversal("## 2.1.9\n- Restored `widget`\n", "widget", snap)
    d = rules.decide("e:feature:wid", "feature", [m17], current="removed")
    assert d.liveness == "revived" and not d.auto
    rid = reviewq.open_item("e:feature:wid", "feature", d.queue[0], [Sig("M17", "revive", snap, m17.quote)])
    out = decide.decide(rid, "revived", by="user")
    assert out["status"] == "active"
    assert claims_of("e:feature:wid") == sorted([state, event])      # 복귀
    assert node("e:feature:wid")["liveness"] == "revived"
    con = gold()
    try:       # 이력 보존: 판정마다 노드 버전이 남는다
        vers = con.execute("SELECT liveness FROM node WHERE id='e:feature:wid' ORDER BY version").fetchall()
    finally:
        con.close()
    assert [v[0] for v in vers][-3:] == ["active", "removed", "revived"]
    assert reviewq.list_open() == []


def test_dead_target_marks_dependent_howto_suspect_and_queues(env):
    source()
    put_entity("e:feature:todo", "Feature", "TodoWrite", liveness="active")
    put_entity("e:technique:todo-tips", "Technique", "TodoWrite 활용", liveness="active")
    snap = capture("https://docs.example/todo", TXT.encode())
    how = llm_claim("e:technique:todo-tips", "TodoWrite로 작업을 쪼갠다", "howto", snap)
    eid = ids.edge_id("e:technique:todo-tips", "DEPENDS_ON", "e:feature:todo")
    commit([ev("edge.put", {"id": eid, "src": "e:technique:todo-tips", "rtype": "DEPENDS_ON", "dst": "e:feature:todo"}, "e:technique:todo-tips")])
    kill("e:feature:todo", snap)
    con = gold()
    try:
        assert effects.dependents(con, "e:feature:todo") == [how]
        got = effects.propagate_dead("e:feature:todo", con, snapshot_sig=Sig("M12", "removed", snap))
    finally:
        con.close()
    assert got == [how]
    assert node(how)["verification"] == "needs_review"
    items = reviewq.list_open()
    assert len(items) == 1 and items[0]["target"] == how and items[0]["question"].startswith("H05")
