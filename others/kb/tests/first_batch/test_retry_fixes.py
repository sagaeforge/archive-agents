"""WP-21 재시도 수정: window_sha는 CAS 참조가 아니다, --batch 강제는 run_tick당 1회, 생존 미도달 이유, 304는 살아 있음."""
from types import SimpleNamespace

from collect.conftest import events, mk_source  # noqa: F401
from collect.test_tick import tick  # noqa: F401
from kb.commands import verify
from kb.core import cas
from kb.live import probe, runner


def test_window_sha_is_not_a_cas_reference():
    assert "window_sha" not in verify.CAS_KEYS


def test_batch_until_idle_forces_each_url_once(world, set_registry):
    world.add("a.example", "/robots.txt", 404)
    bodies = iter(range(1000))
    world.route_fn("a.example", "/doc", lambda *a, **k: dict(status=200, body=f"매번 다른 본문 {next(bodies)}".encode(),
                                                             headers={"Content-Type": "text/plain"}))
    world.add("b.example", "/robots.txt", 404)
    world.add("b.example", "/doc", 200, "고정".encode(), headers={"Content-Type": "text/plain"})
    world.add("b.example", "/p2", 200, "둘째 쪽".encode(), headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:a", "https://a.example/doc", cls="docs"),
                  mk_source("src:b", "https://b.example/doc", urls=["https://b.example/p2"], cls="docs")])
    rep, _ = tick(batch=["src:a", "src:b"], until_idle=True)
    snaps = [e for e in events("snapshot.captured") if e["payload"]["source"] == "src:a"]
    assert len(snaps) == 1
    assert rep["sources"] == 2
    # 새 run_tick은 다시 강제한다
    tick(batch=["src:a"], until_idle=True)
    assert len([e for e in events("snapshot.captured") if e["payload"]["source"] == "src:a"]) == 2


class _Fx:
    def __init__(self, reason):
        self.reason = reason

    def get(self, url):
        return None

    def why(self, url):
        return self.reason


def _doc(i):
    return {"id": f"e:document:{i}", "type": "document", "label": f"d{i}", "props": {"url": f"https://x.example/{i}"}, "liveness": None}


def test_unreachable_reasons_are_counted(env):
    t = [_doc(1), _doc(2), {"id": "e:document:3", "type": "document", "label": "d3", "props": {}, "liveness": None}]
    s = runner.run(t, _Fx("budget_exceeded"), dry_run=True, con=None, now=1793500000000)
    assert s["unreachable"] == 3
    assert s["unreachable_reasons"] == {"budget_exceeded": 2, "no_probe": 1}


def test_http_error_reason():
    fx = probe.OfflineFetcher({"https://x.example/1": {"status": 500}})
    s = runner.run([_doc(1)], fx, dry_run=True, con=None, now=1793500000000)
    assert s["unreachable_reasons"] == {"http_500": 1}


def test_capture_304_is_alive(env, monkeypatch):
    import kb.collect as kc
    from kb.collect.capturer import SnapshotRef
    sha = cas.put(b"<title>doc</title> body")
    src = SimpleNamespace(id="src:a")
    fx = probe.CaptureFetcher([src])
    monkeypatch.setattr(fx, "owner", lambda u: src)

    def fake(s, url):
        r = SnapshotRef(s.id, url, "not_modified")
        r.status, r.raw_sha, r.snapshot = 304, sha, "s-1"
        return r
    monkeypatch.setattr(kc, "capture", fake)
    r = fx.get("https://a.example/doc")
    assert r.ok and r.status == 200 and r.first_status == 200 and r.body
    s = runner.run([{**_doc(1), "props": {"url": "https://a.example/doc"}}], fx, dry_run=True, con=None, now=1793500000000)
    assert s["checked"] == 1 and s["unreachable"] == 0


def test_budget_exceeded_retries_within_an_hour(env):
    from kb.core import opsdb
    now = 1793500000000
    t = {**_doc(1), "recorded_at": now}
    runner.run([t], _Fx("budget_exceeded"), con=None, now=now, check_sources=False)
    c = opsdb.connect()
    try:
        assert c.execute("SELECT next_at FROM queue WHERE kind='live' AND ref=?", (t["id"],)).fetchone()[0] <= now + 3600_000
    finally:
        c.close()
