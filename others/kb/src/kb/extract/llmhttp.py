"""LLM HTTP: 세 API 호스트의 HTTPS와 루프백 HTTP만 허용한다(ADR-0004 7.2).
리다이렉트와 환경 프록시는 쓰지 않는다. 수집용 safe_fetch와 별개다."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

HTTPError = urllib.error.HTTPError


def _check(url: str) -> None:
    u = urllib.parse.urlsplit(url)
    if u.username is not None or u.password is not None or u.fragment:
        raise ValueError("llm_host_denied")
    if u.scheme == "https" and u.hostname in {"openrouter.ai", "api.openai.com", "api.anthropic.com"} and u.port in (None, 443):
        return
    if u.scheme == "http" and u.hostname in {"127.0.0.1", "::1", "localhost"}:
        return
    raise ValueError("llm_host_denied")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):                 # 3xx는 HTTPError로 끝난다
        return None


# 리다이렉트와 환경변수 프록시를 쓰지 않는다. 둘 다 _check를 지나지 않은 곳으로 본문이나 Authorization을 보낸다
_OPENER = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))


def request_json(url: str, *, body: dict | None = None, headers: dict | None = None, timeout: float = 30.0, admission=None, engine=None, model=None) -> dict:
    _check(url)
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=h)
    # Only explicitly enumerated metadata GETs and credential-free local inference
    # are unpaid. Every other provider request requires the admission capability.
    u = urllib.parse.urlsplit(url)
    metadata = body is None and engine == 'openrouter' and u.hostname in {'openrouter.ai', '127.0.0.1', '::1', 'localhost'} and u.path in {'/api/v1/credits', '/api/v1/key', '/api/credits', '/api/key'}
    local = u.hostname in {'127.0.0.1', '::1', 'localhost'}
    credentialed = any(k.lower() in {'authorization', 'x-api-key'} for k in h)
    if admission is not None or not metadata and (not local or credentialed):
        from kb.extract import budget, engines
        try:
            engines.check_host(engine, url)
        except ValueError:
            raise budget.Refused('engine_host_mismatch') from None
        if body is not None and body.get('model') != model:
            raise budget.Refused('admission_mismatch')
        budget.before_send(admission, engine=engine, model=model)
    with _OPENER.open(req, timeout=timeout) as r:  # noqa: S310 _check가 스킴과 호스트를 제한한다
        return json.load(r)
