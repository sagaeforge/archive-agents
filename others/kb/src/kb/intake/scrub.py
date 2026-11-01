"""저장 전 제거(WP-26). 줄 단위다: 걸린 줄은 통째로 빼고 건수만 센다. 내용은 어디에도 남기지 않는다.

제거 대상: 사설, 루프백, 링크 로컬 IPv4와 비공개 IPv4, ULA와 링크 로컬 IPv6, localhost 포트,
.local .lan .internal .home.arpa 호스트, 차단 목록 문자열, 토큰 권한 목록 줄.
"""
from __future__ import annotations

import ipaddress
import re

_IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)")
_IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(?![\w:])")
_LOCALHOST = re.compile(r"\blocalhost:\d+", re.I)
# settings.local.json처럼 뒤에 점 확장자가 이어지는 파일 이름은 호스트가 아니다
INTERNAL_HOST = re.compile(r"\b[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9_-]+)*\."
                           r"(?:local|lan|internal|home\.arpa)(?![A-Za-z0-9_-])(?!\.[A-Za-z0-9])", re.I)
_ULA = ipaddress.IPv6Network("fc00::/7")
_SCOPES = re.compile(r"scopes:|x-oauth-scopes:|token permissions", re.I)


def has_internal_addr(line: str) -> bool:
    """내부 주소 패턴(IP, localhost 포트, 내부 호스트 접미사)만 본다. 차단 목록과 권한 줄은 보지 않는다."""
    for m in _IPV4.finditer(line):
        try:
            ip = ipaddress.IPv4Address(m.group(0))
        except ValueError:
            continue
        if not ip.is_global and not ip.is_multicast:
            return True
    for m in _IPV6.finditer(line):
        try:
            ip = ipaddress.IPv6Address(m.group(0))
        except ValueError:
            continue
        if ip.is_unspecified:
            continue
        if ip.is_loopback or ip.is_link_local or ip in _ULA:
            return True
    if _LOCALHOST.search(line):
        return True
    return bool(INTERNAL_HOST.search(line))



class Scrubber:
    def __init__(self, deny: list[str] | None = None):
        names = sorted({d for d in (deny or []) if len(d) >= 3}, key=len, reverse=True)
        self._deny = re.compile("|".join(re.escape(n) for n in names), re.I) if names else None

    def bad(self, line: str) -> bool:
        if _SCOPES.search(line):
            return True
        if self._deny is not None and self._deny.search(line):
            return True
        return has_internal_addr(line)

    def lines(self, text: str, drop_numbers: set[int] | None = None) -> tuple[str, int]:
        """(남은 본문, 뺀 줄 수). drop_numbers는 원본의 1부터 센 줄 번호이고 뺀 줄 수에 든다."""
        out: list[str] = []
        n = 0
        for i, ln in enumerate(text.splitlines(), 1):
            if (drop_numbers and i in drop_numbers) or self.bad(ln):
                n += 1
                continue
            out.append(ln)
        return "\n".join(out) + ("\n" if out else ""), n

    def hits(self, text: str) -> tuple[int, int]:
        """검증용. (차단 목록 적중 줄 수, 내부 주소 적중 줄 수). 적중 내용은 돌려주지 않는다."""
        d = a = 0
        for ln in text.splitlines():
            if self._deny is not None and self._deny.search(ln):
                d += 1
            if has_internal_addr(ln):
                a += 1
        return d, a
