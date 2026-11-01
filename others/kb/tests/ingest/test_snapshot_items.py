"""snapshot 항목: url은 capture로 받고, --no-fetch는 24시간 안의 기존 스냅샷으로만 푼다(없으면 E_FETCH)."""
import time

from kb.collect.capturer import SnapshotRef

from .conftest import capture, res, run

URL = "https://example.org/page"


def snap_item(**kw):
    return {"item": "snapshot", "ref": "s1", "url": URL, "source": "src:adhoc", **kw}


def test_no_fetch_without_existing_snapshot_is_E_FETCH(env):
    r = run([snap_item()], fetch=False)
    assert res(r, "s1")["code"] == "E_FETCH"


def test_no_fetch_uses_snapshot_within_24h_only(env):
    now = int(time.time() * 1000)
    sid = capture(URL, b"# A\n\nbody text here\n", fetched_at=now - 3600_000)
    r = run([snap_item()], fetch=False)
    assert res(r, "s1")["result"] == "accepted" and res(r, "s1")["would_be"]["snapshot"] == sid


def test_no_fetch_ignores_older_snapshot(env):
    capture(URL, b"# A\n\nbody text here\n", fetched_at=int(time.time() * 1000) - 48 * 3600_000)
    assert res(run([snap_item()], fetch=False), "s1")["code"] == "E_FETCH"


def test_fetch_uses_capture_and_maps_outcomes(env, monkeypatch):
    calls = []

    def fake(src, url, **kw):
        calls.append((src.id, url, kw.get("reuse_s")))
        if "bad" in url:
            return SnapshotRef(source=src.id, url=url, outcome="error", error="boom")
        if "robots" in url:
            return SnapshotRef(source=src.id, url=url, outcome="robots_denied")
        sid = capture(url, b"# A\n\nbody text here\n", fetched_at=int(time.time() * 1000))
        return SnapshotRef(source=src.id, url=url, outcome="captured", snapshot=sid, new=True)

    monkeypatch.setattr("kb.collect.capturer.capture", fake)
    r = run([snap_item(), snap_item(ref="s2", url="https://example.org/bad"), snap_item(ref="s3", url="https://example.org/robots")],
            fetch=True)
    assert res(r, "s1")["result"] == "accepted"
    assert res(r, "s2")["code"] == "E_FETCH" and res(r, "s3")["code"] == "E_POLICY"
    assert calls[0] == ("src:adhoc", URL, 86400.0)                       # 24시간 안의 같은 URL 스냅샷은 재사용


def test_snapshot_by_unknown_id(env):
    r = run([{"item": "snapshot", "ref": "s1", "snapshot": "n-0000000000000000", "source": "src:adhoc"}])
    assert res(r, "s1")["code"] == "E_REF"


def test_snapshot_needs_url_or_id(env):
    assert res(run([{"item": "snapshot", "ref": "s1", "source": "src:adhoc"}]), "s1")["code"] == "E_SCHEMA"
