"""safe_fetch: 우회 15건 + 리다이렉트 사설 주소 + gzip 폭탄 + 크기 초과 + 특수 주소 + 전체 마감 + urlopen 0건."""
import json
import socket
import subprocess
from pathlib import Path

import pytest

from kb.collect import fetch
from kb.collect.errors import Blocked
from kb.collect.fetch import safe_fetch

REPO = Path(__file__).resolve().parents[2]
BYPASS = json.loads((REPO / "tests/fixtures/fetch/bypass.json").read_text())


@pytest.fixture(autouse=True)
def _share(env):
    return env


@pytest.fixture
def no_net(monkeypatch):
    """진짜 연결 시도를 실패시킨다. 검사에서 막혀야 하는 URL이 연결까지 가면 시험이 깨진다."""
    def boom(*a, **k):
        raise AssertionError("네트워크 연결 시도")
    monkeypatch.setattr(fetch.PinnedHTTPS, "connect", boom)


@pytest.mark.parametrize("case", BYPASS, ids=[c["url"] for c in BYPASS])
def test_bypass_blocked(case, no_net):
    assert len(BYPASS) == 15
    with pytest.raises(Blocked) as ei:
        safe_fetch(case["url"], source=None)
    assert ei.value.kind == case["reason"], str(ei.value)


@pytest.mark.parametrize("url", ["https://224.0.0.1/", "https://[ff02::1]/", "https://[fec0::1]/",
                                 "https://[::7f00:1]/", "https://[64:ff9b::7f00:1]/", "https://[::ffff:10.x.x.x]/",
                                 "https://[2002:7f00:1::]/", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/"])
def test_special_addresses_blocked(url, no_net):
    with pytest.raises(Blocked) as ei:
        safe_fetch(url)
    assert ei.value.kind == "addr"


def test_redirect_to_private_blocked(world):
    world.add("a.example", "/", 302, headers={"Location": "https://internal.example/x"})
    world.dns["internal.example"] = ["10.x.x.x"]
    world.add("internal.example", "/x", 200, b"secret", ip="10.x.x.x")
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/")
    assert ei.value.kind == "addr"
    assert world.count("internal.example") == 0          # 사설 주소로는 연결하지 않았다


def test_redirect_to_literal_loopback_blocked(world):
    world.add("a.example", "/", 301, headers={"Location": "https://127.0.0.1/"})
    with pytest.raises(Blocked):
        safe_fetch("https://a.example/")


def test_redirect_hop_scheme_and_limit(world):
    world.add("a.example", "/", 302, headers={"Location": "http://a.example/"})
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/")
    assert ei.value.kind == "scheme"
    world.add("b.example", "/", 302, headers={"Location": "https://b.example/"})
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://b.example/")
    assert str(ei.value).startswith("redirect:too_many")
    assert world.count("b.example") == 6                  # 최초 1 + 리다이렉트 5


def test_redirect_ok_records_chain(world):
    world.add("a.example", "/", 302, headers={"Location": "/final"})
    world.add("a.example", "/final", 200, b"hello", headers={"Content-Type": "text/plain"})
    f = safe_fetch("https://a.example/")
    assert f.status == 200 and f.body == b"hello" and f.url == "https://a.example/final"
    assert [c[1] for c in f.chain] == [302, 200]


def test_gzip_bomb_blocked(world):
    # 30 MB의 0은 gzip으로 수십 KB. 압축본은 상한 안이지만 해제 후 20 MB를 넘는다
    world.add("a.example", "/bomb", 200, b"\0" * 30_000_000, gz=True)
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/bomb")
    assert str(ei.value).startswith("too_large:gunzip")


def test_gzip_ok_within_limit(world):
    world.add("a.example", "/g", 200, b"x" * 100_000, gz=True)
    assert len(safe_fetch("https://a.example/g").body) == 100_000


def test_size_exceeded(world):
    world.add("a.example", "/big", 200, b"x" * 2000, headers={"Content-Length": "999999999"})
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/big")
    assert str(ei.value).startswith("too_large")
    world.add("a.example", "/stream", 200, b"x" * 200_000)
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/stream", max_bytes=100_000)
    assert str(ei.value).startswith("too_large")


def test_slow_response_total_deadline(world, clk):
    # 청크마다 5초가 걸린다. 소켓 호출당 시간 초과로는 안 걸리지만 전체 마감 20초에 걸린다
    world.add("a.example", "/slow", 200, b"x" * 1_000_000, read_cost=5.0, chunk=1000)
    with pytest.raises(Blocked) as ei:
        safe_fetch("https://a.example/slow")
    assert ei.value.kind == "deadline"
    assert clk.t > 0


def test_user_agent_has_no_contact(world):
    world.add("a.example", "/", 200, b"x")
    safe_fetch("https://a.example/")
    ua = world.requests[0]["headers"]["User-Agent"]
    assert ua.startswith("kb-collector/") and "@" not in ua


def test_connect_to_private_peer_blocked(monkeypatch):
    """getpeername 재검사: 해석은 공인이었지만 연결된 상대가 사설이면 닫는다(DNS 재바인딩)."""
    closed = []

    class S:
        def __init__(self, *a):
            pass
        def settimeout(self, t): pass
        def connect(self, sa): pass
        def getpeername(self): return ("10.x.x.x", 443)
        def close(self): closed.append(1)

    monkeypatch.setattr(socket, "socket", S)
    c = fetch.PinnedHTTPS("a.example", 443, (socket.AF_INET, ("93.184.216.34", 443)), 5)
    with pytest.raises(Blocked):
        c.connect()
    assert closed


def test_no_urlopen_in_source():
    r = subprocess.run(["rg", "-n", r"urlopen|urllib\.request|requests\.|httpx|aiohttp", str(REPO / "src/kb")],
                       capture_output=True, text=True)
    assert r.returncode == 1, r.stdout
