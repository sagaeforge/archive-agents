"""kb live release-events: gate_l1이 생존 미상으로 보류한 event 주장만 푼다. 다른 사유의 검토는 건드리지 않는다."""
import json

from kb.cli import main
from kb.core import ids, ledger
from kb.gate import tick_stage

from .conftest import capture, commit, ev, node, put_entity

SUBJ = "e:repo:acme-ev"


def _assert(cid, kind, key, *, method="deterministic", ver="parser_derived", subject=SUBJ):
    snap = capture("https://t.example/" + key, f"# T\n\nshipped 1.0 {key}\n".encode())
    p = {"id": cid, "subject": subject, "statement": "shipped 1.0", "kind": kind, "stance": "stated", "method": method,
         "verification": ver, "evidence": [{"snapshot": snap, "selector_kind": "text_quote", "exact": "shipped 1.0"}]}
    if kind == "event":
        p["valid"] = {"from": "2025-01-01"}
    commit([ev("claim.assert", p, subject, key=f"claim:{cid}:{key}")])


def _review(cid, actor, key, ver="needs_review"):
    commit([{"kind": "claim.review", "actor": actor, "origin": "system", "subject": cid, "idem_key": key,
             "payload": {"id": cid, "verification": ver, "decided_by": actor}}], actor)


def _hold(cid, suffix=""):
    _review(cid, "gate_l1", f"gate_l1:{cid}:R_LIVENESS_UNKNOWN{suffix}")


def _head():
    led = ledger.open_ledger()
    try:
        return ledger.head(led)
    finally:
        led.close()


def _run(capsys, *a):
    assert main(["live", "release-events", "--json", *a]) == 0
    return json.loads(capsys.readouterr().out)


def _ver(cid):
    return node(cid)["verification"]


def test_recovery_selects_only_liveness_held_events(env, capsys):
    put_entity(SUBJ, "Repo", "acme/ev")
    e_ok = ids.claim_id_llm(SUBJ, "ev-ok")
    e_dep = ids.claim_id_llm(SUBJ, "ev-dep")
    e_alias = ids.claim_id_llm(SUBJ, "ev-alias")
    s_state = ids.claim_id_llm(SUBJ, "st")
    _assert(e_ok, "event", "a")
    _hold(e_ok)
    _assert(e_dep, "event", "b")                                   # gate_l1 보류 뒤 의존 대상 사망 suspect가 덧붙은 것
    _hold(e_dep)
    _review(e_dep, "live", f"live:suspect:{e_dep}:e:repo:dead")
    _assert(e_alias, "event", "c", method="llm", ver="needs_review")   # 별칭 불일치 등 게이트 보류(gate_l1 기록 없음)
    _assert(s_state, "state", "d")
    _hold(s_state)
    assert [_ver(c) for c in (e_ok, e_dep, e_alias, s_state)] == ["needs_review"] * 4

    h0 = _head()
    out = _run(capsys)
    assert out["candidates"] == 1 and out["applied"] == 0 and out["dry_run"] and out["by_type"] == {"repo": 1}
    assert _head() == h0                                            # dry-run은 원장에 쓰지 않는다

    out = _run(capsys, "--apply")
    assert out["applied"] == 1
    assert _ver(e_ok) == "parser_derived"
    assert _ver(e_dep) == "needs_review" and _ver(e_alias) == "needs_review" and _ver(s_state) == "needs_review"


def test_second_recovery_after_rehold_really_writes(env, capsys):
    put_entity(SUBJ, "Repo", "acme/ev")
    cid = ids.claim_id_llm(SUBJ, "ev-again")
    _assert(cid, "event", "a")
    _hold(cid)
    assert _run(capsys, "--apply")["applied"] == 1 and _ver(cid) == "parser_derived"
    _assert(cid, "event", "b")                                      # 재파싱 뒤 다시 보류(seq 접미 키)
    _hold(cid, ":9999")
    assert _ver(cid) == "needs_review"
    out = _run(capsys, "--apply")
    assert out["candidates"] == 1 and out["applied"] == 1
    assert _ver(cid) == "parser_derived"


def test_recovery_ignores_already_released(env, capsys):
    put_entity(SUBJ, "Repo", "acme/ev")
    cid = ids.claim_id_llm(SUBJ, "ev-done")
    _assert(cid, "event", "a")
    _hold(cid)
    _run(capsys, "--apply")
    assert _run(capsys, "--apply")["candidates"] == 0


def test_reassert_after_hold_is_seen_as_last_verification(env, capsys):
    """보류 뒤에 온 needs_review assert(subject는 엔티티)가 있으면 풀지 않는다."""
    put_entity(SUBJ, "Repo", "acme/ev")
    cid = ids.claim_id_llm(SUBJ, "ev-reassert")
    _assert(cid, "event", "a")
    _hold(cid)
    _assert(cid, "event", "b", method="llm", ver="needs_review")
    assert _ver(cid) == "needs_review"
    assert _run(capsys)["candidates"] == 0
