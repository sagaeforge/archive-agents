"""superseded는 successor가 필수, SUCCESSOR_OF 엣지, 후속 불명은 removed 경로, 1차 아닌 근거 거부, 보류 주장 해제."""
import json

import pytest

from kb.live import probe, runner, rules, verdict
from kb.live.model import Decision, Sig
from kb.write import WriteRejected

from .conftest import NOW, capture, commit, det_claim, ev, gold, node, put_entity, source


def _dec(target, snap, **kw):
    return Decision(target=target, unit="repo", liveness=kw.pop("liveness", "superseded"),
                    signals=[Sig("M05", "decl", snap, "This project has been archived")], **kw)


def test_superseded_without_successor_goes_to_removed_path():
    d = Decision(target="e:repo:a", unit="repo", liveness="superseded", signals=[Sig("M05", "decl", "n-1", "x")])
    d = rules._finish(d, d.signals, [], None)
    assert d.liveness != "superseded" and not d.auto           # 자동으로 확정되지 않는다
    with pytest.raises(verdict.VerdictRejected) as e:
        verdict.build(Decision("e:repo:a", "repo", "superseded", [Sig("M05", "decl", "n-1")]), "t", None, check=False)
    assert e.value.code == "E_SUCCESSOR"


def test_schema_rejects_superseded_without_successor(env):
    put_entity("e:repo:acme-a", "Repo", "acme/a")
    with pytest.raises(WriteRejected):
        commit([ev("survival.verdict", {"target": "e:repo:acme-a", "unit": "repo", "liveness": "superseded", "status": "superseded",
                                        "signals": [{"id": "M05"}], "decided_by": "t"}, "e:repo:acme-a")])


def test_superseded_writes_successor_edge_and_hides_old(env):
    source()
    put_entity("e:repo:acme-old", "Repo", "acme/old", liveness="active")
    put_entity("e:repo:acme-new", "Repo", "acme/new", liveness="active")
    snap = capture("https://api.github.com/repos/acme/old", b'{"archived": true}')
    d = _dec("e:repo:acme-old", snap, successor="acme/new")
    con = gold()
    try:
        p = verdict.build(d, "live-rules@1", con)
    finally:
        con.close()
    assert p["successor"] == "e:repo:acme-new" and p["status"] == "superseded"
    verdict.write(p)
    con = gold()
    try:
        e = con.execute("SELECT src, rtype, dst FROM edge WHERE rtype='SUCCESSOR_OF' AND expired_at IS NULL").fetchall()
    finally:
        con.close()
    assert e == [("e:repo:acme-new", "SUCCESSOR_OF", "e:repo:acme-old")]
    assert node("e:repo:acme-old")["eff_status"] == "superseded"


def test_non_primary_signal_source_is_rejected(env):
    source("src:blog", "secondary")
    put_entity("e:repo:acme-p", "Repo", "acme/p")
    snap = capture("https://blog.example/post", b"acme/p is dead", src="src:blog")
    d = _dec("e:repo:acme-p", snap, successor="acme/q")
    con = gold()
    try:
        with pytest.raises(verdict.VerdictRejected) as e:
            verdict.build(d, "live-rules@1", con)
    finally:
        con.close()
    assert e.value.code == "E_LIVENESS_SOURCE"
    with pytest.raises(verdict.VerdictRejected) as e2:     # 스냅샷이 없는 신호도 거부
        verdict.build(Decision("e:repo:acme-p", "repo", "removed", [Sig("M12", "removed", None, "x")]), "t", gold())
    assert e2.value.code == "E_NO_EVIDENCE"


def test_liveness_unknown_claim_is_released_after_verdict(env):
    from kb.gate import tick_stage
    source()
    put_entity("e:repo:acme-r", "Repo", "acme/r", props={"repo": "acme/r"})        # liveness 없음
    cid = det_claim("e:repo:acme-r", "r1")
    assert tick_stage.run().detail["held"] == 1
    assert node(cid)["verification"] == "needs_review"
    snap = capture("https://api.github.com/repos/acme/r", json.dumps({"full_name": "acme/r", "archived": False, "pushed_at": "2027-01-10T00:00:00Z"}).encode())
    fx = probe.OfflineFetcher({"https://api.github.com/repos/acme/r": {"status": 200, "snapshot": snap, "source": "src:prim",
                                                                        "body": {"full_name": "acme/r", "archived": False, "pushed_at": "2027-01-10T00:00:00Z"}}})
    con = gold()
    try:
        t = runner._target({"id": "e:repo:acme-r", "type": "Repo", "label": "acme/r", "liveness": None, "props": {"repo": "acme/r"}})
        out = runner.run([t], fx, now=NOW, con=con)
    finally:
        con.close()
    assert out["written"] == 1 and out["released"] == 1, out
    assert node(cid)["verification"] == "parser_derived"
    assert node("e:repo:acme-r")["liveness"] == "active"
    from kb.core import opsdb
    c = opsdb.connect()
    try:      # 판정된 대상은 live 큐에서 다음 재확인 시각으로 미뤄진다
        n, at = c.execute("SELECT count(*), max(next_at) FROM queue WHERE kind='live' AND ref='e:repo:acme-r'").fetchone()
    finally:
        c.close()
    assert n == 1 and at and at > NOW
