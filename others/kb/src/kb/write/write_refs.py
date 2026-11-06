"""ADR-0005 §§5.8–5.9: issuer-owned status, draft recovery and purge."""
from __future__ import annotations

import json
import time
from contextlib import nullcontext

from kb.core import cas, ledger, paths
from kb.write import fpquota as Q


def _now():
    return int(time.time() * 1000)


def body_paths(path):
    # Cover failed copies as well as the primary body; refs are generated hashes.
    for kind in ("in", "fp-held"):
        directory = paths.spool_dir() / kind
        primary = directory / path.name
        if primary.exists():
            yield primary
        yield from (directory / ".failed").glob(path.stem + "*.json")


def purge_one(path, value, now_ms=None):
    for body in list(body_paths(path)):
        body.unlink(missing_ok=True)
        cas.fsync_dir(body.parent)
    value.update(state="purged", purged_at=_now() if now_ms is None else now_ms, bytes=0)
    Q.save(path, value)


def purge(*, now_ms=None):
    now = _now() if now_ms is None else now_ms
    with Q.lock():
        for path, value in Q.rows():
            if value["state"] == "failed" and now - max(value.get("failed_at", 0), value["created_at"]) >= 7 * Q.DAY:
                purge_one(path, value, now)
            elif value["state"] in ("committed", "purged"):
                at = value.get("purged_at", value.get("committed_at", value["created_at"]))
                if now - at >= 30 * Q.DAY:
                    path.unlink()
                    cas.fsync_dir(path.parent)


def recover(*, now_ms=None):
    """Read-only ledger reconciliation; no gate acquisition under the quota lock."""
    now = _now() if now_ms is None else now_ms
    led = ledger.open_ledger()
    try:
        with Q.lock():
            for path, value in Q.rows():
                if value["state"] not in ("pending", "held"):
                    continue
                keys = value["idem_keys"]
                committed = [led.execute("SELECT seq FROM event WHERE idem_key=?", (key,)).fetchone() for key in keys]
                if keys and all(committed):
                    value.update(state="committed", committed_at=now, bytes=0)
                    Q.save(path, value)
                elif not list(body_paths(path)):
                    value.update(state="failed", code="lost_before_spool", failed_at=now)
                    Q.save(path, value)
                    purge_one(path, value, now)
    finally:
        led.close()


def mark_events(events, state, code=None):
    keys = {e["idem_key"] for e in events}
    with Q.lock():
        for path, value in Q.rows():
            if set(value["idem_keys"]) != keys or value["state"] not in ("pending", "held"):
                continue
            value.update(state=state, **{state + "_at": _now()})
            if code:
                value["code"] = code
            if state == "committed":
                value["bytes"] = 0
            Q.save(path, value)


def failed_copy(path, *, locked=False):
    """Called after core.spool durably moves a body; other spool policies stay intact."""
    ref_path = Q.refs_dir() / path.name
    if not ref_path.exists():
        try:
            body = next(body_paths(ref_path))
            first = json.loads(body.read_bytes())["events"][0]
            if first.get("origin") != "first_party" or not first.get("actor", "").startswith("app:"):
                return
        except (StopIteration, ValueError, KeyError, TypeError, IndexError):
            return
    with (nullcontext() if locked else Q.lock()):
        if ref_path.exists():
            value = json.loads(ref_path.read_bytes())
        else:
            bodies = list(body_paths(ref_path))
            if not bodies:
                return
            try:
                obj = json.loads(bodies[0].read_bytes())
                events = obj["events"]
                first = events[0]
                if first.get("origin") != "first_party" or not first.get("actor", "").startswith("app:"):
                    return
            except (ValueError, KeyError, TypeError, IndexError):
                return  # Existing non-editor corrupt-spool policy remains unchanged.
            value = {"tok_id": first.get("fpapi_tok_id", "legacy:" + first["actor"]),
                     "actor": first["actor"], "subject": first["subject"],
                     "kind": "create" if first.get("editor_create") else "edit",
                     "idem_keys": [e["idem_key"] for e in events], "created_at": _now()}
        value.update(state="failed", failed_at=value.get("failed_at", _now()))
        value.setdefault("code", "idem_conflict")
        value["bytes"] = sum(body.stat().st_size for body in body_paths(ref_path))
        Q.save(ref_path, value)


def _visible(led, value):
    if value["kind"] == "create" and value["state"] != "committed":
        return  # Never inspect another head for an uncommitted create reference.
    from kb.write.record import _record_state
    _record_state(led, value["subject"])


def access(ref, *, include_body=False, delete=False):
    info = Q.identity.get()
    if not info or info["scope"] != "editor" or not ref or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in ref):
        Q.reject("not_found", 404)
    path = Q.refs_dir() / (ref + ".json")
    led = ledger.open_ledger()
    try:
        with Q.lock():
            try:
                value = json.loads(path.read_bytes())
            except FileNotFoundError:
                Q.reject("not_found", 404)
            if value["tok_id"] != info["tok_id"]:
                Q.reject("not_found", 404)
            if value["state"] in ("committed", "purged"):
                at = value.get("purged_at", value.get("committed_at", value["created_at"]))
                if _now() - at >= 30 * Q.DAY:
                    Q.reject("not_found", 404)
            _visible(led, value)
            if value["state"] == "failed" and _now() - max(value.get("failed_at", 0), value["created_at"]) >= 7 * Q.DAY:
                purge_one(path, value)
            state = value["state"]
            if delete:
                if state in ("pending", "held"):
                    Q.reject("write_in_flight", 409)
                if state == "failed":
                    purge_one(path, value)
                return {"state": value["state"]}
            result = {"ref": ref, "state": state, "id": value["subject"],
                      "version": None, "code": value.get("code")}
            if state == "committed":
                head = ledger.record_head(led, value["subject"])
                result["version"] = head[0] if head else None
            if include_body:
                if state == "purged":
                    Q.reject("content_removed", 410)
                if state != "failed":
                    Q.reject("bad_param", 400)
                bodies = list(body_paths(path))
                if not bodies:
                    Q.reject("content_removed", 410)
                obj = json.loads(bodies[0].read_bytes())
                payload = next(e["payload"] for e in obj["events"] if e["subject"] == value["subject"])
                if payload.get("sensitivity") == "secret" or (payload.get("props") or {}).get("quarantine"):
                    Q.reject("not_found", 404)
                from kb.core.canon import canon_json, sha256_hex
                from kb.write.engine import storage_payload
                result["payload_sha"] = sha256_hex(canon_json(storage_payload(payload)))
                result["record"] = dict(payload)
                # The writer omits empty links from canonical stored payloads.
                # Recovery returns a complete record without altering its hash.
                result["record"].setdefault("links", [])
            return {"data": result}
    finally:
        led.close()
