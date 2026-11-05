"""__new__ 주어: 임시 엔티티, 문단에 있는 별칭만 등록, 5단계 대조, G 단위 R_LIVENESS_UNKNOWN, 같은 키 재사용."""
from kb.core import ids
from kb.extract import runner, settings
from kb.parse.model import slugify

from . import helpers as H

TXT = "# 새도구 소개\n\n새도구는 2026년 9월에 공개된 코드 저장소이며 NewT라는 약칭으로도 불린다고 문서가 밝힌다.\n\n새도구는 라이선스를 MIT로 둔다고 문서가 밝힌다.\n"
Q1 = "새도구는 2026년 9월에 공개된 코드 저장소이며"
Q2 = "새도구는 라이선스를 MIT로 둔다고 문서가 밝힌다"


def _resp(typ, aliases, labels=("새도구", "새도구")):
    def f(job):
        out = []
        for q, lab in zip((Q1, Q2), labels):
            if q in job.window.text:
                out.append(H.claim_obj("__new__", q, q + ".", subject_new={"label": lab, "type": typ, "aliases": aliases}))
        return {"claims": out}
    return f


def _run(resp):
    f = H.Fake("anthropic_api", True, resp)
    with settings.override(**{"openrouter.enabled": False}):
        return runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)


def _node(eid):
    con = H.gold()
    try:
        n = con.execute("SELECT type, status, props, liveness FROM node WHERE id=? AND expired_at IS NULL", (eid,)).fetchone()
        al = [r[0] for r in con.execute("SELECT norm FROM alias WHERE node_id=?", (eid,))]
        return n, al
    finally:
        con.close()


def test_provisional_entity_and_only_present_aliases(env):
    H.ingest_doc(text=TXT, domain=("A",))
    out = _run(_resp("Platform", ["새도구", "NewT", "문단에 없는 별칭"]))
    eid = ids.entity_id("Platform", slugify("새도구"))
    n, al = _node(eid)
    assert n is not None and n[0] == "Platform" and n[1] == "active" and b'provisional' in bytes(n[2])
    assert "새도구" in al and "newt" in al and not any("문단에 없는" in a for a in al)
    assert out["claims"] == 2


def test_same_key_reused(env):
    H.ingest_doc(text=TXT, domain=("A",))
    _run(_resp("Platform", ["새도구"]))
    con = H.gold()
    try:
        subj = {r[0] for r in con.execute("SELECT c.subject FROM claim c JOIN node n ON n.vid=c.vid WHERE n.expired_at IS NULL")}
        ents = con.execute("SELECT count(*) FROM node WHERE type='Platform' AND label='새도구' AND expired_at IS NULL").fetchone()[0]
    finally:
        con.close()
    assert len(subj) == 1 and ents == 1                      # 두 주장이 같은 임시 엔티티를 쓴다


def test_context_check_5th_stage(env):
    H.ingest_doc(text=TXT, domain=("A",))
    _run(_resp("Platform", ["엉뚱이"], labels=("엉뚱이", "엉뚱이")))      # 라벨이 문단에 없다
    rows = H.claims()
    assert rows and all(r[2] == "needs_review" for r in rows)


def test_g_unit_gets_liveness_hold_and_a_to_f_does_not(env):
    H.ingest_doc(text=TXT, domain=("G",))
    _run(_resp("Repo", ["새도구"]))
    rows = H.claims()
    assert rows and all(r[2] == "needs_review" for r in rows)       # R_LIVENESS_UNKNOWN
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        live = [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind='live'")]
    finally:
        c.close()
    assert ids.entity_id("Repo", slugify("새도구")) in live


def test_a_to_f_types_not_held(env):
    H.ingest_doc(text=TXT, domain=("A",))
    _run(_resp("Platform", ["새도구"]))
    assert all(r[2] == "quote_found" for r in H.claims())
