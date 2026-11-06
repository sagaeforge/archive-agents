"""gate_pass_drop 이력(llm:gatepass:<모델>)은 게이트를 지난 주장이 있는 창만 쌓는다.
주장이 없는 창(표지, 목차, 차트 표)이 total=max(1, 0)로 [0, 1] 실패가 되던 결함의 회귀 시험."""
from kb.extract import budget, route, runner, state

from . import helpers as H

SECOND_DOC = "# 안내 2\n\n샘플도구는 파일 크기 상한을 2GB로 둔다고 공식 문서가 밝힌다.\n"
SECOND = H.claim_obj("e:tool:sample", "샘플도구는 파일 크기 상한을 2GB로 둔다", "샘플도구는 파일 크기 상한을 2GB로 둔다.")
EMPTY_DOC = "# 공지\n\n이 문서는 목차와 안내 문구만 담고 있다. 사실로 뽑을 내용은 없다.\n"


def _hist(fk):
    key = route.model_key("openrouter", fk.calls[0].model)
    return state.get("llm:gatepass:" + key)


def test_empty_window_leaves_gatepass_unchanged_and_nonempty_still_records(ent):
    budget.set_balance(100.0)
    fk = H.Fake("openrouter", True, H.extract_all(ent), cost=0.01)
    H.ingest_doc(url="https://example.test/full.md", text=H.DOC)
    runner.run_agent("public", backends={"openrouter": fk}, do_support=False)
    assert len(fk.calls) == 1
    h1 = _hist(fk)
    assert h1 == [[1, 1]]                                   # 주장 1건, 통과 1건이 기록된다

    H.ingest_doc(url="https://example.test/empty.md", text=EMPTY_DOC)
    out = runner.run_agent("public", backends={"openrouter": fk}, do_support=False)
    assert len(fk.calls) == 2 and out["windows"] == 1 and out["claims"] == 0   # 빈 창도 호출되고 처리된다
    assert _hist(fk) == h1                                  # 빈 창은 이력을 바꾸지 않는다([0, 1]이 붙지 않는다)

    fk2 = H.Fake("openrouter", True, lambda job: {"claims": [SECOND]} if "2GB" in job.window.text else {"claims": []}, cost=0.01)
    H.ingest_doc(url="https://example.test/full2.md", text=SECOND_DOC)
    runner.run_agent("public", backends={"openrouter": fk2}, do_support=False)
    assert len(fk2.calls) == 1
    assert _hist(fk) == [[1, 1], [1, 1]]                    # 빈 창 뒤의 일반 창은 그대로 기록된다
