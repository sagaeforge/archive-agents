"""claim.assert.extractor = l2:<backend>:<model>:<prompt_version>. 모든 백엔드의 출력이 같은 check_claim을 지난다(모델별 분기와 문턱 없음)."""
import pathlib
import re

from kb.extract import budget, runner, settings

from . import helpers as H

S = ["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다.", "샘플도구는 파일 크기 상한을 2GB로 둔다고 밝힌다."]


def _resp(subject, idx):
    def f(job):
        return {"claims": [H.claim_obj(subject, S[i][:-3], S[i][:-3] + "고 한다.") for i in idx if S[i] in job.window.text]}
    return f


def test_extractor_format_and_same_gate_for_all_backends(ent, monkeypatch):
    import kb.ingest.process as proc
    calls = []
    real = proc.check_claim
    monkeypatch.setattr(proc, "check_claim", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    budget.set_balance(100.0)
    H.ingest_doc(url="https://example.test/a.md", text="# A\n\n" + S[0] + "\n")
    H.ingest_doc(url="https://example.test/b.md", text="# B\n\n" + S[1] + "\n")
    orf = H.Fake("openrouter", True, _resp(ent, [0, 1]), cost=0.03)
    # 첫 문서는 OpenRouter로, 두 번째 문서는 소진 뒤 Claude로
    out1 = runner.run_agent("public", backends={"openrouter": orf, "claude": H.Fake("claude", True)}, do_support=False, max_windows=1)
    budget.set_balance(0.0)
    clf = H.Fake("claude", True, _resp(ent, [0, 1]))
    out2 = runner.run_agent("public", backends={"openrouter": orf, "claude": clf}, do_support=False)
    ex = {r[5] for r in H.claims()}
    assert ex == {"l2:openrouter:openai/gpt-6.1-sol:extract-1", "l2:claude:haiku:extract-1"}
    assert all(re.fullmatch(r"l2:[a-z]+:[^:]+:[^:]+", e) for e in ex)
    assert len(calls) == 2                                              # 두 백엔드 모두 같은 함수를 지났다
    con = H.gold()
    try:
        gv = {r[0] for r in con.execute("SELECT gate_version FROM evidence")}
    finally:
        con.close()
    assert gv == {"gate@2"}                                             # 게이트 판본은 evidence.gate_version
    # 경로별 철회
    from kb.cli import main
    assert main(["claim", "retract", "--extractor", "l2:claude:haiku:extract-1"]) == 0
    st = {r[5]: r[1] for r in H.claims()}
    assert st["l2:claude:haiku:extract-1"] == "dead" and st["l2:openrouter:openai/gpt-6.1-sol:extract-1"] == "active"


def test_extract_run_event_fields(ent):
    budget.set_balance(100.0)
    H.ingest_doc()
    orf = H.Fake("openrouter", True, H.extract_all(ent), cost=0.03)
    runner.run_agent("public", backends={"openrouter": orf}, do_support=False)
    ev = H.events("extract.run")[0]
    for k in ("backend", "provider", "served_model", "schema_profile", "purpose", "scope", "route_reason", "finish_reason", "elapsed_s", "cost_usd",
              "window_sha", "para_shas", "prompt_version", "model", "output_sha", "usage"):
        assert k in ev, k
    assert ev["backend"] == "openrouter" and ev["purpose"] == "extract" and ev["scope"] == "public"
    assert ev["cost_usd"] == "0.030000" and ev["route_reason"] == "or:balance"


def test_no_model_specific_gate_branches():
    src = "".join(p.read_text() for p in pathlib.Path(__file__).resolve().parents[2].joinpath("src/kb/extract").rglob("*.py"))
    assert "check_claim" in src and "GateCtx(" in src
    for bad in ("if model ==", "if cand.model ==", 'if backend == "openrouter" and gate', "gate_threshold"):
        assert bad not in src
