"""Reviewer trust and WebAuthn boundary; real verification fails closed.

ADR-0005 6.8. Cryptographic verification delegates to py_webauthn 3.0.1's
public verify_authentication_response API. The dependency is loaded only
when a real assertion is verified; deployment owns its installation.
"""
from __future__ import annotations

import base64
import json
import os
import stat
import time
from pathlib import Path

from kb.write.errors import WriteRejected


class MissingWebAuthnDependency(RuntimeError):
    pass


def verify_authentication_response(**kwargs):
    """Thin adapter, never a substitute cryptographic implementation."""
    try:
        from webauthn import verify_authentication_response as verify
    except ImportError as exc:
        raise MissingWebAuthnDependency("Reviewer verification requires webauthn==3.0.1") from exc
    return verify(**kwargs)


class TrustFilesystem:
    """Conservative POSIX inspection: ACL-bearing paths fail closed."""
    def inspect(self, path):
        path = Path(path).absolute()
        result = {}
        for item in [*reversed(path.parents), path]:
            value = item.lstat()
            try:
                acl = bool(os.getxattr(item, "system.posix_acl_access", follow_symlinks=False))
            except OSError as exc:
                import errno
                if exc.errno not in (errno.ENODATA, errno.ENOTSUP):
                    raise
                acl = False
            result[str(item)] = dict(uid=value.st_uid, gid=value.st_gid,
                                     mode=stat.S_IMODE(value.st_mode), inode=value.st_ino,
                                     device=value.st_dev, symlink=stat.S_ISLNK(value.st_mode),
                                     regular=stat.S_ISREG(value.st_mode),
                                     directory=stat.S_ISDIR(value.st_mode), acl_writable=acl,
                                     writable_uids=[os.geteuid()] if os.access(item, os.W_OK, effective_ids=True) else [])
        return result

    def read(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise PermissionError("Reviewer trust requires a regular file")
            result = json.load(stream)
            after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size) != (
                after.st_dev, after.st_ino, after.st_mtime_ns, after.st_size):
            raise PermissionError("Reviewer trust changed during read")
        return result


_runtime = dict(trust_path=Path("/etc/sagae-kb/reviewers"), filesystem=TrustFilesystem(),
                service_uid=os.getuid(), agent_uids=[], clock=time.time,
                verify_authentication_response=verify_authentication_response)


def configure_runtime(*, trust_path, filesystem, service_uid, agent_uids, clock,
                      verify_authentication_response):
    """Explicit dependency injection; never invoked from an HTTP payload."""
    _runtime.update(trust_path=Path(trust_path), filesystem=filesystem, service_uid=service_uid,
                    agent_uids=list(agent_uids), clock=clock,
                    verify_authentication_response=verify_authentication_response)


def now():
    return _runtime["clock"]()


def reject(code="review_unverified", status=403):
    error = WriteRejected(code, "Reviewer verification failed")
    error.status = status
    raise error


def trust_status():
    """Expose only a fixed safe state, plus registered RP metadata."""
    fs, path = _runtime["filesystem"], _runtime["trust_path"]
    try:
        before = fs.inspect(path)
        denied_uids = {_runtime["service_uid"], *_runtime["agent_uids"]}
        for value in before.values():
            if (value["uid"] != 0 or value["gid"] != 0 or value["mode"] & 0o022
                    or value.get("symlink") or value.get("acl_writable")
                    or (value['uid'] in denied_uids and value['mode'] & 0o200)
                    or denied_uids.intersection(value.get("writable_uids", []))):
                return {"available": False, "trust_store": "unsafe", "rp_ids": []}, None
        content = fs.read(path)
        if before != fs.inspect(path):
            return {"available": False, "trust_store": "unsafe", "rp_ids": []}, None
        credentials = content["credentials"]
        entries = content["rp_entries"]
        if (not isinstance(credentials, dict) or not isinstance(entries, list)
                or any(not isinstance(key, str) or not isinstance(value, dict)
                       or not isinstance(value.get('rp_id'), str) or not isinstance(value.get('public_key'), str)
                       for key, value in credentials.items())
                or any(not isinstance(entry, dict) or not isinstance(entry.get('rp_id'), str)
                       or not isinstance(entry.get('allowed_origins'), list)
                       or not all(isinstance(origin, str) for origin in entry['allowed_origins']) for entry in entries)):
            raise ValueError('Invalid reviewer store schema')
        rp_ids = [dict(rp_id=e["rp_id"], allowed_origins=list(e["allowed_origins"]),
                       registered=any(c["rp_id"] == e["rp_id"] for c in credentials.values()))
                  for e in entries]
        return dict(available=any(e["registered"] for e in rp_ids), trust_store="ready", rp_ids=rp_ids), content
    except FileNotFoundError:
        return {"available": False, "trust_store": "missing", "rp_ids": []}, None
    except (OSError, ValueError, KeyError, TypeError):
        return {"available": False, "trust_store": "unreadable", "rp_ids": []}, None


def require_trust(*, require_registered=True):
    state, content = trust_status()
    if state['trust_store'] != 'ready' or (require_registered and not state["available"]):
        reject("review_trust_unavailable", 503)
    return content


def verify(assertion, challenge, stored_counter):
    """Verify only proof; the transaction owner binds state and consumes it."""
    store = require_trust()
    try:
        credential_id = assertion.get("credential_id") or assertion.get("id")
        credential = store["credentials"][credential_id]
        rp = credential["rp_id"]
        entry = next(e for e in store["rp_entries"] if e["rp_id"] == rp)
        if rp != challenge["rp_id"] or entry["allowed_origins"] != ["http://localhost:4812"]:
            reject()
        key = credential["public_key"]
        expected = challenge["challenge"]
        real = _runtime["verify_authentication_response"] is verify_authentication_response
        if real:
            key = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
            expected = base64.urlsafe_b64decode(expected + "=" * (-len(expected) % 4))
        result = _runtime["verify_authentication_response"](
            credential=assertion, expected_challenge=expected, expected_rp_id=rp,
            expected_origin="http://localhost:4812", credential_public_key=key,
            credential_current_sign_count=stored_counter, require_user_verification=True)
        if not result.user_verified or result.new_sign_count <= stored_counter:
            reject()
        return credential_id, result.new_sign_count
    except MissingWebAuthnDependency:
        reject("review_trust_unavailable", 503)
    except WriteRejected:
        raise
    except Exception:
        reject()
