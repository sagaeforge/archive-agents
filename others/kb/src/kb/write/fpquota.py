"""ADR-0005 §5.8: ledger receiving budget and durable spool accounting.

The gate, when needed, must be acquired before lock(). Never wait for a gate
while holding this lock. Timeout spooling needs only this lock.
"""
from __future__ import annotations

import fcntl
import json
import os
import time
from contextlib import contextmanager
from contextvars import ContextVar

from kb.core import cas, ledger, paths
from kb.core.canon import canon_json
from kb.write.errors import WriteRejected

identity = ContextVar("fpapi_identity", default=None)
rejection = ContextVar("fpapi_rejection", default=None)
DAY = 86_400_000
TOKEN_BYTES = 32_000_000
RECORD_BYTES = 8_000_000
TOKEN_RETAINED = 64 * 1024 * 1024
GLOBAL_RETAINED = 256 * 1024 * 1024


def reject(code, status, retry=None):
    # The record layer replaces exception text/instances. Keep only trusted
    # protocol metadata in the request's context for the HTTP adapter.
    rejection.set({"code": code, "status": status, "retry": retry})
    exc = WriteRejected(code)
    exc.status = status
    exc.retry_after = retry
    raise exc


@contextmanager
def lock():
    path = paths.spool_dir().parent / "run" / "fpapi-quota.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def refs_dir():
    return paths.spool_dir() / "refs"


def rows():
    result = []
    for path in sorted(refs_dir().glob("*.json")):
        # Malformed accounting is fail-closed, never silently free capacity.
        value = json.loads(path.read_bytes())
        result.append((path, value))
    return result


def save(path, value):
    cas.make_dirs(path.parent)
    temp = cas.write_temp(path.parent, canon_json(value))
    try:
        os.replace(temp, path)
        cas.fsync_dir(path.parent)
    finally:
        cas.unlink_quiet(temp)


def event_bytes(payload):
    size = len(canon_json(payload))
    sha = payload.get("body_sha")
    if sha:
        # CAS is compressed; budgets measure the raw/fp object actually retained.
        size += cas.path_of(sha, "fp").stat().st_size
    return size


def uncommitted(led, events):
    """Committed keys are never capacity reservations, including timeout retries."""
    return [ev for ev in events if not led.execute("SELECT 1 FROM event WHERE idem_key=?",
                                                  (ev["idem_key"],)).fetchone()]


def receiving(led, events, *, extra_bytes=None, exclude_ref=None, now_ms=None):
    from kb.write.engine import storage_payload
    fresh = uncommitted(led, events)
    if not fresh:
        return []
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    pending = [value for path, value in rows()
               if path.stem != exclude_ref and value["state"] in ("pending", "held")
               and uncommitted(led, [{"idem_key": key} for key in value["idem_keys"]])]
    for ev in fresh:
        actor, subject = ev["actor"], ev["subject"]
        actor_size = sum(r["bytes"] for r in pending if r["actor"] == actor)
        record_size = sum(r["bytes"] for r in pending if r["subject"] == subject)
        expirations = []
        for other_actor, other_subject, sha, at in led.execute(
                "SELECT actor,subject,payload_sha,at FROM event WHERE at>? AND (actor=? OR subject=?)",
                (now - DAY, actor, subject)):
            payload = ledger.get_payload(led, sha)
            if payload is None:
                continue
            size = event_bytes(payload)
            expirations.append((at, size, other_actor, other_subject))
            if other_actor == actor:
                actor_size += size
            if other_subject == subject:
                record_size += size
        if extra_bytes is None:
            view = storage_payload(ev["payload"])
            incoming = len(canon_json(view))
            if "body_sha" in view:
                if "body" in ev["payload"]:
                    # Use the existing CAS encoder without writing an object before checks.
                    incoming += len(cas._encode(ev["payload"]["body"].encode()))
                else:
                    incoming += cas.path_of(view["body_sha"], "fp").stat().st_size
        else:
            incoming = extra_bytes
        if actor_size + incoming > TOKEN_BYTES or record_size + incoming > RECORD_BYTES:
            def release_after(excess, column, match):
                if excess <= 0:
                    return 0
                for at, size, owner, record_id in sorted(expirations):
                    if (owner if column == "actor" else record_id) == match:
                        excess -= size
                        if excess <= 0:
                            return max(1, (at + DAY - now + 999) // 1000)
                return 5  # pending reservations need state reconciliation, not expiry

            retry = max(release_after(actor_size + incoming - TOKEN_BYTES, "actor", actor),
                        release_after(record_size + incoming - RECORD_BYTES, "record", subject))
            reject("byte_quota_exceeded", 429, retry)
    return fresh


def retention(tok_id, incoming):
    from kb.write.write_refs import purge_one
    while True:
        retained = [(p, v) for p, v in rows() if v["state"] in ("pending", "held", "failed")]
        own = [(p, v) for p, v in retained if v["tok_id"] == tok_id]
        own_full = len(own) + 1 > 200 or sum(v["bytes"] for _, v in own) + incoming > TOKEN_RETAINED
        all_full = len(retained) + 1 > 400 or sum(v["bytes"] for _, v in retained) + incoming > GLOBAL_RETAINED
        if not own_full and not all_full:
            return
        candidates = [(p, v) for p, v in (retained if all_full else own) if v["state"] == "failed"]
        if not candidates:
            reject("spool_full", 503, 5)
        path, value = min(candidates, key=lambda item: item[1]["created_at"])
        purge_one(path, value)


def reserve(led, events, body, name, spool_kind):
    """Caller owns quota lock throughout durable ref → durable spool body."""
    from kb.core import spool
    path = refs_dir() / (name + ".json")
    if path.exists():
        value = json.loads(path.read_bytes())
        if value["state"] not in ("pending", "held"):
            reject("content_removed", 410)
    fresh = uncommitted(led, events)
    if not fresh:
        return None
    if path.exists():
        from kb.write.engine import core_of
        existing_path = spool.dir_of(value.get("spool_kind", spool_kind)) / path.name
        existing = json.loads(existing_path.read_bytes())
        if canon_json(core_of(existing["events"])) != canon_json(core_of(events)):
            raise spool.SpoolConflict("기존 예약과 다른 쓰기")
        # A retry returns the original durable reservation/body, never a rewrite.
        return name
    info = identity.get()
    if info is None:
        spool.put(spool_kind, {**body, "events": fresh}, name)
        return None
    events = fresh
    body = {**body, "events": events}
    size = len(canon_json(body))
    receiving(led, events, extra_bytes=size)
    retention(info["tok_id"], size)
    primary = events[0]
    value = {"state": "pending", "tok_id": info["tok_id"], "actor": primary["actor"],
             "subject": primary["subject"], "kind": "create" if primary.get("editor_create") else "edit",
             "bytes": size, "idem_keys": [e["idem_key"] for e in events],
             "created_at": int(time.time() * 1000), "spool_kind": spool_kind}
    save(path, value)
    spool.put(spool_kind, body, name)
    return name
