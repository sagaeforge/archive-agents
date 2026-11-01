"""healthchecks 핑: URL이 있을 때만, 응답 본문이 정확히 OK일 때만 성공, 본문에 개인 정보 없음."""
import json
import os

import pytest

from kb.collect import fetch as _fetch
from kb.guard import tick_stage_watch, watchdog

URL = "https://hc-ping.com/00000000-0000-0000-0000-000000000000"


class Resp:
    def __init__(self, body=b"OK", status=200):
        self.body, self.status = body, status


class Fake:
    def __init__(self, resp):
        self.resp, self.calls = resp, []

    def __call__(self, url, *, source=None, headers=None, data=None, method=None, **kw):
        self.calls.append({"url": url, "data": data, "method": method})
        return self.resp


@pytest.fixture
def with_url(env):
    p = env.cfg / "secrets.env"
    p.write_text(f"HC_PING_TICK={URL}\n")
    os.chmod(p, 0o600)


def vec(env):
    return watchdog.compute(1_800_000_000_000, uptime=0, decisions=set())


def test_no_url_means_zero_calls(env):
    f = Fake(Resp())
    assert watchdog.ping(vec(env), "tick", fetch=f) == {"sent": False, "reason": "no_url"}
    assert f.calls == []


def test_stage_without_url_does_not_touch_network(env, monkeypatch):
    f = Fake(Resp())
    monkeypatch.setattr(_fetch, "safe_fetch", f)
    r = tick_stage_watch.run_watchdog()
    assert r.ok and r.detail["ping"]["sent"] is False and f.calls == []


@pytest.mark.parametrize("body,status", [(b"OK", 200)])
def test_exact_ok_succeeds(env, with_url, body, status):
    r = watchdog.ping(vec(env), "tick", fetch=Fake(Resp(body, status)))
    assert r["sent"] and r["ok"] is True


@pytest.mark.parametrize("body,status", [(b"", 200), (b"ok", 200), (b"OK\n", 200), (b"OK (not found)", 200),
                                         (b"<html>captive portal</html>", 200), (b"OK", 500), (b"OK", 404)])
def test_anything_but_exact_ok_fails(env, with_url, body, status):
    r = watchdog.ping(vec(env), "tick", fetch=Fake(Resp(body, status)))
    assert r["sent"] and r["ok"] is False and r["error"]


def test_fetch_exception_is_failure_not_crash(env, with_url):
    def boom(url, **kw):
        raise TimeoutError("deadline")
    r = watchdog.ping(vec(env), "tick", fetch=boom)
    assert r["sent"] and r["ok"] is False and "TimeoutError" in r["error"]


def test_body_is_state_vector_without_personal_data(env, with_url):
    f = Fake(Resp())
    v = vec(env)
    watchdog.ping(v, "tick", fetch=f)
    call = f.calls[0]
    assert call["url"] == URL and call["method"] in (None, "POST")
    body = call["data"].decode()
    assert set(json.loads(body)) == {"seq", "head", "stale", "critical", "warnings"}
    for forbidden in ("@", "/home", str(env.home), os.environ.get("USER", "\0"), "sagae", "gmail"):
        assert forbidden not in body, forbidden


def test_get_only_fetch_still_pings(env, with_url):
    calls = []

    def get_only(url, *, source=None, headers=None, **kw):
        calls.append(url)
        return Resp()
    r = watchdog.ping(vec(env), "tick", fetch=get_only)
    assert r["ok"] is True and calls == [URL]


def test_wide_permissions_disable_ping(env):
    p = env.cfg / "secrets.env"
    p.write_text(f"HC_PING_TICK={URL}\n")
    os.chmod(p, 0o644)
    f = Fake(Resp())
    assert watchdog.ping(vec(env), "tick", fetch=f)["sent"] is False and f.calls == []
    assert "secrets_permission" in [x["code"] for x in watchdog.compute(1, uptime=0)["critical"]]
