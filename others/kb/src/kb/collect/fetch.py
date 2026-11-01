"""수집 경계 safe_fetch(ADR 10.3). 네트워크로 나가는 유일한 함수다. 표준 라이브러리만 쓴다.

- https만, userinfo 거부, 포트 443(소스 선언 예외)
- 해석한 모든 주소가 공인이어야 한다. IPv4 매핑 IPv6도 검사하고 멀티캐스트, site-local, IPv4 호환, NAT64, 6to4, Teredo는 거부
- 검사한 주소로만 연결하고(DNS 재바인딩 차단) 연결 뒤 getpeername을 다시 검사한다. 인증서는 호스트 이름으로 확인한다
- 리다이렉트는 수동으로 최대 5회, 홉마다 전체 재검사(호스트 정책 포함)
- 크기 20 MB(gzip 해제 후 포함), 요청 전체 마감 20초(마감 시각을 소켓 호출마다 줄여 쓴다)
- User-Agent는 kb-collector/<버전>. 연락처는 needs_contact 소스에 한해 이 함수 한 곳에서만 붙인다
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import zlib
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from kb.collect import clock, hostpolicy, registry
from kb.collect.errors import Blocked, FetchError, PolicyError

MAX_BYTES = 20_000_000
DEADLINE_S = 20.0
MAX_REDIRECTS = 5
REDIRECT = (301, 302, 303, 307, 308)
_NO_FORWARD = {"authorization", "cookie", "proxy-authorization"}
_V6_BLOCKED = tuple(ipaddress.ip_network(n) for n in (
    "::/96",            # IPv4 호환(::a.b.c.d). ::와 ::1 포함
    "64:ff9b::/96",     # NAT64
    "64:ff9b:1::/48",   # 로컬 NAT64
    "fec0::/10",        # site-local
    "ff00::/8",         # 멀티캐스트
    "2001::/32",        # Teredo
))
_V4_BLOCKED = (ipaddress.ip_network("224.0.0.0/4"), ipaddress.ip_network("240.0.0.0/4"))


def version() -> str:
    try:
        from importlib.metadata import version as v
        return v("sagae-kb")
    except Exception:  # noqa: BLE001 설치 메타데이터가 없는 개발 환경
        return "0.1.0"


@dataclass
class Fetched:
    status: int
    body: bytes
    url: str                      # 최종 URL
    headers: dict = field(default_factory=dict)   # 소문자 이름
    chain: list = field(default_factory=list)     # [(url, status)]
    ms: int = 0

    @property
    def content_type(self) -> str | None:
        return self.headers.get("content-type")

    @property
    def etag(self) -> str | None:
        return self.headers.get("etag")

    @property
    def last_modified(self) -> str | None:
        return self.headers.get("last-modified")

    @property
    def bytes(self) -> int:
        return len(self.body)

    @property
    def retry_after(self) -> float | None:
        v = self.headers.get("retry-after")
        try:
            return float(v) if v is not None else None
        except ValueError:
            return None


def addr_ok(ip) -> str | None:
    """공인 주소면 None, 아니면 거부 이유."""
    if isinstance(ip, str):
        ip = ipaddress.ip_address(ip.split("%")[0])
    if ip.version == 6:
        m = ip.ipv4_mapped
        if m is not None:
            return addr_ok(m)
        for n in _V6_BLOCKED:
            if ip in n:
                return f"{ip}"
        if ip in ipaddress.ip_network("2002::/16"):   # 6to4: 내장된 IPv4를 검사한다
            emb = ipaddress.IPv4Address(int(ip) >> 80 & 0xFFFFFFFF)
            return None if addr_ok(emb) is None else f"{ip}"
    else:
        for n in _V4_BLOCKED:
            if ip in n:
                return f"{ip}"
    return None if ip.is_global and not ip.is_multicast else f"{ip}"


def _getaddrinfo(host: str, port: int):
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def check_host(host: str, port: int) -> tuple:
    """해석한 전 주소가 공인이어야 한다. 검사한 첫 주소 (family, sockaddr)를 돌려준다."""
    try:
        infos = _getaddrinfo(host, port)
    except socket.gaierror as e:
        raise FetchError(f"dns:{host}:{e}") from e
    if not infos:
        raise Blocked("addr:noaddr")
    pinned = None
    for fam, _, _, _, sa in infos:
        bad = addr_ok(sa[0])
        if bad:
            raise Blocked(f"addr:{bad}")
        pinned = pinned or (fam, sa)
    return pinned


class PinnedHTTPS(http.client.HTTPSConnection):
    """검사한 주소로만 연결한다. 연결 뒤 상대 주소를 다시 검사하고, 인증서는 호스트 이름으로 확인한다."""

    def __init__(self, host: str, port: int, pinned: tuple, timeout: float):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self.pinned = pinned

    def connect(self) -> None:
        fam, sa = self.pinned
        s = socket.socket(fam, socket.SOCK_STREAM)
        try:
            s.settimeout(self.timeout)
            s.connect(sa)
            bad = addr_ok(s.getpeername()[0])
            if bad:
                raise Blocked(f"addr:peer:{bad}")
            self.sock = self._context.wrap_socket(s, server_hostname=self.host)
        except BaseException:
            s.close()
            raise


def _src(source):
    if source is None or isinstance(source, registry.Source):
        return source
    if isinstance(source, str):
        return registry.adhoc_source() if source == registry.ADHOC_ID else None
    return None


def user_agent(src, host: str) -> str:
    ua = f"kb-collector/{version()}"
    if src is not None and src.needs_contact and host in src.hosts():
        c = registry.contact_text()
        if not c:
            raise PolicyError("contact_missing")
        ua += f" (+{c})"
    return ua


def _remaining(deadline: float) -> float:
    r = deadline - clock.mono()
    if r <= 0:
        raise Blocked("deadline:exceeded")
    return r


def _settimeout(conn, t: float) -> None:
    s = getattr(conn, "sock", None)
    if s is not None:
        s.settimeout(t)


def _clean_headers(h: dict | None) -> dict:
    out = {}
    for k, v in (h or {}).items():
        k, v = str(k), str(v)
        if "\r" in k + v or "\n" in k + v:
            raise Blocked("header:crlf")
        if k.lower() in ("user-agent", "host", "accept-encoding"):
            continue
        out[k] = v
    return out


def safe_fetch(url: str, *, source=None, headers: dict | None = None, max_bytes: int = MAX_BYTES,
               deadline_s: float = DEADLINE_S, max_redirects: int = MAX_REDIRECTS,
               allow_ports: tuple = ()) -> Fetched:
    """GET 하나. 규칙 위반은 Blocked(거부 호스트는 HostDenied, 정책이라 E_POLICY), 일시 오류는 FetchError.
    allow_ports는 소스 선언으로만 쓴다."""
    src = _src(source)
    t0 = clock.mono()
    deadline = t0 + deadline_s
    extra = _clean_headers(headers)
    chain: list = []
    first_host = None
    for _hop in range(max_redirects + 1):
        try:
            u = urlsplit(url)
            port = u.port
        except ValueError as e:
            raise Blocked(f"port:{e}") from e
        if u.scheme != "https":
            raise Blocked(f"scheme:{u.scheme}")
        if u.username is not None or u.password is not None:
            raise Blocked("userinfo")
        host = (u.hostname or "").lower()
        if not host:
            raise Blocked("nohost")
        port = port or 443
        if port != 443 and port not in allow_ports:
            raise Blocked(f"port:{port}")
        first_host = first_host or host
        hostpolicy.check(host)                       # DNS 전에. 거부는 네트워크 0회
        pinned = check_host(host, port)
        hdr = {"User-Agent": user_agent(src, host), "Accept-Encoding": "gzip", "Accept": "*/*"}
        for k, v in extra.items():
            if host != first_host and k.lower() in _NO_FORWARD:
                continue
            hdr[k] = v
        conn = PinnedHTTPS(host, port, pinned, _remaining(deadline))
        try:
            try:
                path = (u.path or "/") + ("?" + u.query if u.query else "")
                conn.timeout = _remaining(deadline)
                conn.request("GET", path, headers=hdr)
                _settimeout(conn, _remaining(deadline))
                r = conn.getresponse()
                chain.append((url, r.status))
                if r.status in REDIRECT:
                    loc = r.getheader("Location")
                    r.read(0)
                    if not loc:
                        raise Blocked("redirect:noloc")
                    url = urljoin(url, loc)
                    continue
                rh = {k.lower(): v for k, v in r.getheaders()}
                body = b"" if r.status == 304 else _read_body(r, conn, rh, max_bytes, deadline)
            except (socket.timeout, TimeoutError) as e:
                raise Blocked("deadline:socket") from e
            except (OSError, http.client.HTTPException, ssl.SSLError) as e:
                if isinstance(e, Blocked):
                    raise
                raise FetchError(f"{type(e).__name__}:{e}"[:200]) from e
        finally:
            conn.close()
        return Fetched(status=r.status, body=body, url=url, headers=rh, chain=chain,
                       ms=int((clock.mono() - t0) * 1000))
    raise Blocked("redirect:too_many")


def _read_body(r, conn, rh: dict, max_bytes: int, deadline: float) -> bytes:
    cl = rh.get("content-length")
    if cl and cl.isdigit() and int(cl) > max_bytes:
        raise Blocked(f"too_large:content_length={cl}")
    gz = rh.get("content-encoding", "").lower() in ("gzip", "x-gzip")
    dec = zlib.decompressobj(31) if gz else None
    raw = 0
    out = bytearray()
    while True:
        _settimeout(conn, _remaining(deadline))
        chunk = r.read(65536)
        _remaining(deadline)                         # 느리게 흘리는 응답도 전체 마감에 걸린다
        if not chunk:
            break
        raw += len(chunk)
        if raw > max_bytes:
            raise Blocked("too_large:stream")
        if dec is None:
            out += chunk
            if len(out) > max_bytes:
                raise Blocked("too_large:stream")
            continue
        data = chunk
        while data:
            try:
                part = dec.decompress(data, max_bytes - len(out) + 1)
            except zlib.error as e:
                raise FetchError(f"gzip:{e}") from e
            out += part
            if len(out) > max_bytes:
                raise Blocked("too_large:gunzip")
            data = dec.unconsumed_tail
    if dec is not None:
        try:
            out += dec.flush()
        except zlib.error as e:
            raise FetchError(f"gzip:{e}") from e
        if len(out) > max_bytes:
            raise Blocked("too_large:gunzip")
    return bytes(out)
