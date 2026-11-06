"""문단 단위 캐시: 바뀐 문단만 호출, 같은 문단 재호출 0, 프롬프트 버전이 바뀌면 재호출."""
from kb.extract import runner, settings

from . import helpers as H


def _run(fake):
    with settings.override(**{"openrouter.enabled": False}):
        return runner.run_agent("public", backends={"anthropic_api": fake}, do_support=False)


def test_changed_paragraph_only(ent):
    sid = H.ingest_doc()
    assert H.queue_n() == 4
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    out = _run(f)
    assert out["windows"] == 1 and len(f.calls) == 1 and out["claims"] == 1
    assert H.queue_n() == 0
    # 한 글자만 바꾼 새 문서: 바뀐 문단 하나만 호출한다
    H.ingest_doc(text=H.DOC.replace("2027-01-15", "2027-01-16"), fetched_at=1_793_000_100_000)
    assert H.queue_n() == 1
    out = _run(f)
    assert len(f.calls) == 2
    w = f.calls[1].window
    assert len(w.paras) == 1 and "2027-01-16" in w.text and "하루 최대 500건" not in w.text
    # 같은 문서를 다시 넣어도 재호출 0
    H.ingest_doc(text=H.DOC.replace("2027-01-15", "2027-01-16"), fetched_at=1_793_000_100_000)
    out = _run(f)
    assert len(f.calls) == 2 and out["windows"] == 0


def test_prompt_version_change_recalls(ent):
    from kb.extract import tick_stage
    H.ingest_doc()
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    _run(f)
    assert len(f.calls) == 1
    with settings.override(prompt_version="extract-3"):
        r = tick_stage.enqueue_new()
        assert r["queued"] == 4
        _run(f)
    assert len(f.calls) == 2


def test_cache_hit_counted_when_marked_done(ent):
    from kb.extract import cache
    sid = H.ingest_doc()
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        refs = [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind='l2'")]
    finally:
        c.close()
    cache.mark_done([r.split("|")[1] for r in refs], "x" * 64)
    out = _run(f)
    assert out["cache_hits"] == 4 and len(f.calls) == 0 and H.queue_n() == 0
