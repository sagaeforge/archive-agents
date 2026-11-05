"""GATE_VERSION 올림(gate@2 -> gate@3): 이미 쓰인 이벤트의 투영 지문, 큐, 완료 캐시를 바꾸지 않는다."""
from kb.gate import GATE_VERSION

from . import helpers as H


def test_gate_version_is_3():
    assert GATE_VERSION == "gate@3"


def test_bump_does_not_change_fingerprint_of_existing_events(env, monkeypatch):
    from kb.core import ledger
    from kb.project import rebuild, fingerprint_conn
    from kb.live import gold as G
    import kb.gate.model as M, kb.ingest.process as P
    monkeypatch.setattr(M, "GATE_VERSION", "gate@2")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@2")
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
    monkeypatch.setattr(M, "GATE_VERSION", "gate@3")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@3")
    assert fp() == before                                  # 같은 원장 -> 같은 지문. 판본은 이벤트 payload에서 온다


def test_gate_version_not_part_of_cache_or_queue_keys():
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2] / "src" / "kb"
    users = sorted(str(p.relative_to(root)) for p in root.rglob("*.py")
                   if "GATE_VERSION" in p.read_text() and p.name not in ("model.py", "__init__.py"))
    assert users == ["extract/sensitive.py", "ingest/process.py", "parse/events.py"]    # 캐시, 큐, 지문 코드는 참조하지 않는다


def _state():
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        return (sorted(r[0] for r in c.execute("SELECT k FROM tick_state WHERE k LIKE 'ex:done:%' OR k LIKE 'ex:raw:%'")),
                sorted(r[0] for r in c.execute("SELECT ref FROM queue")))
    finally:
        c.close()


def test_bump_keeps_done_raw_and_queue_and_is_idempotent_on_existing_claim(ent, monkeypatch):
    """gate@2로 쓴 주장을 gate@3에서 같은 주어와 인용구로 다시 내면 existing이고 claim.assert가 늘지 않는다.
    idem_key ingest:claim:<id>에 판본이 없고, 기존 ID는 이벤트를 만들지 않으므로 IdemConflict도 없다. 옛 증거는 gate@2로 남는다."""
    import kb.gate.model as M, kb.ingest.process as P
    from kb import ingest
    from kb.extract import items as itm, runner, settings, tick_stage
    monkeypatch.setattr(M, "GATE_VERSION", "gate@2")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@2")
    sid = H.ingest_doc()
    f = H.Fake("anthropic_api", True, H.extract_all(ent))
    with settings.override(**{"openrouter.enabled": False}):
        runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    assert len(H.events("claim.assert")) == 1 and H.events("claim.assert")[0]["evidence"][0]["gate_version"] == "gate@2"
    keys = _state()
    monkeypatch.setattr(M, "GATE_VERSION", "gate@3")
    monkeypatch.setattr(P, "GATE_VERSION", "gate@3")
    tick_stage.enqueue_new()
    with settings.override(**{"openrouter.enabled": False}):
        out = runner.run_agent("public", backends={"anthropic_api": f}, do_support=False)
    assert len(f.calls) == 1 and out["windows"] == 0 and _state() == keys          # 재호출 0, 완료·원응답 키와 큐 그대로
    it = {"item": "claim", "ref": "c0", "subject": ent, "statement": H.GOOD["statement"], "kind": "state", "stance": "stated",
          "method": "llm", "extractor": "l2:anthropic_api:haiku:extract-2", "evidence": {"snapshot": sid, "quote": H.GOOD["quote"]}}
    rep = ingest.submit(itm.bundle("a" * 64, [it]), fetch=False, windows={sid: []})
    assert rep.lines[0]["result"] == "accepted" and rep.lines[0]["would_be"]["existing"] is True
    evs = H.events("claim.assert")
    assert len(evs) == 1 and evs[0]["evidence"][0]["gate_version"] == "gate@2"
