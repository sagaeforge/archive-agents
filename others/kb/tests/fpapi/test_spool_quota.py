"""5.8: durable reservations, separate daily/retained budgets, purge/recovery.

Lifecycle seam proposed for FW4: write_refs.recover(now_ms=...), purge(now_ms=...).
Only lifecycle tests use this seam; HTTP and fsync assertions use real public entrypoints.
"""
import json
import os
import time
from pathlib import Path

import pytest

from kb.core import spool
from kb.write import engine
from test_http_write import api, data, header, problem  # noqa: F401
from test_write_core import REC, core  # noqa: F401
from test_write_ref import held, fail_held

DAY = 86_400_000
MIB = 1024 * 1024


def reservation(path, **changes):
    value = json.loads(path.read_text())
    value.update(changes)
    path.write_text(json.dumps(value))
    return value


@pytest.mark.parametrize("mode", ["held", "spooled"])
def test_reservation_fsync_then_body_fsync_before_202(api, monkeypatch, mode):
    token = api.token()
    if mode == "held":
        monkeypatch.setattr(engine, "fp_is_open", lambda _: False)
    else:
        def busy(*args, **kwargs):
            raise TimeoutError("synthetic gate timeout")

        monkeypatch.setattr(engine.Gate, "acquire", busy)
    seen = []
    original = os.fsync

    def fsync(fd):
        # Linux /proc identifies the actual durable file/dir, including temporary names.
        path = Path(os.readlink(f"/proc/self/fd/{fd}"))
        original(fd)
        seen.append(path)

    monkeypatch.setattr(os, "fsync", fsync)
    response = api.create(token)
    assert response.status == 202, response.body
    result = data(response)
    assert result["held" if mode == "held" else "spooled"] is True
    assert header(response, "cache-control") == "no-store"
    refs = api.home / "spool" / "refs"
    bodies = api.home / "spool" / ("fp-held" if mode == "held" else "in")
    ref_sync = next(i for i, p in enumerate(seen) if p.parent == refs)
    body_sync = next(i for i, p in enumerate(seen) if p.parent == bodies)
    assert ref_sync < body_sync
    assert refs in seen and bodies in seen
    assert (refs / (result["write_ref"] + ".json")).is_file()
    assert list(bodies.glob("*.json"))


@pytest.mark.parametrize("state", ["pending", "held", "failed"])
def test_daily_limit_counts_pending_held_but_not_failed(api, monkeypatch, state):
    token = api.token()
    _, path = held(api, monkeypatch, token)
    # Accounting fixture: bytes includes the durable request plus any retained copies.
    reservation(path, state=state, bytes=32_000_000)
    response = api.create(token, key="loupe:c:second-reservation")
    if state == "failed":
        assert response.status == 202
    else:
        problem(response, 429, "byte_quota_exceeded")
    assert json.loads(path.read_text())["state"] == state


@pytest.mark.parametrize("dimension,limit", [("token_count", 200), ("global_count", 400),
                                           ("global_bytes", 256 * MIB)])
def test_retained_cap_with_no_failed_to_purge_is_503(api, monkeypatch, dimension, limit):
    token = api.token()
    value, path = held(api, monkeypatch, token)
    template = json.loads(path.read_text())
    # Use multiple actors/subjects to isolate disk quotas from the 32 MB/8 MB daily quotas.
    count = limit if dimension.endswith("count") else 12
    total = limit if dimension.endswith("bytes") else count
    for index in range(count):
        row = dict(template, state="held", subject=f"f-held-{index}",
                   bytes=total // count + (1 if index < total % count else 0),
                   idem_keys=[f"fw4:held:{index}"])
        if dimension.startswith("global"):
            row.update(tok_id=f"synthetic-other-{index}", actor=f"app:other-{index}")
        (path.parent / f"synthetic-{index}.json").write_text(json.dumps(row))
    path.unlink()
    # Each global actor remains below 32 MB so the disk cap is tested independently.
    response = api.create(token, key="loupe:c:disk-full")
    problem(response, 503, "spool_full")
    assert header(response, "retry-after")


def test_pressure_purges_oldest_failed_before_rejecting(api, monkeypatch):
    token = api.token()
    first, old_path, old_body = fail_held(api, monkeypatch, token, key="loupe:c:old")
    second, new_path, new_body = fail_held(api, monkeypatch, token, key="loupe:c:new")
    now = int(time.time() * 1000)
    reservation(old_path, bytes=32 * MIB, created_at=now - 2000)
    reservation(new_path, bytes=32 * MIB, created_at=now - 1000)
    response = api.create(token, key="loupe:c:pressure")
    assert response.status == 202
    assert json.loads(old_path.read_text())["state"] == "purged"
    assert not old_body.exists()
    assert json.loads(new_path.read_text())["state"] == "failed" and new_body.exists()
    assert first["write_ref"] != second["write_ref"]


def test_failed_purge_at_seven_days_and_metadata_retained_thirty_days(api, monkeypatch):
    from kb.write import write_refs
    token = api.token()
    value, path, body = fail_held(api, monkeypatch, token)
    created = int(time.time() * 1000)
    reservation(path, created_at=created)
    write_refs.purge(now_ms=created + 7 * DAY - 1)
    assert body.exists() and json.loads(path.read_text())["state"] == "failed"
    purged = created + 7 * DAY
    write_refs.purge(now_ms=purged)
    assert not body.exists() and json.loads(path.read_text())["state"] == "purged"
    write_refs.purge(now_ms=purged + 30 * DAY - 1)
    assert path.exists()
    write_refs.purge(now_ms=purged + 30 * DAY + 1)
    assert not path.exists()
    problem(api.call("GET", f'/v1/writes/{value["write_ref"]}', token), 404, "not_found")


def test_purge_fsyncs_deleted_body_directory_before_marking_purged(api, monkeypatch):
    token = api.token()
    value, path, body = fail_held(api, monkeypatch, token)
    observations = []
    original = os.fsync

    def fsync(fd):
        target = Path(os.readlink(f"/proc/self/fd/{fd}"))
        if target == body.parent:
            observations.append((body.exists(), json.loads(path.read_text())["state"]))
        original(fd)

    monkeypatch.setattr(os, "fsync", fsync)
    assert api.call("DELETE", f'/v1/writes/{value["write_ref"]}', token).status == 200
    assert (False, "failed") in observations
    assert json.loads(path.read_text())["state"] == "purged"


def test_missing_spool_recovery_preserves_lost_before_spool_code(api, monkeypatch):
    from kb.write import write_refs
    token = api.token()
    value, path = held(api, monkeypatch, token)
    reservation(path, state="pending")
    for body in (api.home / "spool" / "fp-held").glob("*.json"):
        spool.remove(body)
    write_refs.recover(now_ms=int(time.time() * 1000))
    result = json.loads(path.read_text())
    assert result["state"] == "purged" and result["code"] == "lost_before_spool"
    response = api.call("GET", f'/v1/writes/{value["write_ref"]}', token)
    assert response.status == 200 and data(response)["data"]["code"] == "lost_before_spool"


def test_recovery_waits_for_live_reservation_quota_lock(api, monkeypatch):
    import fcntl
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from kb.write import write_refs
    token = api.token()
    value, path = held(api, monkeypatch, token)
    reservation(path, state="pending")
    bodies = list((api.home / "spool" / "fp-held").glob("*.json"))
    body = next(p for p in bodies if value["id"] in p.read_text())
    content = body.read_bytes()
    body.unlink()
    lock_path = api.home / "run" / "fpapi-quota.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    entered = threading.Event()
    with lock_path.open("a+") as lock, ThreadPoolExecutor(max_workers=1) as executor:
        fcntl.flock(lock, fcntl.LOCK_EX)

        def recover():
            entered.set()
            return write_refs.recover(now_ms=int(time.time() * 1000))

        future = executor.submit(recover)
        try:
            assert entered.wait(2)
            # A live writer still owns the lock between durable ref and durable body.
            time.sleep(0.05)
            assert not future.done()
            assert json.loads(path.read_text())["state"] == "pending"
            body.write_bytes(content)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
        future.result(timeout=5)
    assert json.loads(path.read_text())["state"] == "pending"
