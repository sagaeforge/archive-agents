"""서킷: 429, 403, 봇 확인 본문이 호스트 서킷을 연다. 404 단일 관측은 판정하지 않는다."""
import pytest

from kb.collect import capture
from kb.collect.state import State

from .conftest import events, mk_source

H = 3600


def circuit(host):
    with State() as st:
        return st.c.execute("SELECT state, opened_at, until_at, trips FROM circuit WHERE host=?", (host,)).fetchone()


@pytest.fixture
def src(set_registry, world):
    world.add("h.example", "/robots.txt", 404)
    set_registry([mk_source("src:h", urls=["https://h.example/a", "https://h.example/b"])])
    return "src:h"


@pytest.mark.parametrize("status,body,ctype", [
    (429, b"slow down", "text/plain"),
    (403, b"forbidden", "text/html"),
    (200, b"<html><title>Sign in to confirm you're not a bot</title></html>", "text/html"),
])
def test_block_opens_host_circuit(src, world, clk, status, body, ctype):
    world.add("h.example", "/a", status, body, headers={"Content-Type": ctype})
    r = capture(src, "https://h.example/a")
    assert r.outcome == "blocked" and r.until
    row = circuit("h.example")
    assert row[0] == "open" and row[2] - row[1] >= H * 1000
    n = world.count("h.example", "/a")
    r2 = capture(src, "https://h.example/b")           # 같은 호스트의 다른 URL도 막힌다
    assert r2.outcome == "circuit_open"
    assert world.count("h.example", "/b") == 0 and world.count("h.example", "/a") == n
    assert not events("snapshot.captured")


def test_circuit_reopens_after_expiry_and_repeat_is_7_days(src, world, clk):
    world.add("h.example", "/a", 429, b"x", headers={"Content-Type": "text/plain"})
    capture(src, "https://h.example/a")
    first = circuit("h.example")
    assert first[2] - first[1] == H * 1000 and first[3] == 1
    clk.advance(H + 5)
    r = capture(src, "https://h.example/a")             # 서킷이 닫혔으니 다시 시도하고 또 막힌다
    assert r.outcome == "blocked"
    rep = circuit("h.example")
    assert rep[2] - rep[1] == 7 * 24 * H * 1000 and rep[3] == 2


def test_bot_phrase_inside_big_page_is_not_a_block(src, world):
    page = b"<html><title>yt-dlp issue</title><body>" + b"x" * 80_000 + b"Sign in to confirm you're not a bot</body></html>"
    world.add("h.example", "/a", 200, page, headers={"Content-Type": "text/html"})
    assert capture(src, "https://h.example/a").outcome == "captured"
    assert circuit("h.example") is None


def test_single_404_is_not_a_verdict(src, world, clk):
    world.add("h.example", "/a", 404, b"nope", headers={"Content-Type": "text/plain"})
    r = capture(src, "https://h.example/a")
    assert r.outcome == "suspect"
    with State() as st:
        row = st.get("src:h", "https://h.example/a")
    assert row["state"] == "suspect" and row["fail_count"] == 1
    assert circuit("h.example") is None
    r = capture(src, "https://h.example/a")             # 같은 시간대의 두 번째 관측은 세지 않는다
    assert r.outcome == "suspect" and "1/3" in r.error


def test_404_three_distinct_windows_is_gone(set_registry, world, clk):
    world.add("h.example", "/robots.txt", 404)
    world.add("h.example", "/idx", 404, b"nope", headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:i", "https://h.example/idx")])
    out = []
    for _ in range(3):
        out.append(capture("src:i", "https://h.example/idx").outcome)
        clk.advance(7 * H)
    assert out == ["suspect", "suspect", "gone"]
    st = [e for e in events("source.status") if e["payload"]["id"] == "src:i"]
    assert len(st) == 1 and st[0]["payload"]["state"] == "gone"


def test_5xx_retries_three_times_then_backoff(src, world, clk):
    world.add("h.example", "/a", 503, b"down", headers={"Content-Type": "text/plain", "Retry-After": "2"})
    r = capture(src, "https://h.example/a")
    assert r.outcome == "error" and world.count("h.example", "/a") == 3
    assert 2.0 in clk.sleeps
    with State() as st:
        row = st.get("src:h", "https://h.example/a")
    assert row["fail_count"] == 1 and row["next_check_at"] > clk.now_ms()
