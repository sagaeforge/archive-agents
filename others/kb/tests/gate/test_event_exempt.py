"""9단계 생존 보류는 kind=event에 걸지 않는다(사용자 결정 2026-11-01). state, howto는 계속 보류한다. 두 경로(인용 게이트, gate_l1)."""
from kb.core import ids
from kb.gate import GateCtx, check_claim, liveness_stance, tick_stage
from kb.gate.liveness import CODE
from kb.parse.paragraphs import paragraphs

from .conftest import capture, gold, put_entity

TEXT = "# Repo notes\n\nThe repository shipped version 1.0 in 2025.\n"


def _gate(subject, kind):
    ctx = GateCtx(subject=subject, subject_aliases=("repo notes",), liveness=lambda s: liveness_stance(s, enqueue=False), publisher="acme")
    return check_claim({"statement": "The repository shipped version 1.0 in 2025.", "quote": "The repository shipped version 1.0 in 2025",
                        "kind": kind, "stance": "stated"}, TEXT, paragraphs(TEXT), ctx)


def test_quote_gate_exempts_event_only(env):
    put_entity("e:repo:acme-x", "Repo", "acme/x")
    assert _gate("e:repo:acme-x", "event").accepted
    for kind in ("state", "howto"):
        r = _gate("e:repo:acme-x", kind)
        assert r.result == "needs_review" and CODE in r.codes, kind


def _det(subject, kind, key):
    from kb.write import commit
    snap = capture("https://t.example/" + key, b"# T\n\nlatest 1.0\n")
    cid = ids.claim_id_llm(subject, key)
    p = {"id": cid, "subject": subject, "statement": "latest 1.0", "kind": kind, "stance": "stated", "method": "deterministic",
         "verification": "parser_derived", "evidence": [{"snapshot": snap["id"], "selector_kind": "text_quote", "exact": "latest 1.0"}]}
    if kind == "event":
        p["valid"] = {"from": "2025-01-01"}
    commit([{"kind": "claim.assert", "actor": "parser", "origin": "external", "subject": subject, "idem_key": f"claim:{cid}", "payload": p}], "parser")
    return cid


def _ver(cid):
    con = gold()
    try:
        return con.execute("SELECT verification FROM node WHERE id=? AND expired_at IS NULL", (cid,)).fetchone()[0]
    finally:
        con.close()


def test_gate_l1_stage_exempts_event_only(env):
    put_entity("e:repo:acme-t", "Repo", "acme/t")
    ev_, st, hw = _det("e:repo:acme-t", "event", "e"), _det("e:repo:acme-t", "state", "s"), _det("e:repo:acme-t", "howto", "h")
    res = tick_stage.run()
    assert res.detail["held"] == 2
    assert _ver(ev_) == "parser_derived" and _ver(st) == "needs_review" and _ver(hw) == "needs_review"
