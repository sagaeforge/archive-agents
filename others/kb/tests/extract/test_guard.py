"""외부 어댑터 호출 0건 조건: first_party, 세션 자료, sensitivity>=1, 값 없음, 읽기 실패, 비밀 탐지. LLM 분류는 허가 근거가 아니다.
창 안 문단 하나라도 민감하면 창 전체 거부. SendPermit 없이 어댑터가 요청을 만들 수 없다. 우회 시도는 external_send 사고와 L2 정지."""
import pytest

from kb.core import opsdb
from kb.extract import budget, guard, runner, settings, state
from kb.extract.backends.openrouter import OpenRouter
from kb.extract.types import Job, Window

from . import helpers as H

SECRET = "ghp_1A2b3C4d5E6f7G8h9I0jK1lM2nO3pQ4rS5tU"


@pytest.fixture
def orsrv(envk, ent):
    srv = H.OrServer(responder=lambda b: {"claims": []})
    with settings.override(**{"openrouter.base_url": srv.url, "claude.daily_windows": 0, "codex.enabled": False}):
        budget.set_balance(100.0)
        yield srv
    srv.close()


def _run():
    return runner.run_agent("public", backends={"openrouter": OpenRouter()}, do_support=False)


CASES = {
    "first_party": dict(origin="first_party", sensitivity=0, display="f:user"),
    "session": dict(origin="first_party", sensitivity=0, display="f:agent:s-1"),
    "sens1": dict(origin="external", sensitivity=1, display=None),
    "no_value": dict(origin="external", sensitivity=None, display=None),
    "read_fail": dict(error="OperationalError"),
}


@pytest.mark.parametrize("name", list(CASES))
def test_external_call_zero(orsrv, monkeypatch, name):
    H.ingest_doc()
    monkeypatch.setattr(guard, "inspect_snapshot", lambda sid, text, con=None: {"text": text, **CASES[name]})
    out = _run()
    assert out["windows"] == 0 and out["guarded"] >= 1
    assert orsrv.posts == []                                  # 가짜 서버 요청 0


def test_secret_detected_zero(envk, ent, monkeypatch):
    srv = H.OrServer()
    try:
        with settings.override(**{"openrouter.base_url": srv.url, "codex.enabled": False}):
            budget.set_balance(100.0)
            H.ingest_doc(text=H.DOC + f"\n설정 예시는 토큰 {SECRET} 값을 쓴다고 적혀 있다.\n")
            out = _run()
        assert out["windows"] == 0 and srv.posts == []
    finally:
        srv.close()


def test_llm_classification_is_not_permission(orsrv, monkeypatch):
    """sLLM이 public이라고 답해도 저장된 민감도가 1이면 전송 0."""
    H.ingest_doc()
    monkeypatch.setattr(guard, "inspect_snapshot", lambda sid, text, con=None: {"text": text, "origin": "external", "sensitivity": 1, "display": None})
    sllm = H.Fake("sllm", False, lambda job: {"label": "public"})
    out = runner.run_agent("public", backends={"openrouter": OpenRouter(), "sllm": sllm}, do_support=False)
    assert orsrv.posts == [] and out["windows"] == 0


def test_one_sensitive_paragraph_rejects_whole_window(orsrv, monkeypatch):
    H.ingest_doc()

    def insp(sid, text, con=None):
        sens = 2 if "새 요금제" in text else 0
        return {"text": text, "origin": "external", "sensitivity": sens, "display": None}
    monkeypatch.setattr(guard, "inspect_snapshot", insp)
    out = _run()
    assert out["windows"] == 0 and orsrv.posts == []


def test_public_window_is_sent_with_permit(orsrv, ent):
    srv = orsrv
    srv.responder = H.extract_all(ent)
    H.ingest_doc()
    # extract_all은 job을 받는다. 서버는 body를 받으므로 요청 본문에서 창 본문을 읽는다
    srv.responder = lambda b: ({"claims": [H.claim_obj(ent, H.GOOD["quote"], H.GOOD["statement"])]}
                               if H.GOOD["quote"] in b["messages"][1]["content"] else {"claims": []})
    out = _run()
    assert out["windows"] == 1 and len(srv.posts) == 1 and out["by_backend"] == {"openrouter": 1}
    body = srv.posts[0][2]
    assert body["provider"]["require_parameters"] is True and body["provider"]["order"] == ["OpenAI"]
    assert body["response_format"]["json_schema"]["strict"] is True


def _job(text="내용 본문"):
    w = Window("w1", "n-x", text, [], [{"id": "e:a", "label": "A", "aliases": []}])
    from kb.extract import schema
    return Job(w, "extract", "public", "sys", text, schema.extract_schema(["e:a"]), "openai/gpt-6.1-sol")


@pytest.mark.parametrize("permit", [None, "forged", "wrong"])
def test_adapter_cannot_send_without_permit(orsrv, permit):
    job = _job()
    if permit == "forged":
        permit = guard.SendPermit("openrouter", guard.window_sha(job.user), "0" * 64)
    elif permit == "wrong":
        permit = guard.authorize([{"origin": "external", "sensitivity": 0, "display": None, "text": "다른 본문"}], "openrouter", "다른 본문")
    with pytest.raises(guard.PermitError):
        OpenRouter().extract(job, permit)
    assert orsrv.posts == []
    c = opsdb.connect()
    try:
        kinds = [r[0] for r in c.execute("SELECT kind FROM incident")]
    finally:
        c.close()
    assert "external_send" in kinds                          # 사고로 남는다
    assert guard.halted()                                    # L2가 멈춘다
    H.ingest_doc()
    out = _run()
    assert out["windows"] == 0 and out["is_error"] is True and out["reason"] == "halted" and orsrv.posts == []


def test_sllm_needs_no_permit_but_external_does():
    assert guard.authorize([{"origin": "first_party", "sensitivity": 2, "display": "f:user", "text": "x"}], "sllm", "x") is None
    with pytest.raises(guard.GuardDenied):
        guard.authorize([{"origin": "first_party", "sensitivity": 2, "display": "f:user", "text": "x"}], "claude", "x")
