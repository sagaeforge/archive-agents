"""Codex 교차 검토 8건의 재현 시험. 실제 외부 호출 0. 각 시험은 수정 전에 실패해야 한다."""
import json

import pytest

from kb.core import opsdb
from kb.extract import budget, guard, route, runner, settings, state, support, windows
from kb.extract.backends.openrouter import OpenRouter
from kb.extract.types import Job, Window

from . import helpers as H

PRIV = "내부코드명-비공개-라벨"


def _fp_open(monkeypatch):
    import kb.write.engine as eng
    import kb.write.fpgate as fp
    monkeypatch.setattr(fp, "is_open", lambda: True)
    monkeypatch.setattr(eng, "fp_is_open", lambda led: True)


def _proc():
    from kb.ingest.process import Processor
    return Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=False)


# ---------------------------------------------------------------- 1) 후보 라벨
def test_item1_first_party_subject_label_not_in_candidates(ent, monkeypatch):
    from kb.write import commit
    from kb.write.engine import project_pending
    _fp_open(monkeypatch)
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert H.claims()                                                   # 외부 주장 span이 주어 ent를 가리킨다
    commit([{"kind": "entity.put", "actor": "user:sagae", "origin": "first_party", "subject": ent, "idem_key": "t:fp-ent",
             "payload": {"id": ent, "type": "Tool", "label": PRIV, "domain": ["G"], "aliases": ["sampletool"]}}], "user:sagae")
    project_pending()
    con = H.gold()
    try:
        row = con.execute("SELECT origin, label FROM node WHERE id=? AND expired_at IS NULL", (ent,)).fetchone()
    finally:
        con.close()
    assert row[0] == "first_party" and row[1] == PRIV
    proc = _proc()
    try:
        got = windows.candidates_for(proc, "하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다")
    finally:
        proc.gold.close()
    assert PRIV not in json.dumps(got, ensure_ascii=False)


# ---------------------------------------------------------------- 2) first_party snapshot.text가 외부 스냅샷 본문을 바꾼다
def _replace_text_first_party(sid, text):
    from kb.core import cas
    from kb.parse import paragraphs as pg
    from kb.write import commit
    from kb.write.engine import project_pending
    cas.put(text.encode("utf-8"))
    paras_sha = pg.store(pg.paragraphs(text, "markdown"))
    from kb.core.canon import sha256_hex
    commit([{"kind": "snapshot.text", "actor": "user:sagae", "origin": "first_party", "subject": sid, "idem_key": f"fp-text:{sid}",
             "payload": {"snapshot": sid, "text_sha": sha256_hex(text.encode("utf-8")), "text_format": "markdown",
                         "extractor": "fp", "paras_sha": paras_sha}}], "user:sagae")
    project_pending()


def test_item2_first_party_text_replacement_blocks_external_send(ent, monkeypatch):
    _fp_open(monkeypatch)
    sid = H.ingest_doc(enqueue=False)
    _replace_text_first_party(sid, "# 내부 메모\n\n샘플도구는 내부 목표 처리량을 하루 500건으로 정했다고 메모에 적혀 있다.\n")
    from kb.extract import tick_stage
    tick_stage.enqueue_new()
    c = opsdb.connect()
    try:
        c.execute("DELETE FROM queue WHERE kind='l2'")
    finally:
        c.close()
    # 큐에 직접 넣는다: 새 본문의 문단
    proc = _proc()
    try:
        info = proc.text_of(proc.snapshot_info(sid))
        c = opsdb.connect()
        for p in info.paras:
            opsdb.queue_put(c, "l2", windows.ref_of(sid, p.para_sha, p.start_cp), domain="G")
        c.close()
    finally:
        proc.gold.close()
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert f.calls == [] and out["windows"] == 0 and out["guarded"] >= 1


def test_item2_shared_body_with_first_party_snapshot_blocks_send(ent, monkeypatch):
    """같은 본문 객체를 first_party 스냅샷이 공유하면 외부 스냅샷이라도 본문 출처가 외부만이 아니다."""
    from kb.core import cas, ids
    from kb.write import commit
    from kb.write.engine import project_pending
    _fp_open(monkeypatch)
    sid = H.ingest_doc(enqueue=False)
    con = H.gold()
    try:
        tsha = con.execute("SELECT json_extract(CAST(props AS TEXT),'$.text_sha') FROM node WHERE id=? AND expired_at IS NULL", (sid,)).fetchone()[0]
        paras_sha = con.execute("SELECT json_extract(CAST(props AS TEXT),'$.paras_sha') FROM node WHERE id=? AND expired_at IS NULL", (sid,)).fetchone()[0]
    finally:
        con.close()
    body = b"private raw"
    raw = cas.put(body)
    url = "https://fp.test/own"
    fid = ids.snapshot_id(raw, url)
    commit([{"kind": "snapshot.captured", "actor": "user:sagae", "origin": "first_party", "idem_key": f"snapshot:{fid}", "subject": fid,
             "payload": {"id": fid, "document_id": ids.document_id(url), "source": "src:adhoc", "url": url, "raw_sha": raw,
                         "content_type": "text/markdown", "bytes": len(body), "fetched_at": 1_793_000_000_000, "domain": ["G"], "tier": "objects"}}],
           "user:sagae")
    commit([{"kind": "snapshot.text", "actor": "user:sagae", "origin": "first_party", "subject": fid, "idem_key": f"fp-text:{fid}",
             "payload": {"snapshot": fid, "text_sha": tsha, "text_format": "markdown", "extractor": "fp", "paras_sha": paras_sha}}],
           "user:sagae")
    project_pending()
    got = guard.inspect_snapshot(sid, "x")
    assert got["origin"] != "external"


# ---------------------------------------------------------------- 3) 함의 판정과 교차 확인의 주장 문장
def _fp_claim(ent, monkeypatch):
    """공개 근거(외부 스냅샷)를 인용하는 sensitivity 0의 first_party 주장 하나를 만든다. 반환: 주장 ID."""
    from kb.write import commit
    from kb.write.engine import project_pending
    _fp_open(monkeypatch)
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"claude": f}, do_support=False)
    ev = [e for e in H.events("claim.assert")][0]
    p = dict(ev)
    p["id"] = "c-fp-private-claim"
    p["statement"] = "비공개 내부 판단: 샘플도구 도입을 보류한다."
    p["verification"] = "needs_review"
    commit([{"kind": "claim.assert", "actor": "user:sagae", "origin": "first_party", "subject": ev["subject"], "idem_key": "t:fp-claim",
             "payload": p}], "user:sagae")
    project_pending()
    return p["id"]


def test_item3_first_party_claim_statement_not_sent_by_support(ent, monkeypatch):
    cid = _fp_claim(ent, monkeypatch)
    con = H.gold()
    try:
        row = con.execute("SELECT origin, sensitivity FROM node WHERE id=? AND expired_at IS NULL", (cid,)).fetchone()
    finally:
        con.close()
    assert row == ("first_party", 0), row
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, support.QUEUE, cid)
    finally:
        c.close()
    f = H.Fake("claude", True, lambda job: {"supported": True})
    with settings.override(**{"openrouter.enabled": False}):
        out = support.run_queue({"claude": f}, route.Router({"claude": f}))
    assert f.calls == [], [j.user for j in f.calls]


def test_item3_first_party_claim_statement_not_sent_by_cross_check(ent, monkeypatch):
    _fp_claim(ent, monkeypatch)
    f = H.Fake("claude", True, lambda job: {"supported": True})
    with settings.override(**{"openrouter.enabled": False}):
        out = support.cross_check({"claude": f}, route.Router({"claude": f}))
    assert not any("비공개 내부 판단" in j.user for j in f.calls), [j.user for j in f.calls]


def test_item3_denied_claim_does_not_end_cross_sampling(ent, monkeypatch):
    """가드가 거부한 주장 하나가 표본 감사 전체를 끝내지 않는다."""
    cid = _fp_claim(ent, monkeypatch)
    f = H.Fake("claude", True, lambda job: {"supported": True})
    with settings.override(**{"openrouter.enabled": False}):
        out = support.cross_check({"claude": f}, route.Router({"claude": f}))
    assert out["sampled"] >= 1 and cid        # 외부 주장 하나는 표본이 된다


def test_item3_judge_guard_covers_statement_without_selection_filter(ent, monkeypatch):
    """선택 단계가 아니라 judge() 자체가 주장 문장의 출처를 검사한다."""
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    cid = _fp_claim(ent, monkeypatch)
    con = connect_ro(current_gold_path(), 30.0)
    try:
        cl = support._claim(con, cid)
    finally:
        con.close()
    cl["origin"] = "external"
    f = H.Fake("claude", True, lambda job: {"supported": True})
    with settings.override(**{"openrouter.enabled": False}):
        j = support.judge(cl, {"claude": f}, route.Router({"claude": f}))
    assert f.calls == [] and not j["ok"] and j["reason"].startswith("guard:")


# ---------------------------------------------------------------- 4) 검사 시점과 gold 연결
def test_item4_restriction_applied_during_preflight_is_honored(ent, monkeypatch):
    """느린 preflight 중에 본문이 first_party로 바뀌면, 전송 직전의 새 검사가 이를 잡는다."""
    _fp_open(monkeypatch)
    sid = H.ingest_doc()

    class Slow(H.Fake):
        def preflight(self):
            _replace_text_first_party(sid, "# 내부 메모\n\n샘플도구는 내부 목표 처리량을 하루 500건으로 정했다고 메모에 적혀 있다.\n")
            return super().preflight()
    f = Slow("claude", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False)
    assert f.calls == [], [j.user for j in f.calls]
    assert out["windows"] == 0


def test_item4_gold_conn_reopens_after_symlink_swap(ent):
    from kb.ingest.store import Gold
    from kb.core import ledger
    from kb.project import rebuild
    g = Gold()
    try:
        c1 = g.conn()
        H.put_entity("e:tool:later", "나중도구", aliases=["나중도구"])
        led = ledger.open_ledger()
        try:
            rebuild(led=led)
        finally:
            led.close()
        c2 = g.conn()
        assert c2.execute("SELECT 1 FROM node WHERE id='e:tool:later' AND expired_at IS NULL").fetchone() is not None
        assert c1 is not c2
    finally:
        g.close()


# ---------------------------------------------------------------- 5) 비용을 모르는 실패는 예약액을 청구한다
@pytest.fixture
def orsrv(envk, ent):
    srv = H.OrServer(responder=lambda b: {"claims": []})
    with settings.override(**{"openrouter.base_url": srv.url, "claude.daily_windows": 0, "codex.enabled": False,
                              "openrouter.timeout_s": 0.4, "openrouter.extract_fallback_model": "openai/gpt-6.1-sol"}):
        budget.set_balance(100.0)
        yield srv
    srv.close()


def _fail_cases():
    return ["timeout", "bad_body", "http500"]


@pytest.mark.parametrize("case", _fail_cases())
def test_item5_unknown_cost_failure_charges_reservation(orsrv, case):
    H.ingest_doc()
    if case == "timeout":
        orsrv.delay = 1.5
    elif case == "bad_body":
        orsrv.raw = b"<html>not json"
    else:
        orsrv.status = 500
    runner.run_agent("public", backends={"openrouter": OpenRouter()}, do_support=False)
    assert len(orsrv.posts) >= 1
    d = budget.day()
    assert d["reserved"] == 0.0
    assert d["spent"] >= 0.05, d                    # 0.0이면 유료 실패가 장부에 없다
    orsrv.delay = 0.0


def test_item5_no_request_sent_costs_nothing(envk, ent):
    """키가 없어 요청 자체가 나가지 않았으면 청구하지 않는다."""
    H.ingest_doc()
    r = OpenRouter()
    from kb.extract import guard as g
    w = Window("w", "n-x", "본문", [], [])
    job = Job(w, "extract", "public", "s", "본문", {}, "openai/gpt-6.1-sol")
    permit = g.authorize([{"text": "본문", "origin": "external", "sensitivity": 0, "display": None}], "openrouter", "본문")
    (envk.cfg / "openrouter.key").unlink()
    res = r.extract(job, permit)
    assert res.error == "no_key" and res.cost_usd == 0.0


# ---------------------------------------------------------------- 6) 함의 판정의 비용 초과
def _queue_support(cid):
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, support.QUEUE, cid)
    finally:
        c.close()


def _external_claim(ent):
    H.ingest_doc()
    f = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False, "claude.daily_windows": 400}):
        runner.run_agent("public", backends={"claude": f}, do_support=False)
    cl = H.claims()
    assert cl
    from kb.write import commit
    from kb.write.engine import project_pending
    commit([{"kind": "claim.review", "actor": "l2", "origin": "system", "subject": cl[0][0], "idem_key": "t:needs-review",
             "payload": {"id": cl[0][0], "verification": "needs_review", "decided_by": "t"}}], "l2")
    project_pending()
    assert H.claims("n.id=?", (cl[0][0],))[0][2] == "needs_review"
    return cl[0][0]


def _incidents():
    c = opsdb.connect()
    try:
        return c.execute("SELECT kind, detail FROM incident").fetchall()
    finally:
        c.close()


def test_item6_support_overrun_stops_batch_and_records_incident(orsrv, ent):
    cid = _external_claim(ent)
    orsrv.cost = 0.9                                      # 예약액을 크게 넘는다
    orsrv.responder = lambda b: {"supported": True}
    _queue_support(cid)
    with settings.override(**{"openrouter.support_calibrated": True, "openrouter.timeout_s": 30}):
        be = OpenRouter()
        out = support.run_queue({"openrouter": be}, route.Router({"openrouter": be}))
    assert route.stopped() == "cost_exceeded"
    assert any("비용 초과" in d for _, d in _incidents())
    assert out.get("stopped") == "cost_exceeded"
    c = opsdb.connect()
    try:
        left = c.execute("SELECT state FROM queue WHERE kind=? AND ref=?", (support.QUEUE, cid)).fetchone()
    finally:
        c.close()
    assert left is not None and left[0] == "queued"          # 초과한 항목은 지우지 않고 큐에 돌려놓는다


# ---------------------------------------------------------------- 7) 밸브 닫힘 뒤 대체 금지
def _close_valve():
    d = budget.day()
    d["spent"] = 30.0
    state.put(budget.day_key(), d)


@pytest.fixture
def valve30():
    with settings.override(**{"openrouter.daily_valve_usd": 30.0}):
        yield


@pytest.mark.parametrize("purpose", ["support", "cross"])
def test_item7_plan_after_valve_trip_has_no_claude_or_codex(envk, ent, valve30, purpose):
    _close_valve()
    with settings.override(**{"openrouter.support_calibrated": True, "codex.enabled": True, "claude.daily_windows": 400}):
        budget.set_balance(100.0)
        plan = route.Router({}).plan("public", purpose)
    assert plan.cands == [] and plan.stop == "daily_valve", (plan.cands, plan.stop)


def test_item7_reservation_refusal_for_valve_stops_support_without_fallback(envk, ent, monkeypatch):
    cid = _external_claim(ent)
    _queue_support(cid)

    def refuse(usd, *, purpose="extract"):
        raise budget.Refused("valve")
    monkeypatch.setattr(budget, "reserve", refuse)
    orf = H.Fake("openrouter", True, lambda job: {"supported": True})
    clf = H.Fake("claude", True, lambda job: {"supported": True})
    with settings.override(**{"openrouter.support_calibrated": True, "claude.daily_windows": 400}):
        budget.set_balance(100.0)
        out = support.run_queue({"openrouter": orf, "claude": clf}, route.Router({"openrouter": orf, "claude": clf}))
    assert orf.calls == [] and clf.calls == [], (len(orf.calls), len(clf.calls))


def test_item7_reservation_refusal_for_valve_stops_extract_without_fallback(orsrv, ent, monkeypatch):
    H.ingest_doc()

    def refuse(usd, *, purpose="extract"):
        raise budget.Refused("valve")
    monkeypatch.setattr(budget, "reserve", refuse)
    clf = H.Fake("claude", True, H.extract_all(ent))
    with settings.override(**{"claude.daily_windows": 400}):
        out = runner.run_agent("public", backends={"openrouter": OpenRouter(), "claude": clf}, do_support=False)
    assert clf.calls == [] and orsrv.posts == []


# ---------------------------------------------------------------- 8) 예약은 요청의 토큰 상한과 가격에서 구한다
def _sol_job(user_chars: int):
    from kb.extract import schema
    w = Window("w8", "n-x", "본문", [], [{"id": "e:a", "label": "A", "aliases": []}])
    return Job(w, "extract", "public", "sys", "a" * user_chars, schema.extract_schema(["e:a"]), "openai/gpt-6.1-sol")


def test_item8_reservation_is_a_ceiling_for_max_output(envk):
    """Sol 가격(입력 2.5, 출력 15 USD/백만)에서 출력 4,000토큰 + 입력 7,000토큰의 최대 비용 0.0775를 넘어야 한다."""
    r = OpenRouter()
    resv = r.reservation_usd(_sol_job(7000))
    assert resv >= 0.0775, resv
    assert resv >= 4000 * 15 / 1e6 + 0.0                 # 출력만으로도 0.060 이상
    assert budget.price_bound("openai/gpt-6.1-sol", 7000, 4000) >= 0.0775


def test_item8_reservation_grows_with_request_size(envk):
    r = OpenRouter()
    assert r.reservation_usd(_sol_job(20000)) > r.reservation_usd(_sol_job(500))


def test_item8_oversized_request_is_bounded(envk):
    r = OpenRouter()
    with pytest.raises(budget.TooLarge):
        r.reservation_usd(_sol_job(40000))


def test_item8_cost_above_old_reserve_is_not_an_overrun(orsrv, ent):
    """실제 비용 0.0775는 옛 예약 0.054를 넘지만 새 예약 안이다. 정지도 사고도 없다."""
    orsrv.cost = 0.0775
    H.ingest_doc()
    with settings.override(**{"openrouter.timeout_s": 30}):
        out = runner.run_agent("public", backends={"openrouter": OpenRouter()}, do_support=False)
    assert out["windows"] == 1 and route.stopped() is None
    assert not _incidents()
    assert abs(budget.day()["spent"] - 0.0775) < 1e-9 and budget.day()["reserved"] == 0.0


def test_item8_oversized_window_not_sent_and_not_looping(orsrv, ent):
    big = "# 큰 문서\n\n" + "\n\n".join(f"샘플도구는 {i}번 항목에서 하루 최대 {500 + i}건의 요청을 지원한다고 공식 문서가 밝힌다." for i in range(400)) + "\n"
    H.ingest_doc(text=big)
    with settings.override(**{"openrouter.max_input_tokens": 3000}):
        out = runner.run_agent("public", backends={"openrouter": OpenRouter()}, do_support=False)
    assert orsrv.posts == [] and out["windows"] == 0 and out["failed"] >= 1
