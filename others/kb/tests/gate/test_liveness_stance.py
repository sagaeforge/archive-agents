"""9단계 생존 입장: G 단위 주어의 liveness 없음은 R_LIVENESS_UNKNOWN과 queue(kind=live), A~F 주어는 보류 없음,
gate_l1 단계가 결정적 주장에도 적용. TTL이 지나면 큐에만 넣는다."""
from kb.core import ids, opsdb
from kb.gate import GateCtx, check_claim, liveness_stance
from kb.gate import tick_stage
from kb.gate.liveness import CODE
from kb.parse.paragraphs import paragraphs

from .conftest import capture, gold, put_entity, queue_rows

TEXT = "# Repo notes\n\nThe repository was archived in 2025 and receives no updates.\n"


def claim_for(subject, aliases=("repo notes",)):
    ctx = GateCtx(subject=subject, subject_aliases=aliases, liveness=lambda s: liveness_stance(s))
    return check_claim({"statement": "The repository was archived in 2025.", "quote": "The repository was archived in 2025",
                        "kind": "state", "stance": "stated"}, TEXT, paragraphs(TEXT), ctx)


def test_g_unit_without_liveness_is_held_and_queued(env):
    put_entity("e:repo:acme-x", "Repo", "acme/x")
    r = claim_for("e:repo:acme-x")
    assert r.result == "needs_review" and r.code == CODE and r.verification == "needs_review"
    assert queue_rows("live") == ["e:repo:acme-x"]


def test_a_to_f_subject_is_not_held(env):
    put_entity("e:concept:ypp", "Concept", "ypp", domain=("B",))
    put_entity("e:document:yt-policy", "Document", "YouTube policy", domain=("A",))
    for s in ("e:concept:ypp", "e:document:yt-policy"):
        r = claim_for(s)
        assert r.accepted, (s, r.detail)
    assert queue_rows("live") == []


def test_g_unit_with_liveness_passes(env):
    put_entity("e:repo:acme-y", "Repo", "acme/y", liveness="active")
    assert claim_for("e:repo:acme-y").accepted
    assert queue_rows("live") == []


def test_unknown_subject_type_comes_from_id(env):
    # gold에 아직 없는 G 타입 주어(__new__ 임시 엔티티 등)도 도메인 정보가 비면 G로 본다
    assert liveness_stance("e:package:newpkg", enqueue=False) == CODE
    assert liveness_stance("e:concept:newthing", enqueue=False) is None
    assert liveness_stance("e:document:newdoc", enqueue=False) is None


def test_ttl_expired_goes_to_queue_only(env):
    put_entity("e:repo:acme-z", "Repo", "acme/z", liveness="active")
    con = gold()
    try:
        rec = con.execute("SELECT recorded_at FROM node WHERE id='e:repo:acme-z' AND expired_at IS NULL").fetchone()[0]
    finally:
        con.close()
    late = rec + 40 * 86400_000
    assert liveness_stance("e:repo:acme-z", now_ms=late) is None           # 보류하지 않는다
    assert queue_rows("live") == ["e:repo:acme-z"]                         # 재확인 큐에만 들어간다


def test_validate_mode_does_not_enqueue(env):
    put_entity("e:repo:acme-q", "Repo", "acme/q")
    assert liveness_stance("e:repo:acme-q", enqueue=False) == CODE
    assert queue_rows("live") == []


def _det_claim(subject, key):
    from kb.write import commit
    snap = capture("https://t.example/" + key, b"# T\n\nlatest 1.0\n")
    cid = ids.claim_id_det(subject, "latest_version", {}, "1.0", None)
    commit([{"kind": "claim.assert", "actor": "parser", "origin": "external", "subject": subject, "idem_key": f"claim:{cid}",
             "payload": {"id": cid, "subject": subject, "predicate": "latest_version", "value": "1.0", "statement": "latest 1.0",
                         "kind": "state", "stance": "stated", "method": "deterministic", "verification": "parser_derived",
                         "evidence": [{"snapshot": snap["id"], "selector_kind": "text_quote", "exact": "latest 1.0"}]}}], "parser")
    return cid


def _verification(cid):
    con = gold()
    try:
        return con.execute("SELECT verification FROM node WHERE id=? AND expired_at IS NULL", (cid,)).fetchone()[0]
    finally:
        con.close()


def test_gate_l1_stage_applies_to_deterministic_claims(env):
    put_entity("e:repo:acme-d", "Repo", "acme/d")                          # liveness 없음
    put_entity("e:repo:acme-e", "Repo", "acme/e", liveness="active")
    put_entity("e:concept:plain", "Concept", "plain", domain=("B",))
    c1, c2, c3 = _det_claim("e:repo:acme-d", "a"), _det_claim("e:repo:acme-e", "b"), _det_claim("e:concept:plain", "c")
    res = tick_stage.run()
    assert res.ok and res.detail["held"] == 1
    assert _verification(c1) == "needs_review"
    assert _verification(c2) == "parser_derived" and _verification(c3) == "parser_derived"
    assert queue_rows("live") == ["e:repo:acme-d"]
    # 커서가 전진해 두 번째 실행은 아무것도 보지 않는다
    again = tick_stage.run()
    assert again.detail["scanned"] == 0 and again.detail["held"] == 0


def test_stage_is_registered_for_tick(env):
    assert tick_stage.STAGES[0][:2] == (4.5, "gate_l1")
