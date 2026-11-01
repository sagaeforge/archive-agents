"""fixture 재생 도우미: 저널 조각과 CAS 객체로 gold를 만들고, ASGI 앱에 요청을 보내 응답을 저장 형식으로 바꾼다.

시계는 요청을 부르는 동안 NOW_MS로 고정한다. 레지스트리는 합성 목록으로 바꾼다(저장소의 실제 소스 목록에 기대지 않는다).
"""
from __future__ import annotations

import base64
import json
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import yaml

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "docs" / "contracts" / "fixtures"
KEEP_HEADERS = ("content-type", "etag", "cache-control", "vary", "content-range", "content-disposition", "x-content-type-options",
                "accept-ranges", "retry-after")
FAKE_SOURCES = [SimpleNamespace(id="src:a", enabled=True, class_="docs"), SimpleNamespace(id="src:b", enabled=True, class_="docs")]
FAKE_CLASSES = {"classes": {"docs": {"stale_s": 86400}}}


def load_ledger(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x]


@contextmanager
def fixed_clock(now_ms: int):
    real = time.time
    time.time = lambda: now_ms / 1000.0
    try:
        yield
    finally:
        time.time = real


@contextmanager
def fake_registry():
    from kb.collect import registry
    a, b = registry.load_registry, registry.load_classes
    registry.load_registry = lambda *x, **k: list(FAKE_SOURCES)
    registry.load_classes = lambda *x, **k: FAKE_CLASSES
    try:
        yield
    finally:
        registry.load_registry, registry.load_classes = a, b


def seed_ops(now_ms: int) -> None:
    """ops.db: 실행 기록 둘, 지표 하나, 소스 상태 하나. 시각은 모두 고정값이다."""
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        rid = opsdb.record_run(c, "tick", now_ms - 3600_000)
        opsdb.record_run(c, "tick", run_id=rid, ended_at=now_ms - 3500_000, outcome="ok")
        rid2 = opsdb.record_run(c, "tick", now_ms - 1800_000)
        opsdb.record_run(c, "tick", run_id=rid2, ended_at=now_ms - 1700_000, outcome="ok")
        opsdb.record_metric(c, "yield", 3, {"d": "A"}, at=now_ms - 1700_000)
        c.execute("INSERT OR REPLACE INTO source_state(source_id, last_ok_at, state) VALUES('src:a', ?, 'ok')", (now_ms - 7200_000,))
        c.commit()
    finally:
        c.close()


class Replayed:
    """재생된 세계. ledger, gold, export가 KB_HOME 아래에 있다. gold는 rebuild()가 만들어 build_id가 입력 해시다."""

    def __init__(self, home: Path, events: list[dict], cas_objs: dict[str, bytes], export_after: int, now_ms: int):
        from kb.core import cas, ledger
        from kb.project import current_gold_path, rebuild
        from kb.publish import publish
        for sha, data in cas_objs.items():
            assert cas.put(data) == sha, "CAS 객체 이름이 내용 해시와 다르다"
        self.led = ledger.open_ledger()
        self.export_after = export_after
        ledger.append(self.led, events[:export_after])
        rebuild(led=self.led)
        self.publish_result = publish(now_ms=now_ms, force=True)
        assert self.publish_result["published"], self.publish_result
        ledger.append(self.led, events[export_after:])
        rebuild(led=self.led)
        self.path = current_gold_path()
        seed_ops(now_ms)

    def close(self):
        self.led.close()


def build_app(path):
    from kb.serve.http import ServeConfig, build_app as _b
    return _b(ServeConfig(db_path=str(path)))


def call(app, case: dict):
    import asyncio

    from kb.serve.http import asgi_call
    hdrs = dict(case.get("headers") or {})
    return asyncio.run(asgi_call(app, case.get("method", "GET"), case["path"], hdrs, server=("/run/kb.sock", None)))


def to_stored(case_id: str, r) -> dict:
    h = {}
    for k, v in r.headers:
        k = k.lower()
        if k in KEEP_HEADERS:
            h[k] = v
    out = {"case": case_id, "status": r.status, "headers": dict(sorted(h.items()))}
    ct = h.get("content-type", "")
    if not r.body:
        out["body"] = None
    elif ct.startswith("application/json") or ct.startswith("application/problem+json"):
        out["body"] = json.loads(r.body)
    else:
        out["body_base64"] = base64.b64encode(r.body).decode()
    return out


def dump_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def load_requests() -> dict:
    return yaml.safe_load((FIX / "requests.yaml").read_text(encoding="utf-8"))
