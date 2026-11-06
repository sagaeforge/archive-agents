"""HTTP 시험 도우미(합성 데이터, 클라이언트)."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # tests/read/rhelp.py 재사용

from read.rhelp import DAY, E, T0, World, claim, entity, record, snap, verdict   # noqa: E402,F401

from kb.core import cas   # noqa: E402
from kb.serve.http import asgi_call   # noqa: E402

RAW = "<html>원본 바이트 0123456789</html>".encode()


def write_config(cfg_dir: Path, text: str) -> None:
    (cfg_dir / "config.toml").write_text(text, encoding="utf-8")


def seed(w, base=T0):
    raw = cas.put(RAW)
    pts = cas.put(b"\n".join(json.dumps({"period_key": k, "period_start": base - 10 * DAY + i * DAY,
                                         "period_end": base - 10 * DAY + (i + 1) * DAY, "value": v, "unit": "rank"}).encode()
                             for i, (k, v) in enumerate([("d1", "5"), ("d2", "4"), ("d3", "3")])))
    w.add(E("source.registered", {"id": "src:a", "label": "출처A"}, "src:a"),
          entity("e:product:p", "제품 P"), entity("e:feature:history", "기록 기능"), entity("e:tool:x", "도구 X"),
          snap(source="src:a", raw=raw, paras=("history 기능은 위젯을 지원한다", "둘째 문단입니다.")),
          claim("c-1", "e:feature:history", "history 기능은 위젯을 지원한다", predicate="supports", value="위젯"),
          E("edge.put", {"id": "r-01", "src": "e:feature:history", "rtype": "PART_OF", "dst": "e:product:p"}),
          E("edge.put", {"id": "r-02", "src": "e:tool:x", "rtype": "USES", "dst": "e:product:p"}),
          record("f-1", "공개 메모", "internal", body="본문 내용입니다 위젯"),
          record("f-priv", "비공개 메모", "private", body="private 본문"),
          record("f-sec", "비밀 메모", "secret", body="SECRET-BODY-XYZ"),
          E("series.define", {"id": "s:rank", "label": "순위", "metric": "chart_rank", "unit": "rank", "subject": "e:product:p"}, "s:rank"),
          E("series.batch", {"series_id": "s:rank", "snapshot": "n-1", "parser": "p@1", "count": 3, "points_sha": pts}, "s:rank"),
          E("ticket.open", {"id": "t-1", "topic": "위젯 조사", "reason": "필요", "priority": 2}, "t-1"))
    return w



class Client:
    """서버 없이 ASGI 앱을 부른다. tcp=True이면 TCP 전송(포트 있음)을 흉내 낸다."""

    def __init__(self, app, tcp=False):
        self.app, self.tcp = app, tcp

    @property
    def server(self):
        return ("127.0.0.1", 8737) if self.tcp else ("/run/kb.sock", None)

    def get(self, target, headers=None, method="GET"):
        return asyncio.run(asgi_call(self.app, method, target, headers, server=self.server))

    def json(self, target, headers=None, expect=200):
        r = self.get(target, headers)
        assert r.status == expect, (r.status, r.body[:300])
        return json.loads(r.body)


def hdr(r, name):
    for k, v in r.headers:
        if k.lower() == name.lower():
            return v
    return None




def hdr(r, name):
    for k, v in r.headers:
        if k.lower() == name.lower():
            return v
    return None


# ------------------------------------------------------------------ 실제 소켓 클라이언트
import http.client   # noqa: E402
import socket   # noqa: E402


class UDSConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=15):
        super().__init__("localhost", timeout=timeout)
        self.uds = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(self.timeout)
        s.connect(self.uds)
        self.sock = s


def uds_get(path, target, headers=None, method="GET", timeout=15):
    c = UDSConnection(path, timeout)
    try:
        c.request(method, target, headers=headers or {})
        r = c.getresponse()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read()
    finally:
        c.close()


def wait_for(cond, timeout=15.0, step=0.05):
    import time
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = cond()
        if v:
            return v
        time.sleep(step)
    return None
