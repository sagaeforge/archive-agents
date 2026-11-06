"""세션 자료에서 https URL 후보를 뽑고 정규화, 걸러 내기. 네트워크 0회."""
from __future__ import annotations

import html
import ipaddress
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

URL_RE = re.compile(r"https://[^\s<>\"'`)\]}\\|]+", re.I)
_TRACK = re.compile(r"^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url|_ga|_gl|yclid|twclid)$", re.I)
_SECRETISH = re.compile(r"(token|key|secret|sig)", re.I)
_INTERNAL_SUFFIX = (".local", ".lan", ".internal", ".home.arpa", ".localdomain")


def extract(text: str) -> list[str]:
    out = []
    for m in URL_RE.finditer(html.unescape(text)):
        u = m.group(0).rstrip(".,;:!?*_")
        out.append(u)
    return out


def normalize(u: str) -> str | None:
    """https만. 프래그먼트와 추적 파라미터를 지우고 소문자 호스트와 기본 포트를 정리한다. 형식 오류면 None."""
    try:
        sp = urlsplit(u.strip())
        host = sp.hostname
        port = sp.port
    except ValueError:
        return None
    if sp.scheme != "https" or not host:
        return None
    q = [(k, v) for k, v in parse_qsl(sp.query, keep_blank_values=True) if not _TRACK.match(k)]
    h = host.lower()
    netloc = (f"[{h}]" if ":" in h else h) + (f":{port}" if port and port != 443 else "")
    if sp.username is not None or sp.password is not None:
        netloc = (sp.netloc.rsplit("@", 1)[0] + "@") + netloc  # 걸러 내기 위해 userinfo를 남긴다
    return urlunsplit(("https", netloc, sp.path or "/", urlencode(q), ""))


def skip_reason(u: str, deny_re=None) -> str | None:
    """등록하지 않는 이유. 내부 주소, 점 없는 호스트, userinfo, 비밀 쿼리, 차단 목록 문자열."""
    sp = urlsplit(u)
    if sp.username is not None or sp.password is not None or "@" in sp.netloc:
        return "userinfo"
    host = (sp.hostname or "").lower()
    try:
        ipaddress.ip_address(host.strip("[]"))
        return "ip_literal"
    except ValueError:
        pass
    if "." not in host:
        return "no_dot_host"
    if host.endswith(_INTERNAL_SUFFIX):
        return "internal_suffix"
    for k, _ in parse_qsl(sp.query, keep_blank_values=True):
        if _SECRETISH.search(k):
            return "secret_query"
    if deny_re is not None and deny_re.search(u):
        return "deny_string"
    return None
