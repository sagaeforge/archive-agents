"""수집 경계 프로토타입. 표준 라이브러리만 쓴다. 한 함수에 스킴, 주소, 리다이렉트, 크기 검사를 모은다."""
import gzip, http.client, ipaddress, json, socket, ssl, sys, time, zlib
from urllib.parse import urljoin, urlsplit

UA = "kb-collector/0.1"  # 연락처 없음. 개인 정보를 넣지 않는다


class Blocked(Exception):
    pass


def check_host(host, port):
    if port not in (443,):
        raise Blocked(f"port:{port}")
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    ips = []
    for fam, _, _, _, sa in infos:
        ip = ipaddress.ip_address(sa[0].split("%")[0])
        mapped = getattr(ip, "ipv4_mapped", None)
        if not (mapped or ip).is_global:
            raise Blocked(f"addr:{ip}")
        ips.append((fam, sa))
    if not ips:
        raise Blocked("noaddr")
    return ips[0]


class PinnedHTTPS(http.client.HTTPSConnection):
    """검사한 주소로만 연결한다. DNS 재바인딩을 막고 인증서는 호스트 이름으로 확인한다."""

    def __init__(self, host, pinned, timeout):
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self.pinned = pinned

    def connect(self):
        fam, sa = self.pinned
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(sa)
        peer = ipaddress.ip_address(s.getpeername()[0].split("%")[0])
        if not (getattr(peer, "ipv4_mapped", None) or peer).is_global:
            s.close()
            raise Blocked(f"peer:{peer}")
        self.sock = self._context.wrap_socket(s, server_hostname=self.host)


def safe_fetch(url, max_bytes=20_000_000, timeout=20, max_redirects=5, etag=None):
    chain = []
    for hop in range(max_redirects + 1):
        u = urlsplit(url)
        if u.scheme != "https":
            raise Blocked(f"scheme:{u.scheme}")
        if u.username or u.password:
            raise Blocked("userinfo")
        host = u.hostname
        if not host:
            raise Blocked("nohost")
        pinned = check_host(host, u.port or 443)
        conn = PinnedHTTPS(host, pinned, timeout)
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        hdr = {"User-Agent": UA, "Accept-Encoding": "gzip", "Accept": "*/*"}
        if etag:
            hdr["If-None-Match"] = etag
        conn.request("GET", path, headers=hdr)
        r = conn.getresponse()
        chain.append((url, r.status))
        if r.status in (301, 302, 303, 307, 308):
            loc = r.getheader("Location")
            conn.close()
            if not loc:
                raise Blocked("redirect_noloc")
            url = urljoin(url, loc)
            continue
        cl = r.getheader("Content-Length")
        if cl and int(cl) > max_bytes:
            conn.close()
            raise Blocked(f"too_large:cl={cl}")
        buf = bytearray()
        while True:
            b = r.read(65536)
            if not b:
                break
            buf += b
            if len(buf) > max_bytes:
                conn.close()
                raise Blocked("too_large:stream")
        enc = r.getheader("Content-Encoding", "")
        if enc == "gzip":
            d = zlib.decompressobj(31)
            out = d.decompress(bytes(buf), max_bytes + 1)
            if len(out) > max_bytes or d.unconsumed_tail:
                raise Blocked("too_large:gunzip")
            buf = out
        conn.close()
        return {"status": r.status, "bytes": len(buf), "ctype": r.getheader("Content-Type"), "chain": chain}
    raise Blocked("too_many_redirects")


CASES = [
    ("file:///etc/passwd", "scheme"),
    ("http://example.com/", "scheme"),
    ("ftp://example.com/", "scheme"),
    ("https://user:<EMAIL>/", "userinfo"),
    ("https://127.0.0.1/", "addr"),
    ("https://localhost/", "addr"),
    ("https://[::1]/", "addr"),
    ("https://[::ffff:127.0.0.1]/", "addr"),
    ("https://2130706433/", "addr"),
    ("https://0x7f.0.0.1/", "addr"),
    ("https://169.254.169.254/latest/meta-data/", "addr"),
    ("https://10.x.x.x/", "addr"),
    ("https://192.0.2.1/", "addr"),
    ("https://172.x.x.x/", "addr"),
    ("https://example.com:8443/", "port"),
]
ok = 0
for u, want in CASES:
    try:
        r = safe_fetch(u, timeout=5)
        print("NOT BLOCKED", u, r)
    except Blocked as e:
        hit = str(e).startswith(want)
        ok += hit
        print("blocked" if hit else "WRONG", u, e)
    except Exception as e:
        print("OTHER", u, type(e).__name__, e)
print("blocked", ok, "/", len(CASES))
try:
    print(safe_fetch("https://code.claude.com/docs/llms.txt"))
except Exception as e:
    print("real fail", type(e).__name__, e)
try:
    print(safe_fetch("https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md", max_bytes=65536))
except Blocked as e:
    print("size guard:", e)
try:
    print(safe_fetch("https://github.com/anthropics/claude-code/releases.atom"))
except Exception as e:
    print("real fail", type(e).__name__, e)
try:
    print(safe_fetch("https://docs.anthropic.com/en/docs/claude-code/overview"))
except Exception as e:
    print("redirect case", type(e).__name__, e)
