"""민감 범위 입력(first_party 레코드)에서 나온 주장은 원본 민감도 이상으로 쓰이고, 그 상한 아래 조회에서 보이지 않는다(ADR 7.9).
sLLM만 쓰고(가짜 llama-server) 외부 어댑터 호출은 0이다."""
import json

import pytest

from kb.core import opsdb
from kb.extract import runner, settings
from kb.extract.backends.sllm import Sllm

from . import helpers as H

TEXT = "# 내부 메모\n\n샘플도구는 내부 목표 처리량을 하루 500건으로 정했다고 메모에 적혀 있다.\n"
QUOTE = "샘플도구는 내부 목표 처리량을 하루 500건으로 정했다"


@pytest.fixture
def setup(ent, tmp_path, monkeypatch):
    import kb.write.engine as eng
    import kb.write.fpgate as fp
    from kb.write import commit
    from kb.write.engine import project_pending
    monkeypatch.setattr(fp, "is_open", lambda: True)
    monkeypatch.setattr(eng, "fp_is_open", lambda led: True)
    content = {"claims": [H.claim_obj(ent, QUOTE, QUOTE + ".")]}
    p = H.make_fake_llama(tmp_path / "ll", content)
    commit([{"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": "r:note-1", "idem_key": "rec:note-1",
             "payload": {"id": "r:note-1", "type": "Note", "title": "내부 메모", "body": TEXT, "body_format": "markdown",
                         "sensitivity": "private"}}], "user:sagae")
    project_pending()
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, "l2s", "r:note-1|0|0")
    finally:
        c.close()
    ov = {"sllm.server_bin": str(p), "sllm.model_file": str(p.parent / "model.gguf"), "sllm.vram_cmd": ["echo", "9000"],
          "sllm.netns": False, "sllm.port": 18932, "sllm.health_wait_s": 20, "sllm.term_wait_s": 5}
    with settings.override(**ov):
        yield p.parent


def test_claims_inherit_source_sensitivity(setup, ent):
    ext_calls = {"claude": H.Fake("claude", True, H.extract_all(ent)), "openrouter": H.Fake("openrouter", True, H.extract_all(ent))}
    out = runner.run_agent("sensitive", backends={**ext_calls, "sllm": Sllm(port=18932)})
    assert out["windows"] == 1 and out["claims"] == 1 and out["by_backend"] == {"sllm": 1}, out
    assert not ext_calls["claude"].calls and not ext_calls["openrouter"].calls          # 외부 호출 0
    ev = H.events("claim.assert")[0]
    assert ev["extractor"].startswith("l2:sllm:") and ev["sensitivity_floor"] >= 2      # 원본 private(2) 이상
    run = H.events("extract.run")[0]
    assert run["backend"] == "sllm" and run["scope"] == "sensitive" and run["cost_usd"] == "0.000000"
    assert run["provider"] == "local"


def test_not_visible_below_the_ceiling(setup, ent):
    runner.run_agent("sensitive", backends={"sllm": Sllm(port=18932)})
    con = H.gold()
    try:
        cid, node_s = con.execute("SELECT n.id, n.sensitivity FROM node n JOIN claim c ON c.vid=n.vid WHERE n.type='Claim' AND n.expired_at IS NULL").fetchone()
        head_s = con.execute("SELECT sensitivity FROM head WHERE id=?", (cid,)).fetchone()[0]
        span_s = con.execute("SELECT sensitivity FROM span WHERE ref_id=? AND rec_to IS NULL", (cid,)).fetchone()[0]
    finally:
        con.close()
    assert node_s >= 2 and head_s >= 2 and span_s >= 2
    from kb.read import ReadCtx, get_claim, node_claims
    from kb.read.ctx import NotFound
    from kb.read.search import search
    con = H.gold()
    try:
        for lvl in ("public", "internal"):
            ctx = ReadCtx(max_sensitivity=lvl)
            with pytest.raises(NotFound):
                get_claim(con, ctx, cid)
            data, _ = node_claims(con, ctx, ent)
            assert QUOTE[:10] not in json.dumps(data, ensure_ascii=False)
            assert QUOTE[:10] not in json.dumps(search("내부 목표 처리량", ctx), ensure_ascii=False, default=str)
        assert QUOTE[:10] in json.dumps(get_claim(con, ReadCtx(max_sensitivity="private"), cid), ensure_ascii=False, default=str)
    finally:
        con.close()


def test_long_record_is_fully_windowed(ent, tmp_path, setup):
    from kb.extract import sensitive
    from kb.parse import paragraphs as pg
    text = "# 긴 메모\n\n" + "\n\n".join(f"문단 {i} " + "가" * 900 for i in range(20)) + "\n\n끝 문단\n"
    paras = pg.paragraphs(text, "markdown")
    got = sensitive.chunks(text, paras)
    assert len(got) >= 3 and all(sum(len(t) + 2 for _, t in c) <= 6000 for c in got)
    assert [s for c in got for s, _ in c] == [p.para_sha for p in paras]  # 뒷부분이 빠지지 않는다


def test_failed_window_retries_then_dlq(setup, ent):
    class Bad(Sllm):
        def extract(self, job, permit):
            from kb.extract.types import Result
            return Result(job.window.window_id, "sllm", "m", error="boom", elapsed_s=0.1)
    be = Bad(port=18932)
    import time
    for n in range(3):
        c = opsdb.connect()
        try:
            c.execute("UPDATE queue SET next_at=NULL WHERE kind='l2s'")
        finally:
            c.close()
        runner.run_agent("sensitive", backends={"sllm": be})
        c = opsdb.connect()
        try:
            row = c.execute("SELECT next_at FROM queue WHERE kind='l2s'").fetchone()
        finally:
            c.close()
        if n < 2:
            assert row and row[0] > time.time() * 1000                  # 절대 시각으로 10분 뒤
    assert row is None and H.queue_n("l2s") == 0
    c = opsdb.connect()
    try:
        assert c.execute("SELECT count(*) FROM dlq WHERE kind='l2s'").fetchone()[0] == 1
    finally:
        c.close()


def test_rerun_after_commit_does_not_conflict(setup, ent):
    be = Sllm(port=18932)
    runner.run_agent("sensitive", backends={"sllm": be})
    n = len(H.events("extract.run"))
    c = opsdb.connect()
    try:
        opsdb.queue_put(c, "l2s", "r:note-1|0|0")                       # _qdone 전 크래시와 같은 상태
    finally:
        c.close()
    out = runner.run_agent("sensitive", backends={"sllm": be})
    assert out["is_error"] is False and len(H.events("extract.run")) == n


def test_tick_feeds_sensitive_queue(ent):
    """first_party 레코드는 l2s에 들어가고, secret과 세션 자료는 들어가지 않는다."""
    from kb.extract import tick_stage
    from kb.write import commit
    import kb.write.engine as eng
    import pytest as _p
    mp = _p.MonkeyPatch()
    mp.setattr(eng, "fp_is_open", lambda led: True)
    try:
        for rid, actor, sens in (("r:a", "user:sagae", "private"), ("r:b", "user:sagae", "secret"), ("r:c", "agent:session", "internal")):
            commit([{"kind": "record.put", "actor": actor, "origin": "first_party", "subject": rid, "idem_key": f"rec:{rid}",
                     "payload": {"id": rid, "type": "Note", "title": "t", "body": "본문입니다", "body_format": "markdown", "sensitivity": sens}}], actor)
        tick_stage.enqueue_new()
    finally:
        mp.undo()
    c = opsdb.connect()
    try:
        refs = [r[0] for r in c.execute("SELECT ref FROM queue WHERE kind='l2s'")]
    finally:
        c.close()
    assert len(refs) == 1 and refs[0].startswith("r:a|")


def test_secret_source_not_extracted(setup, ent):
    from kb.write import commit
    from kb.write.engine import project_pending
    commit([{"kind": "record.put", "actor": "user:sagae", "origin": "first_party", "subject": "r:sec-1", "idem_key": "rec:sec-1",
             "payload": {"id": "r:sec-1", "type": "Note", "title": "비밀", "body": TEXT, "body_format": "markdown", "sensitivity": "secret"}}],
           "user:sagae")
    project_pending()
    c = opsdb.connect()
    try:
        opsdb.queue_done(c, "l2s", "r:note-1|0|0")
        opsdb.queue_put(c, "l2s", "r:sec-1|0|0")
    finally:
        c.close()
    out = runner.run_agent("sensitive", backends={"sllm": Sllm(port=18932)})
    assert out["windows"] == 0 and len(H.events("claim.assert")) == 0
