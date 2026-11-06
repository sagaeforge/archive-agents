"""First-party HTTP adapter; the engine remains the authority for writes."""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from collections import deque

from kb.core import opsdb
from kb.write import fpquota as Q

WRITE_PATH = re.compile(r"^/v1/records(?:/([^/]+)(/tombstone)?)?$")
REF_PATH = re.compile(r"^/v1/writes/([^/]+)$")
REVIEW_PATH = re.compile(r"^/v1/(?:hitl(?:/[^/]+(?:/resolve)?)?|actions(?:/[^/]+(?:/(?:execute|external-refine))?)?|reviewer/enroll)$")
ACTION_POLL = re.compile(r"^/v1/actions/([^/]+)$")
DETAILS = {
    "schema_invalid": "저장할 수 없는 값이 있습니다", "bad_param": "저장할 수 없는 값이 있습니다",
    "bad_json": "저장 요청이 깨졌습니다", "not_found": "문서를 찾을 수 없습니다",
    "token_required": "KB 쓰기 권한이 없습니다. 토큰을 다시 설정하세요",
    "token_invalid": "KB 쓰기 권한이 없습니다. 토큰을 다시 설정하세요",
    "scope_denied": "KB 쓰기 권한이 없습니다. 토큰을 다시 설정하세요",
    "version_conflict": "다른 곳에서 먼저 고쳤습니다", "idem_conflict": "저장 충돌. 다시 저장합니다",
    "write_in_flight": "아직 처리 중입니다", "declassify_requires_review": "공개 범위를 낮추려면 검토 확인이 필요합니다",
    "byte_quota_exceeded": "저장이 잠시 밀렸습니다", "spool_full": "KB가 바쁩니다",
    "body_too_large": "문서가 너무 큽니다(1 MiB)", "content_removed": "보관한 초안 본문이 삭제됐습니다",
    "secret_detected": "저장 거절: 비밀로 보이는 값", "too_many_requests": "저장이 잠시 밀렸습니다",
    "write_rate_limited": "저장이 잠시 밀렸습니다", "expected_version_required": "버그",
    "type_not_allowed": "이 종류는 편집기에서 만들 수 없습니다", "sensitivity_not_allowed": "이 공개 범위는 쓸 수 없습니다",
    "unsupported_media_type": "버그", "redacted_payload": "삭제된 내용과 같아 저장할 수 없습니다",
}


def error(status, code, path, *, current=None, retry=None, cfg=None, max_sens="internal"):
    from kb.serve.http import Resp, dumps, problem_dict, error_instance
    instance = error_instance(path, cfg, max_sens)
    value = problem_dict(status, code, DETAILS.get(code, "저장 요청을 처리할 수 없습니다"), instance)
    if current is not None:
        value["current"] = current
    headers = [("content-type", "application/problem+json"), ("cache-control", "no-store")]
    if retry is not None:
        headers.append(("retry-after", str(retry)))
    if status == 401:
        headers.append(("www-authenticate", "Bearer"))
    return Resp(status, headers, dumps(value))


def usage(info, *, write=False):
    """Disposable metrics; never an authorization or quota authority."""
    try:
        con = opsdb.connect()
        try:
            now = int(time.time() * 1000)
            dims = json.dumps({"label": info["label"]}, sort_keys=True)
            con.execute("INSERT INTO metric(at,name,dims,value) VALUES(?,?,?,?)",
                        (now, "fpapi.token.last_used", dims, now))
            if write:
                con.execute("INSERT INTO metric(at,name,dims,value) VALUES(?,?,?,1)",
                            (now, "fpapi.token.write", dims))
        finally:
            con.close()
    except (OSError, ValueError, opsdb.sqlite3.Error):
        pass  # loss of metrics must not grant capacity or fail an otherwise valid write


def token_usage():
    result = {}
    now = int(time.time() * 1000)
    try:
        con = opsdb.connect()
        try:
            for at, name, dims in con.execute("SELECT at,name,dims FROM metric WHERE name IN (?,?)",
                    ("fpapi.token.last_used", "fpapi.token.write")):
                label = json.loads(dims)["label"]
                row = result.setdefault(label, {"label": label, "last_used_at": None, "daily_writes": 0})
                if name == "fpapi.token.last_used":
                    row["last_used_at"] = max(row["last_used_at"] or 0, at)
                elif at > now - Q.DAY:
                    row["daily_writes"] += 1
        finally:
            con.close()
    except (OSError, ValueError, KeyError, opsdb.sqlite3.Error):
        pass
    return sorted(result.values(), key=lambda row: row["label"])


def dispatch(method, path, query, raw):
    from kb.serve.http import Resp, dumps
    from kb.write import record, write_refs
    from kb.write.errors import WriteRejected, VersionConflict, IdemConflict
    from urllib.parse import parse_qsl
    info = Q.identity.get()
    Q.rejection.set(None)
    ref = REF_PATH.fullmatch(path)
    try:
        params = parse_qsl(query, keep_blank_values=True)
        if REVIEW_PATH.fullmatch(path):
            return dispatch_review(method, path, params, raw)
        if ref:
            if method not in ("GET", "DELETE"):
                return error(405, "method_not_allowed", path)
            if params not in ([], [("include", "body")]) or (method == "DELETE" and params):
                return error(400, "bad_param", path)
            value = write_refs.access(ref[1], include_body=bool(params), delete=method == "DELETE")
            return Resp(200, [("content-type", "application/json"), ("cache-control", "no-store")], dumps(value))
        match = WRITE_PATH.fullmatch(path)
        if not match:
            return error(404, "not_found", path)
        if not info:
            return error(401, "token_required", path)
        if info["scope"] != "editor":
            return error(403, "scope_denied", path)
        if params not in ([], [("dry_run", "1")]):
            return error(400, "bad_param", path)
        if len(raw) > 2 * 1024 * 1024:
            return error(413, "body_too_large", path)
        try:
            obj = json.loads(raw)
        except (ValueError, UnicodeError, RecursionError):
            return error(400, "bad_json", path)
        if not isinstance(obj, dict):
            return error(400, "schema_invalid", path)
        rid, tombstone = match.groups()
        allowed = {"idempotency_key", "change", "on_secret", "record"} if not tombstone else {
            "idempotency_key", "change", "reason", "expected_version", "on_secret"}
        if set(obj) - allowed or "idempotency_key" not in obj or "change" not in obj:
            return error(400, "schema_invalid", path)
        if tombstone:
            if method != "POST" or params:
                return error(400, "bad_param", path)
            result = record.tombstone_record(rid, obj.get("reason"), obj["idempotency_key"], "http",
                                            token_label=info["label"], change=obj["change"],
                                            expected_version=obj.get("expected_version"))
        else:
            if method != ("PUT" if rid else "POST"):
                return error(405, "method_not_allowed", path)
            rec = obj.get("record")
            if not isinstance(rec, dict):
                return error(400, "schema_invalid", path)
            rec = dict(rec)
            if rid:
                if rec.get("id", rid) != rid:
                    return error(400, "schema_invalid", path)
                rec["id"] = rid
            else:
                rec.setdefault("sensitivity", "private")
            result = record.put_record(rec, obj["idempotency_key"], "http", token_label=info["label"],
                                       change=obj["change"], on_secret=obj.get("on_secret", "reject"), dry_run=bool(params))
        status = 200 if params or rid else 201
        if not isinstance(result, dict) and (result.held or result.spooled):
            status = 202
        usage(info, write=not params)
        return Resp(status, [("content-type", "application/json"), ("cache-control", "no-store")],
                    dumps(result if isinstance(result, dict) else result.as_dict()))
    except VersionConflict as exc:
        return error(409, "version_conflict", path, current=exc.current)
    except IdemConflict:
        return error(409, "idem_conflict", path)
    except WriteRejected as exc:
        metadata = Q.rejection.get()
        if metadata and metadata["code"] == exc.code:
            return error(metadata["status"], exc.code, path, retry=metadata["retry"])
        return error(exc.status, exc.code, path, retry=getattr(exc, "retry_after", None))
    except Exception as exc:
        print(f"kb serve: {type(exc).__name__}", file=sys.stderr)
        return error(500, "internal", path)


class Adapter:
    def __init__(self, app):
        self.app = app
        self.active = threading.BoundedSemaphore(2)
        self.mu = threading.Lock()
        self.requests = {}
        self.last_maintenance = 0.0

    def maintenance(self):
        from kb.write.write_refs import recover, purge
        from kb.write import actions
        now = time.monotonic()
        with self.mu:
            if now - self.last_maintenance < 60:
                return
            self.last_maintenance = now
        recover()
        purge()
        actions.maintenance()

    def allow(self, tok_id):
        now = time.monotonic()
        with self.mu:
            state = self.requests.setdefault(tok_id, {"recent": deque(), "credit": 20.0, "at": now})
            recent = state["recent"]
            while recent and recent[0] <= now - 60:
                recent.popleft()
            state["credit"] = min(20.0, state["credit"] + (now - state["at"]) * 2)
            state["at"] = now
            if len(recent) >= 120 or state["credit"] < 1:
                return False
            state["credit"] -= 1
            recent.append(now)
            return True

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not (WRITE_PATH.fullmatch(scope["path"]) or REF_PATH.fullmatch(scope["path"])
                                            or REVIEW_PATH.fullmatch(scope["path"])):
            return await self.app(scope, receive, send)
        from starlette.concurrency import run_in_threadpool
        await run_in_threadpool(self.maintenance)
        path, method = scope["path"], scope["method"]
        info = Q.identity.get()
        acquired = False
        if method not in ("GET", "HEAD") and not self.active.acquire(blocking=False):
            response = error(429, "too_many_requests", path, retry=1)
        else:
            acquired = method not in ("GET", "HEAD")
            try:
                body = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > 2 * 1024 * 1024 or not message.get("more_body", False):
                        break
                media = next((v.decode().split(";", 1)[0].strip().lower() for k, v in scope.get("headers", [])
                              if k.lower() == b"content-type"), "")
                if method in ("POST", "PUT") and media != "application/json":
                    response = error(415, "unsupported_media_type", path)
                else:
                    response = await run_in_threadpool(dispatch, method, path, scope["query_string"].decode(), bytes(body))
            finally:
                if acquired:
                    self.active.release()
        await send({"type": "http.response.start", "status": response.status,
                    "headers": [(k.encode(), v.encode()) for k, v in response.headers]})
        await send({"type": "http.response.body", "body": response.body})


def dispatch_review(method, path, params, raw):
    from kb.serve.http import Resp, dumps, reviewer_envelope
    from kb.write import actions
    info = Q.identity.get()
    poll = ACTION_POLL.fullmatch(path) if method == 'GET' else None
    if poll:
        if not info or info['scope'] != 'reviewer':
            return error(404, 'not_found', '/v1/actions/{id}')
    else:
        actions.identity()
    obj = {}
    if method == 'POST':
        if len(raw) > 2 * 1024 * 1024:
            return error(413, 'body_too_large', path)
        try:
            obj = json.loads(raw)
        except (ValueError, UnicodeError):
            return error(400, 'bad_json', path)
        if not isinstance(obj, dict):
            return error(400, 'schema_invalid', path)
    headers = [('content-type', 'application/json'), ('cache-control', 'no-store')]
    status = 200
    if poll:
        value = reviewer_envelope(actions.get_action(poll[1], info))
    elif method == 'GET' and path == '/v1/hitl':
        if any(k not in ('kind', 'cursor') for k, _ in params):
            return error(400, 'bad_param', path)
        value = reviewer_envelope({'items': actions.list_hitl(dict(params).get('kind'))})
    elif method == 'POST' and path == '/v1/actions':
        status, value = actions.prepare(obj)
        if status == 202:
            headers += [('location', value['status_url']), ('retry-after', '1')]
    elif method == 'POST' and path == '/v1/actions/challenge':
        status, value = 201, actions.action_challenge(obj)
    elif method == 'POST' and path == '/v1/hitl/challenge':
        status, value = 201, actions.hitl_challenge(obj)
    elif method == 'POST' and path == '/v1/reviewer/enroll':
        status, value = 201, actions.enroll(obj)
    elif method == 'POST' and (match := re.fullmatch(r'/v1/actions/([^/]+)/(execute|external-refine)', path)):
        status, value = actions.execute(match[1], obj, external=match[2] == 'external-refine')
    elif method == 'POST' and (match := re.fullmatch(r'/v1/hitl/([^/]+)/resolve', path)):
        value = actions.resolve_hitl(match[1], obj)
    else:
        return error(405, 'method_not_allowed', path)
    return Resp(status, headers, dumps(value))
