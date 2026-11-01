import json
import os
import subprocess
import sys

KEYS = {"id", "version", "seq", "replayed", "projected", "spooled", "held", "warnings", "reason"}


def claim_count():
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    c = connect_ro(current_gold_path())
    try:
        return c.execute("SELECT count(*) FROM node WHERE type='Claim' AND expired_at IS NULL").fetchone()[0]
    finally:
        c.close()


def test_put_rejects_external_fact_fields(server):
    for extra in ({"source_url": "https://x.example/"}, {"quote": "q"}):
        text, err, _ = server.call("kb_put", record={"title": "t", "body": "b", **extra}, idempotency_key="scope-bad")
        assert err and "schema_invalid" in text
    text, err, _ = server.call("kb_put", record={"title": "t", "body": "b", "author": "user:sagae"}, idempotency_key="scope-bad2")
    assert err and "schema_invalid" in text
    text, err, _ = server.call("kb_put", record={"title": "t", "body": "b"})   # 멱등 키 필수
    assert err


def test_put_response_matches_contract(server):
    text, err, _ = server.call("kb_put", record={"type": "Artifact", "title": "응답 필드 시험", "body": "본문 hooks"},
                               idempotency_key="scope-ok-1")
    assert not err
    r = json.loads(text)
    assert set(r) == KEYS and r["version"] == 1 and r["replayed"] is False and r["held"] is False and r["id"].startswith("f-")
    text2, _, _ = server.call("kb_put", record={"type": "Artifact", "title": "응답 필드 시험", "body": "본문 hooks"},
                              idempotency_key="scope-ok-1")
    r2 = json.loads(text2)
    assert r2["replayed"] is True and r2["id"] == r["id"]
    text3, err3, _ = server.call("kb_put", record={"type": "Artifact", "title": "다른 내용", "body": "x"}, idempotency_key="scope-ok-1")
    assert err3


def test_agent_session_is_generated(server, kbenv):
    from kb import read
    text, err, _ = server.call("kb_put", record={"title": "세션 값", "body": "b"}, idempotency_key="scope-sess")
    rid = json.loads(text)["id"]
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    with read.reading(ctx) as con:
        d = read.get_node(con, ctx, rid)
    assert d["author"].startswith("agent:s-") and d["on_behalf_of"] == "user:sagae"


def test_request_accumulates_urls_and_makes_no_claims(server, kbenv):
    before = claim_count()
    r1 = json.loads(server.call("kb_request", topic="YPP 신규 진입 기준 변경", reason="채널 설계", priority="high",
                                url="https://support.google.com/youtube/answer/72851")[0])
    r2 = json.loads(server.call("kb_request", topic="ypp 신규 진입 기준  변경", reason="재확인",
                                url="https://blog.youtube/news-and-events/ypp")[0])
    assert r1["status"] == "queued" and r1["duplicates"] == 0
    assert r2["ticket"] == r1["ticket"] and r2["duplicates"] == 1
    other = json.loads(server.call("kb_request", topic="전혀 다른 요청 주제입니다", reason="r")[0])
    assert other["ticket"] != r1["ticket"]
    from kb import read
    from kb.read.nodes import _json
    ctx = read.ReadCtx.build(max_sensitivity="internal")
    with read.reading(ctx) as con:
        d = read.get_node(con, ctx, r1["ticket"], include=())
    assert d["props"]["urls"] == ["https://support.google.com/youtube/answer/72851", "https://blog.youtube/news-and-events/ypp"]
    assert claim_count() == before
    # kb request CLI가 같은 티켓을 병합한다
    p = subprocess.run([sys.executable, "-m", "kb", "request", "YPP 신규 진입 기준 변경", "--reason", "CLI", "--url",
                        "https://example.org/ypp-cli", "--json"], capture_output=True, text=True, env=dict(os.environ), timeout=60)
    assert p.returncode == 0, p.stderr
    r3 = json.loads(p.stdout)
    assert r3["ticket"] == r1["ticket"] and r3["duplicates"] == 1
    with read.reading(ctx) as con:
        d = read.get_node(con, ctx, r1["ticket"], include=())
    assert d["props"]["urls"][-1] == "https://example.org/ypp-cli"
    assert claim_count() == before


def test_request_rejects_bad_url(server):
    text, err, _ = server.call("kb_request", topic="나쁜 URL 주제", reason="r", url="file:///etc/passwd")
    assert err and "schema_invalid" in text
