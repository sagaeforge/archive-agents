"""경로가 바뀌어도 다시 뽑지 않는다(ADR-0003 2장): 큐 소속은 (para_sha, prompt_version, extract_schema)다."""
from kb.extract import budget, runner, settings, tick_stage

from . import helpers as H

S = ["샘플도구는 하루 최대 500건의 요청을 지원한다고 밝힌다.", "샘플도구는 파일 크기 상한을 2GB로 둔다고 밝힌다."]
DOC = "# 안내\n\n" + "\n\n".join(S) + "\n"


def _resp(subject, idx):
    def f(job):
        return {"claims": [H.claim_obj(subject, S[i][:-3], S[i][:-3] + "고 한다.") for i in idx if S[i] in job.window.text]}
    return f


def test_switch_openrouter_to_claude_no_recall_no_retract(ent):
    budget.set_balance(100.0)
    sid = H.ingest_doc(text=DOC)
    orf = H.Fake("openrouter", True, _resp(ent, [0, 1]), cost=0.03)
    runner.run_agent("public", backends={"openrouter": orf}, do_support=False)
    assert len(orf.calls) == 1 and len(H.claims()) == 2
    # 소진 뒤 같은 큐를 다시 돌린다: 같은 문단을 큐에 넣어도 재호출 0
    budget.set_balance(0.0)
    assert H.requeue_all(sid) == 3
    cl = H.Fake("claude", True, _resp(ent, [0]))               # 다른 답을 내는 경로
    out = runner.run_agent("public", backends={"openrouter": orf, "claude": cl}, do_support=False)
    assert cl.calls == [] and out["cache_hits"] == 3 and len(orf.calls) == 1
    assert len(H.events("claim.retract")) == 0 and all(r[1] == "active" for r in H.claims())
    # --reextract일 때만 재호출하고 철회 규칙이 적용된다
    out = runner.run_agent("public", backends={"openrouter": orf, "claude": cl}, do_support=False, reextract=True)
    assert len(cl.calls) == 1 and out["retracted"] == 1
    st = {r[4]: r[1] for r in H.claims()}
    assert sorted(st.values()) == ["active", "dead"]
