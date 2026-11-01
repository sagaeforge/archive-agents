"""인용구 재확인: 남으면 confirm, state/howto 소실은 withdraw, event는 유지, 30% 초과 소실은 degraded, feed/short는 철회 없음, 효력일 대체 완결."""
import pytest

from kb import ingest
from kb.extract import reconfirm, runner, settings, tick_stage

from . import helpers as H

URL = "https://example.test/rc.md"
S = ["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다.", "샘플도구는 파일 크기 상한을 2GB로 둔다고 밝힌다.",
     "샘플도구는 동시 연결을 최대 8개까지 허용한다고 밝힌다.", "샘플도구 2.0은 2026-10-01에 출시되었다고 밝힌다."]


def _doc(keep):
    return "# 샘플도구 안내\n\n" + "\n\n".join(S[i] for i in keep) + "\n"


def _responder(subject):
    def f(job):
        out = []
        for i, s in enumerate(S):
            if s in job.window.text:
                kw = dict(kind="event", valid_from="2026-10-01") if i == 3 else {}
                out.append(H.claim_obj(subject, s[:-3], s[:-3] + "고 한다.", **kw))
        return {"claims": out}
    return f


def _extract(ent, doc, fetched_at):
    H.ingest_doc(url=URL, text=doc, fetched_at=fetched_at)
    f = H.Fake("claude", True, _responder(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"claude": f}, do_support=False)
    return f


def _stage():
    return tick_stage.run()


def _status(cid):
    return H.claims("n.id=?", (cid,))[0][1]


def test_confirm_withdraw_event_kept(ent):
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    cl = {c[4]: c for c in H.claims()}
    assert len(cl) == 4
    _stage()                                              # 첫 스냅샷 자체는 이전 스냅샷이 없다
    # v2: 상태 주장 하나(S[1])와 사건(S[3])이 사라지지만 4건 중 2건=50%라 degraded가 되므로, 먼저 1건만 뺀다
    H.ingest_doc(url=URL, text=_doc([0, 1, 3]), fetched_at=1_793_000_100_000, enqueue=False)
    r = _stage()
    d = r.detail["reconfirm"]
    assert d["confirmed"] == 3 and d["withdrawn"] == 1 and d["degraded"] == 0
    assert len(H.events("source.status")) == 0
    gone = [c for c in H.claims() if "동시 연결" in c[4]][0]
    assert _status(gone[0]) == "superseded"               # state는 철회


def test_event_claim_kept_when_quote_vanishes(ent):
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    H.ingest_doc(url=URL, text=_doc([0, 1, 2]), fetched_at=1_793_000_200_000, enqueue=False)   # 사건 문장만 소실(25%)
    d = _stage().detail["reconfirm"]
    ev = [c for c in H.claims() if "출시" in c[4]][0]
    assert _status(ev[0]) == "active" and d["kept_event"] == 1 and d["withdrawn"] == 0


def test_confirm_one_event_per_snapshot(ent):
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    H.ingest_doc(url=URL, text=_doc([0, 1, 2, 3]) + "\n추가 문단은 새로 생겼다.\n", fetched_at=1_793_000_100_000, enqueue=False)
    _stage()
    _stage()                                              # 다시 돌아도 같은 이벤트가 늘지 않는다
    assert len(H.events("claim.confirm")) == 4


def test_over_30_percent_vanish_degrades(ent):
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    H.ingest_doc(url=URL, text=_doc([0, 1]), fetched_at=1_793_000_100_000, enqueue=False)
    d = _stage().detail["reconfirm"]
    assert d["degraded"] == 1 and d["withdrawn"] == 0
    assert all(c[1] == "active" for c in H.claims())      # 철회 없음
    assert len(H.events("source.status")) == 1


def test_moving_window_sources_do_not_withdraw(ent, monkeypatch):
    monkeypatch.setattr(reconfirm, "_src_class", lambda s: "feed")
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    H.ingest_doc(url=URL, text=_doc([0, 1, 2]), fetched_at=1_793_000_100_000, enqueue=False)   # 1/4 소실
    d = _stage().detail["reconfirm"]
    assert d["withdrawn"] == 0 and all(c[1] == "active" for c in H.claims())


def _det(sid, ent, quote, value, vfrom):
    return {"item": "claim", "subject": ent, "predicate": "quota", "value": value, "statement": quote + ".", "kind": "state",
            "stance": "stated", "method": "deterministic", "evidence": {"snapshot": sid, "quote": quote}, "valid": {"from": vfrom}}


def test_due_supersede_completed(ent):
    sid = H.ingest_doc(url="https://example.test/sup.md", text="# 요금\n\n샘플도구의 쿼터는 하루 500건이다 (기존).\n\n샘플도구의 쿼터는 하루 900건이다 (신규).\n\n샘플도구의 쿼터는 하루 999건이다 (미래).\n", enqueue=False)
    hdr = {"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t-sup", "producer": "agent:t"}
    rep = ingest.submit([hdr,
                         _det(sid, ent, "샘플도구의 쿼터는 하루 500건이다 (기존)", "500", "2026-01-01"),
                         _det(sid, ent, "샘플도구의 쿼터는 하루 900건이다 (신규)", "900", "2026-06-01"),
                         _det(sid, ent, "샘플도구의 쿼터는 하루 999건이다 (미래)", "999", "2099-01-01")], fetch=False)
    assert rep.summary()["rejected"] == 0, rep.lines
    from kb.write.engine import project_pending
    project_pending()
    n = _stage().detail["reconfirm"]["superseded"]
    assert n >= 1
    st = {c[4]: c[1] for c in H.claims()}
    assert st["샘플도구의 쿼터는 하루 500건이다 (기존)."] == "superseded"
    assert st["샘플도구의 쿼터는 하루 900건이다 (신규)."] == "active"      # 미래 발효분(2099)은 아직 대체하지 않는다
    assert st["샘플도구의 쿼터는 하루 999건이다 (미래)."] == "active"


def test_moving_window_source_is_not_degraded(ent, monkeypatch):
    """창이 움직이는 소스의 소실은 정상 갱신이다. 1건 소실도 degraded가 아니다."""
    monkeypatch.setattr(reconfirm, "_src_class", lambda s: "feed")
    from kb.core.conn import connect_ro  # noqa: F401
    url = "https://example.test/feed.xml"
    H.ingest_doc(url=url, text="# 피드\n\n샘플도구는 하루 최대 500건의 요청을 지원한다고 공식 문서가 밝힌다.\n", source="src:feed")
    f = H.Fake("claude", True, H.extract_all(ent))
    from kb.extract import runner, settings
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"claude": f}, do_support=False)
    H.ingest_doc(url=url, text="# 피드\n\n샘플도구의 다른 항목이 올라왔다.\n", source="src:feed", fetched_at=1_793_000_100_000)
    r = reconfirm.run_new_snapshots()
    assert r["degraded"] == 0 and not H.events("source.status") and not H.events("claim.withdraw")
