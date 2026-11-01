"""LLM 호출 전용 HTTP 클라이언트. 수집용 safe_fetch(사설 주소 차단)는 루프백 sLLM과 OpenRouter 고정 호스트에 맞지 않으므로
여기에 둔다. 허용 대상은 두 가지뿐이다: https 호스트(OpenRouter 설정 base_url), 루프백(127.0.0.1) 서버. 시험의 urlopen 검사가
이 파일만 허용 목록에 둔다(tests/collect/test_fetch_guard.py)."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

HTTPError = urllib.error.HTTPError


def _check(url: str) -> None:
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https" and u.hostname:
        return
    if u.scheme == "http" and u.hostname == "127.0.0.1":
        return
    raise ValueError("LLM 클라이언트는 https 또는 루프백 http만 허용한다")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):                 # 3xx는 HTTPError로 끝난다
        return None


# 리다이렉트와 환경변수 프록시를 쓰지 않는다. 둘 다 _check를 지나지 않은 곳으로 본문이나 Authorization을 보낸다
_OPENER = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))


def request_json(url: str, *, body: dict | None = None, headers: dict | None = None, timeout: float = 30.0) -> dict:
    _check(url)
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=h)
    with _OPENER.open(req, timeout=timeout) as r:  # noqa: S310 _check가 스킴과 호스트를 제한한다
        return json.load(r)
