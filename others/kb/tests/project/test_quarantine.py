"""투영 불가 이벤트의 격리와 복귀."""
import sqlite3

import pytest

from kb.core import cas, ledger
from kb.core.canon import canon_json
from kb.project import (apply as ap, current_gold_path, fingerprint_conn, open_gold, project_tail, rebuild, replay)
from projhelp import E, new_gold


def _ent(i):
    return E("entity.put", {"id": f"e:tool:t{i}", "type": "Tool", "label": f"t{i}"}, f"e:tool:t{i}")


def _quarantine_events(led):
    return [e for e in ledger.iter_events(led, 0, 1000) if e["kind"] == "system.projection_quarantined"]


def test_unprojectable_event_is_quarantined_and_rest_applied(led, kb_home):
    bad = E("edge.put", {"oops": 1}, "r-bad")  # id, src, rtype, dst 없음 -> 적용 불가
    res = ledger.append(led, [_ent(1), bad, _ent(2), _ent(3)])
    bad_seq = res[1]["seq"]
    g = new_gold(kb_home, "q")
    r = project_tail(led, g, None, 10 ** 6)
    assert r.quarantined == [bad_seq] and r.caught_up
    qs = _quarantine_events(led)
    assert len(qs) == 1 and qs[0]["payload"]["seq"] == bad_seq
    ids = {x[0] for x in g.execute("SELECT id FROM node")}
    assert {"e:tool:t1", "e:tool:t2", "e:tool:t3"} <= ids
    assert g.execute("SELECT seq FROM quarantine").fetchall() == [(bad_seq,)]
    # 전체 재구축 = 증분
    g2 = new_gold(kb_home, "q2")
    replay(led, g2)
    assert fingerprint_conn(g2) == fingerprint_conn(g)
    g.close(); g2.close()


def test_release_restores_after_cause_fixed(led, kb_home):
    text = "첫 문단입니다.\n\n둘째 문단입니다."
    from kb.core.canon import sha256_hex
    tsha = sha256_hex(text)  # CAS에는 아직 넣지 않는다 -> 객체 없음으로 투영 불가
    paras = [{"para_sha": sha256_hex("첫 문단입니다."), "start_cp": 0, "end_cp": 8, "heading_path": [], "table_header": None},
             {"para_sha": sha256_hex("둘째 문단입니다."), "start_cp": 10, "end_cp": 18, "heading_path": [], "table_header": None}]
    psha = sha256_hex(canon_json(paras))
    evs = [E("snapshot.captured", {"id": "n-1", "document_id": "d-1", "source": "src:a", "url": "https://a.b/", "raw_sha": "a" * 64,
                                   "fetched_at": 1}, "n-1"),
           E("snapshot.text", {"snapshot": "n-1", "text_sha": tsha, "text_format": "text", "extractor": "x@1", "paras_sha": psha}, "n-1"),
           _ent(1)]
    res = ledger.append(led, evs)
    g_path = kb_home / "scratch" / "r.db"
    g = new_gold(kb_home, "r")
    r = project_tail(led, g, None, 10 ** 6)
    assert r.quarantined == [res[1]["seq"]]
    assert g.execute("SELECT count(*) FROM span WHERE ref_kind='document'").fetchone()[0] == 0
    g.close()
    # 원인을 고친다: CAS 객체를 넣고 release 뒤 재구축
    cas.put(text.encode()); cas.put(canon_json(paras))
    ledger.append(led, [E("system.projection_released", {"seq": res[1]["seq"]}, str(res[1]["seq"]), origin="system", actor="system")])
    b = rebuild(led=led)
    assert b.fingerprint_ok and not b.missing
    g2 = open_gold(current_gold_path())
    assert g2.execute("SELECT count(*) FROM quarantine").fetchone()[0] == 0
    assert g2.execute("SELECT count(*) FROM span WHERE ref_kind='document' AND rec_to IS NULL").fetchone()[0] == 2
    g2.close()


def test_environment_failure_is_not_quarantined(led, kb_home, monkeypatch):
    res = ledger.append(led, [_ent(1), _ent(2), _ent(3)])
    real = ap.apply_event
    state = {"fail": True}

    def flaky(c, e):
        if e["seq"] == res[1]["seq"] and state["fail"]:
            raise sqlite3.OperationalError("database or disk is full")
        return real(c, e)
    monkeypatch.setattr(ap, "apply_event", flaky)
    g = new_gold(kb_home, "env")
    r = project_tail(led, g, None, 10 ** 6)
    assert r.env_error and r.stopped == "env" and not r.caught_up and not r.quarantined
    assert r.last_seq == res[0]["seq"]
    assert not _quarantine_events(led)
    state["fail"] = False
    r2 = project_tail(led, g, None, 10 ** 6)
    assert r2.caught_up and r2.last_seq == res[2]["seq"]
    assert g.execute("SELECT count(*) FROM node").fetchone()[0] == 3
    g.close()
