"""호스트 정책(ADR 10.3). 거부 목록 + 비활성 소스의 호스트 - 활성 소스의 호스트 - overlay의 host_allow.
계산 결과는 sources/ 아래 파일의 mtime이 바뀔 때까지 캐시한다."""
from __future__ import annotations

from kb.collect import registry
from kb.collect.errors import HostDenied

DEFAULT_INTERVAL_S = 3.0
_cache: dict = {}


def _key() -> tuple:
    root = registry.sources_dir()
    items = [str(root)]
    for sub in ("", "domains", "overlays"):
        d = root / sub if sub else root
        if d.is_dir():
            for p in sorted(d.glob("*.yaml")):
                st = p.stat()
                items.append((str(p), st.st_mtime_ns, st.st_size))
    return tuple(items)


def _state() -> dict:
    k = _key()
    if _cache.get("key") != k:
        p = registry.sources_dir() / "host-policy.yaml"
        pol = (registry.read_yaml(p) or {}) if p.exists() else {}
        srcs = registry.load_registry(validate=False)
        off: set[str] = set()
        on: set[str] = set()
        for s in srcs:
            (on if s.enabled else off).update(s.hosts())
        _cache.clear()
        _cache.update(key=k, policy=pol, inactive=off - on, allow=registry.host_allow(),
                      deny=[str(h).lower().strip(".") for h in (pol.get("deny") or [])])
    return _cache


def deny_list() -> list[str]:
    return list(_state()["deny"])


def budgets() -> dict[str, int]:
    return {str(k).lower(): int(v) for k, v in (_state()["policy"].get("budgets") or {}).items()}


def interval_for(host: str) -> float:
    v = (_state()["policy"].get("intervals") or {}).get(host.lower())
    return float(v) if v is not None else DEFAULT_INTERVAL_S


def _matches(host: str, dom: str) -> bool:
    return host == dom or host.endswith("." + dom)


def inactive_hosts() -> set[str]:
    """비활성 소스의 호스트에서 활성 소스가 쓰는 호스트를 뺀 집합."""
    return set(_state()["inactive"])


def denied_reason(host: str) -> str | None:
    """거부면 이유 문자열, 허용이면 None."""
    h = (host or "").lower().strip(".")
    if not h:
        return "nohost"
    st = _state()
    if h in st["allow"]:
        return None
    for d in st["deny"]:
        if _matches(h, d):
            return f"deny_list:{d}"
    if h in st["inactive"]:
        return "inactive_source"
    return None


def host_allowed(host: str) -> bool:
    return denied_reason(host) is None


def check(host: str) -> None:
    r = denied_reason(host)
    if r:
        raise HostDenied(f"host:{host}:{r}", host=(host or "").lower())
