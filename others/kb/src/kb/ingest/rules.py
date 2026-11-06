"""liveness 신호의 1차 출처 규칙(ADR 9.2). 신호의 스냅샷은 trust=primary 소스이거나,
src:adhoc라면 URL이 판정 대상 자신의 공식 위치여야 한다. 그 밖은 E_LIVENESS_SOURCE다."""
from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

_REPO = re.compile(r"^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$")


def _host_path(url: str) -> tuple[str, list]:
    u = urlsplit(url or "")
    return (u.hostname or "").lower(), [unquote(p) for p in u.path.split("/") if p]


def repo_name(props: dict, label: str = "") -> tuple[str, str] | None:
    for k in ("repo", "full_name"):
        m = _REPO.match(str(props.get(k) or ""))
        if m:
            return m.group(1).lower(), m.group(2).lower()
    for k in ("url", "html_url", "homepage"):
        h, p = _host_path(str(props.get(k) or ""))
        if h == "github.com" and len(p) >= 2:
            return p[0].lower(), p[1].lower()
    m = _REPO.match(label or "")
    return (m.group(1).lower(), m.group(2).lower()) if m else None


def _pkg_norm(s: str) -> str:
    return re.sub(r"[-_.]+", "-", s.lower())


def official(unit: str, props: dict, label: str, url: str, primary_hosts: set) -> bool:
    """url이 대상(unit, props, label)의 공식 위치인가."""
    host, seg = _host_path(url)
    if not host:
        return False
    unit = (unit or "").lower()
    if unit == "repo":
        rn = repo_name(props, label)
        if not rn:
            return False
        if host == "github.com":
            return [s.lower() for s in seg[:2]] == list(rn)
        if host == "api.github.com":
            return len(seg) >= 3 and seg[0] == "repos" and [s.lower() for s in seg[1:3]] == list(rn)
        return False
    if unit == "package":
        name = str(props.get("package") or props.get("name") or label or "")
        if not name:
            return False
        if host == "registry.npmjs.org":
            path = "/".join(seg).lower()
            n = name.lower()
            return path == n or path.startswith(n + "/")
        if host == "pypi.org":
            if len(seg) >= 2 and seg[0] in ("pypi", "project", "simple"):
                return _pkg_norm(seg[1]) == _pkg_norm(name)
        return False
    if unit in ("feature", "model"):
        return host in primary_hosts
    if unit in ("doc", "document", "feed"):
        th, _ = _host_path(str(props.get("url") or ""))
        return bool(th) and host == th
    return False
