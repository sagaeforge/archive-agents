import json

from kb.core import ledger, spool
from kb.intake import core
from kb.read.cards import _author_mark

FORBIDDEN = ("claim.assert", "entity.put", "edge.put", "snapshot.captured")


def kinds():
    c = ledger.open_ledger()
    try:
        return [r[0] for r in c.execute("SELECT kind FROM event")], c.execute(
            "SELECT DISTINCT actor FROM event WHERE kind='record.put'").fetchall()
    finally:
        c.close()


def test_no_claims_no_network_author(sample):
    man, _ = sample
    r = core.run(man)  # conftest의 no_network가 소켓 접속을 막는다
    ks, _ = kinds()
    assert not any(k in FORBIDDEN for k in ks) and not any(k.startswith(("claim.", "edge.")) for k in ks)
    held = [e for _, o in spool.iter_items("fp-held") for e in o["events"]]
    assert held and all(e["actor"] == "agent:sess-a" and e["on_behalf_of"] == "user:sagae" and e["origin"] == "first_party"
                        for e in held)
    assert r["held"] == 8 and r["excluded"] == 1 and r["stored"] == 0
    assert _author_mark("agent:sess-a") == "f:agent:sess-a"


def test_after_open_records_are_in_ledger_with_agent_author(sample):
    from wrhelp import open_fp_direct
    open_fp_direct()
    man, _ = sample
    r = core.run(man)
    ks, actors = kinds()
    assert r["stored"] == 8 and r["held"] == 0 and r["stored"] + r["held"] + r["excluded"] == r["items"]
    assert ("agent:sess-a",) in actors and not any(k in FORBIDDEN for k in ks)
    assert core.run(man)["new_events"] == 0

