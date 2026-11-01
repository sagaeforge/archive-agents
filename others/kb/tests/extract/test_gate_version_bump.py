"""GATE_VERSION gate@1 -> gate@2: 이미 쓰인 이벤트의 투영 지문, 큐, 완료 캐시를 바꾸지 않는다."""
from kb.gate import GATE_VERSION

from . import helpers as H


def test_gate_version_is_2():
    assert GATE_VERSION == "gate@2"


def test_bump_does_not_change_fingerprint_of_existing_events(env, monkeypatch):
    from kb.core import ledger
    from kb.project import rebuild, fingerprint_conn
    from kb.live import gold as G
    import kb.gate.model as M, kb.ingest.process as P
    monkeypatch.setattr(M, "GATE_VERSION", "gate@1")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@1")
    H.put_entity("e:tool:sample", "샘플도구", aliases=["샘플도구"])
    H.ingest_doc()

    def fp():
        led = ledger.open_ledger()
        try:
            rebuild(led=led)
        finally:
            led.close()
        con = G.open_gold()
        try:
            return fingerprint_conn(con)
        finally:
            con.close()
    before = fp()
    monkeypatch.setattr(M, "GATE_VERSION", "gate@2")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@2")
    assert fp() == before                                  # 같은 원장 -> 같은 지문. 판본은 이벤트 payload에서 온다


def test_gate_version_not_part_of_cache_or_queue_keys():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2] / "src" / "kb"
    users = sorted(str(p.relative_to(root)) for p in root.rglob("*.py")
                   if "GATE_VERSION" in p.read_text() and p.name not in ("model.py", "__init__.py"))
    assert users == ["extract/sensitive.py", "ingest/process.py", "parse/events.py"]    # 캐시, 큐, 지문 코드는 참조하지 않는다
