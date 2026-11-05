"""재구축은 LLM을 부르지 않고 같은 주장을 복원한다. 원응답은 CAS에서 재생한다."""
from kb.core import cas, ledger
from kb.extract import cache, runner, settings, tick_stage
from kb.project import rebuild

from . import helpers as H


def _snapshot_rows():
    return [(r[0], r[1], r[2], r[4], r[5]) for r in H.claims()]


def test_rebuild_restores_claims_without_backend(ent):
    H.ingest_doc()
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    before = _snapshot_rows()
    assert before and len(f.calls) == 1
    led = ledger.open_ledger()
    try:
        rebuild(led=led)
    finally:
        led.close()
    assert _snapshot_rows() == before and len(f.calls) == 1            # 재구축에 백엔드 호출 0


def test_raw_response_replayed_from_cas(ent):
    sid = H.ingest_doc()
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    before = _snapshot_rows()
    runs = H.events("extract.run")
    assert len(runs) == 1 and cas.exists(runs[0]["output_sha"])         # 원응답이 CAS에 있다
    # 문단 done 표시를 지우고 큐에 다시 넣는다(같은 창 sha, 같은 extractor). 백엔드는 부르지 않고 CAS 응답으로 복원한다
    cache.clear_done(runs[0]["para_shas"])
    assert H.requeue_all(sid) == 4
    boom = H.Fake("anthropic_api", True, lambda job: (_ for _ in ()).throw(AssertionError("백엔드를 부르면 안 된다")))
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"anthropic_api": boom}, do_support=False)
    assert boom.calls == [] and out["windows"] == 1
    assert _snapshot_rows() == before                                  # 같은 주장(같은 ID)
    assert len(H.events("claim.assert")) == 1
