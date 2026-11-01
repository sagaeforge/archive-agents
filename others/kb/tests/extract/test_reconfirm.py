"""인용구 재확인: 남으면 confirm, state/howto 소실은 withdraw, event는 유지, 30% 초과 소실은 degraded, feed/short는 철회 없음, 효력일 대체 완결."""
import json

import pytest

from kb import ingest, read
from kb.core import cas, ledger
from kb.extract import reconfirm, runner, settings, tick_stage
from kb.project import rebuild
from kb.read import ReadCtx, search

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


SHIFTED = "# 샘플도구 안내\n\n새로 앞에 붙은 문단은 추출 대상이 아닌 설명이다.\n\n" + "\n\n".join(S) + "\n"


def _evidence(sid):
    con = H.gold()
    try:
        return con.execute("SELECT claim_id, id, exact, prefix, suffix, start_cp, end_cp FROM evidence WHERE snapshot_id=? ORDER BY claim_id",
                           (sid,)).fetchall()
    finally:
        con.close()


def _text(sid):
    con = H.gold()
    try:
        props = json.loads(con.execute("SELECT props FROM node WHERE id=? AND expired_at IS NULL", (sid,)).fetchone()[0])
    finally:
        con.close()
    return cas.get(props["text_sha"]).decode("utf-8")


def test_confirm_offsets_point_into_new_snapshot(ent):
    """계약 2.11: 새 스냅샷의 근거 행은 그 스냅샷 표시 본문의 코드포인트 위치를 갖는다. 세 조회 경로가 맞는 값을 낸다."""
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    sid = H.ingest_doc(url=URL, text=SHIFTED, fetched_at=1_793_000_100_000, enqueue=False)
    assert _stage().detail["reconfirm"]["confirmed"] == 4
    text = _text(sid)
    rows = _evidence(sid)
    assert len(rows) == 4
    for _, _, exact, prefix, suffix, a, b in rows:
        assert a is not None and text[a:b] == exact
        assert text[:a].endswith(prefix) and text[b:].startswith(suffix)
    con = H.gold()
    ctx = ReadCtx(max_sensitivity="internal", include_unverified=True)
    try:
        by_id = {r[0]: r for r in rows}
        for cc in read.snapshot_meta(con, ctx, sid)["citing_claims"]:
            assert (cc["start"], cc["end"]) == by_id[cc["id"]][5:7]
            ev = [e for e in read.get_claim(con, ctx, cc["id"])["evidence"] if e["snapshot_id"] == sid][0]
            assert text[ev["start"]:ev["end"]] == ev["exact"]
        a = text.index("새로 앞에")
        assert search.promote_passage(con, ctx, {"kind": "passage", "snapshot_id": sid, "start": a, "end": a + 20}) == []
        i = text.index(S[2])
        hit = {"kind": "passage", "snapshot_id": sid, "start": i, "end": i + len(S[2])}
        assert search.promote_passage(con, ctx, hit) == [r[0] for r in rows if S[2][:10] in r[2]]
    finally:
        con.close()


def test_confirm_offsets_survive_rebuild_and_third_snapshot(ent):
    """오프셋은 이벤트에 실려 재구축으로 그대로 복원된다. 세 번째 스냅샷도 자기 본문의 위치를 갖는다."""
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    s2 = H.ingest_doc(url=URL, text=SHIFTED, fetched_at=1_793_000_100_000, enqueue=False)
    _stage()
    s3 = H.ingest_doc(url=URL, text="머리말 한 줄을 더 둔다.\n\n" + SHIFTED, fetched_at=1_793_000_200_000, enqueue=False)
    assert _stage().detail["reconfirm"]["confirmed"] == 4
    assert all(_text(s3)[r[5]:r[6]] == r[2] for r in _evidence(s3))
    before = _evidence(s2), _evidence(s3)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    assert (_evidence(s2), _evidence(s3)) == before
    assert all(e["payload_v"] == 2 for e in _confirm_versions())


def _confirm_versions():
    led = ledger.open_ledger()
    try:
        return [{"payload_v": e["v"]} for e in ledger.iter_events(led, 0, 100000) if e["kind"] == "claim.confirm"]
    finally:
        led.close()


def test_ambiguous_quote_confirmed_without_position(ent):
    """새 본문에 인용구가 두 곳이면 있다는 것만 확인한다. 옛 위치를 쓰지 않고 NULL이며 조회와 승격이 깨지지 않는다."""
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    _stage()
    twice = "# 제목이 바뀌었다\n\n" + "\n\n".join(S) + "\n\n맺음말을 붙인다.\n\n" + S[0] + "\n"     # prefix로도 못 가른다
    sid = H.ingest_doc(url=URL, text=twice, fetched_at=1_793_000_100_000, enqueue=False)
    assert _stage().detail["reconfirm"]["confirmed"] == 4
    rows = _evidence(sid)
    nulls = [r for r in rows if r[5] is None]
    assert len(rows) == 4 and len(nulls) == 1 and S[0][:10] in nulls[0][2]
    con = H.gold()
    ctx = ReadCtx(max_sensitivity="internal", include_unverified=True)
    try:
        meta = {c["id"]: c for c in read.snapshot_meta(con, ctx, sid)["citing_claims"]}
        assert meta[nulls[0][0]]["start"] is None
    finally:
        con.close()
    # 철회 뒤 재추출: 대체된 옛 스냅샷의 창은 건너뛰므로(order.py) 새 스냅샷만 다시 뽑는다. 인용구가 두 곳인 주장은
    # 게이트가 E_QUOTE_AMBIGUOUS로 거부하므로 되살아나지 않고, 나머지 위치 있는 주장은 되살아난다
    from kb.cli import main
    assert main(["claim", "retract", "--extractor", "l2:claude:haiku:extract-2", "--json"]) == 0
    f = H.Fake("claude", True, _responder(ent))
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"claude": f}, do_support=False, reextract=True)
    assert out["revived"] == 3 and len(H.claims("n.status='active'")) == 3


def test_v1_confirm_replays_without_stale_offsets(ent):
    """옛 형식(v1, 위치 없음) 이벤트는 업캐스터를 지나 재구축되고 옛 스냅샷 오프셋을 복사하지 않는다."""
    from kb.write import commit
    _extract(ent, _doc([0, 1, 2, 3]), 1_793_000_000_000)
    sid = H.ingest_doc(url=URL, text=SHIFTED, fetched_at=1_793_000_100_000, enqueue=False)
    cid = H.claims()[0][0]
    commit([{"kind": "claim.confirm", "actor": "l2", "origin": "system", "subject": cid, "idem_key": f"old:{cid}", "v": 1,
             "payload": {"id": cid, "snapshot": sid}}], "l2", timeout=60.0)
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    rows = _evidence(sid)
    assert len(rows) == 1 and rows[0][0] == cid and rows[0][5] is None and rows[0][6] is None and rows[0][2]

