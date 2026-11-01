"""가짜 네트워크와 시계. safe_fetch의 이름 해석과 연결 클래스를 바꿔 끼운다. 실제 소켓을 열지 않는다."""
from __future__ import annotations

import gzip
import itertools
import time

from kb.collect import clock, fetch


class FakeClock:
    def __init__(self, start_s: float | None = None):
        self.t = start_s if start_s is not None else time.time()
        self.sleeps: list[float] = []

    def now_ms(self) -> int:
        return int(self.t * 1000)

    def mono(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        if s > 0:
            self.sleeps.append(s)
            self.t += s

    def advance(self, s: float) -> None:
        self.t += s

    def install(self, mp) -> "FakeClock":
        mp.setattr(clock, "now_ms", self.now_ms)
        mp.setattr(clock, "mono", self.mono)
        mp.setattr(clock, "sleep", self.sleep)
        return self


class Resp:
    def __init__(self, status=200, body=b"", headers=None, chunk=65536, read_cost=0.0, clk=None):
        self.status = status
        self._body = body
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._pos = 0
        self._chunk = chunk
        self._cost = read_cost
        self._clk = clk

    def getheader(self, k, d=None):
        return self._headers.get(k.lower(), d)

    def getheaders(self):
        return list(self._headers.items())

    def read(self, n=-1):
        if n == 0:
            return b""
        if self._clk is not None and self._cost:
            self._clk.advance(self._cost)
        n = min(n if n and n > 0 else len(self._body), self._chunk)
        out = self._body[self._pos:self._pos + n]
        self._pos += len(out)
        return out


class World:
    """host -> 주소, (host, path) -> 응답 명세. 등록 안 된 경로는 404."""

    def __init__(self, clk: FakeClock | None = None):
        self.clk = clk
        self.dns: dict[str, list[str]] = {}
        self.routes: dict[tuple, object] = {}
        self.requests: list[dict] = []
        self.counter = itertools.count(1)

    def add(self, host, path="/", status=200, body=b"", headers=None, ip="93.184.216.34", gz=False, **kw):
        self.dns.setdefault(host, [ip])
        h = dict(headers or {})
        if gz:
            body = gzip.compress(body)
            h["Content-Encoding"] = "gzip"
        self.routes[(host, path)] = dict(status=status, body=body, headers=h, **kw)
        return self

    def route_fn(self, host, path, fn, ip="93.184.216.34"):
        self.dns.setdefault(host, [ip])
        self.routes[(host, path)] = fn
        return self

    def count(self, host=None, path=None) -> int:
        return sum(1 for r in self.requests if (host is None or r["host"] == host) and (path is None or r["path"] == path))

    def net_count(self) -> int:
        return len(self.requests)

    # ---- 설치
    def install(self, mp) -> "World":
        world = self

        def getaddrinfo(host, port):
            import ipaddress
            import socket as s
            try:
                ipaddress.ip_address(host)
                ips = [host]
            except ValueError:
                if host not in world.dns:
                    raise s.gaierror(-2, "Name or service not known")
                ips = world.dns[host]
            out = []
            for ip in ips:
                fam = s.AF_INET6 if ":" in ip else s.AF_INET
                out.append((fam, s.SOCK_STREAM, 6, "", (ip, port)))
            return out

        class Conn:
            def __init__(self, host, port, pinned, timeout):
                self.host, self.port, self.timeout, self.sock, self.pinned = host, port, timeout, None, pinned
                self._path = None
                self._headers = {}

            def request(self, method, path, headers=None):
                self._path, self._headers = path, dict(headers or {})
                world.requests.append({"n": next(world.counter), "host": self.host, "path": path, "headers": self._headers,
                                       "ip": self.pinned[1][0]})

            def getresponse(self):
                spec = world.routes.get((self.host, self._path.split("?")[0] if (self.host, self._path) not in world.routes else self._path))
                if spec is None:
                    return Resp(404, b"not found", {"Content-Type": "text/plain"})
                if callable(spec):
                    spec = spec(self._headers)
                if isinstance(spec, Resp):
                    return spec
                spec = dict(spec)
                inm = self._headers.get("If-None-Match")
                if inm and spec.get("headers", {}).get("ETag") == inm and spec["status"] == 200:
                    return Resp(304, b"", {"ETag": inm})
                return Resp(spec["status"], spec["body"], spec["headers"], read_cost=spec.get("read_cost", 0.0),
                            chunk=spec.get("chunk", 65536), clk=world.clk)

            def close(self):
                pass

        mp.setattr(fetch, "_getaddrinfo", getaddrinfo)
        mp.setattr(fetch, "PinnedHTTPS", Conn)
        return self
