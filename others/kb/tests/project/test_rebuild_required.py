"""release/redact 뒤 재구축(증분이 못 하는 변경), 링크 재생성, 시각 파싱, 승격된 작은 항목."""
from kb.core import ledger
from kb.project import apply as ap
from kb.project import current_gold_path, open_gold, project_tail, rebuild
from kb.project.build import verify_projection
from projhelp import E, entity


def _rec(rid, title, links=None, body="본문"):
    p = {"id": rid, "type": "Note", "title": title, "body": body, "sensitivity": "public"}
    if links:
        p["links"] = links
    return E("record.put", p, rid, origin="first_party", actor="user:sagae")


def _tail_current(led):
    g = open_gold(current_gold_path())
    try:
        project_tail(led, g, None, 10 ** 6)
    finally:
        g.close()


def _marker():
    g = open_gold(current_gold_path())
    try:
        r = g.execute("SELECT v FROM meta WHERE k='rebuild_required_seq'").fetchone()
        return r[0] if r else None
    finally:
        g.close()


def _fts_hits(word):
    from kb.core.text import query_tokens
    g = open_gold(current_gold_path())
    try:
        q = " ".join(query_tokens(word))
        return g.execute("SELECT count(*) FROM fts WHERE fts MATCH ?", (q,)).fetchone()[0]
    finally:
        g.close()


def _quarantined_current(led):
    bad = E("edge.put", {"oops": 1}, "r-bad")
    res = ledger.append(led, [entity("e:tool:a"), bad, entity("e:tool:b")])
    rebuild(led=led)  # 첫 빌드
    _tail_current(led)
    return res[1]["seq"]


def test_release_then_rebuild_is_adopted(led, kb_home):
    seq = _quarantined_current(led)
    ledger.append(led, [E("system.projection_released", {"seq": seq}, str(seq), origin="system", actor="system")])
    _tail_current(led)
    assert _marker() is not None
    assert verify_projection(led)["rebuild_pending"] is True
    b = rebuild(led=led)
    assert b.swapped and not b.rolled_back and b.fingerprint_ok and b.forced
    assert _marker() is None
    assert "rebuild_pending" not in verify_projection(led) and verify_projection(led)["ok"]
    b2 = rebuild(led=led)  # 표시가 없으면 평소처럼 지문을 비교한다
    assert b2.fingerprint_compared and b2.fingerprint_ok and not b2.forced


def test_redact_then_rebuild_removes_derived(led, kb_home):
    _quarantined_current(led)
    ledger.append(led, [_rec("n-1", "zzsecrettitle 비밀")])
    _tail_current(led)
    assert _fts_hits("zzsecrettitle") >= 1
    ledger.redact(led, "n-1", "유출", "user:sagae")
    _tail_current(led)
    assert _marker() is not None
    b = rebuild(led=led)
    assert b.swapped and not b.rolled_back and b.forced
    assert _fts_hits("zzsecrettitle") == 0
    g = open_gold(current_gold_path())
    assert g.execute("SELECT count(*) FROM node WHERE label LIKE '%zzsecrettitle%'").fetchone()[0] == 0
    g.close()


def test_redacted_tombstone_replays(led, kb_home):
    ledger.append(led, [_rec("n-2", "제목")])
    ledger.append(led, [E("record.tombstone", {"id": "n-2", "reason": "x"}, "n-2", origin="first_party", actor="user:sagae")])
    ledger.redact(led, "n-2", "t", "user:sagae")
    b = rebuild(led=led)
    assert b.swapped and not b.quarantined


def test_link_removed_and_readded(led, kb_home):
    ln = [{"rtype": "relates_to", "dst": "e:tool:a"}]
    ledger.append(led, [entity("e:tool:a"), _rec("n-3", "t", ln)])
    ledger.append(led, [_rec("n-3", "t", [], body="두번째")])
    ledger.append(led, [_rec("n-3", "t", ln, body="세번째")])
    b = rebuild(led=led)
    assert b.swapped and not b.quarantined
    g = open_gold(current_gold_path())
    vs = [r[0] for r in g.execute("SELECT version FROM edge WHERE src='n-3' ORDER BY version")]
    g.close()
    assert vs == [1, 2]


def test_parse_time_offsets_and_quarter():
    assert ap.parse_time("2026-01-01T09:00:00+09:00") == (ap.parse_time("2026-01-01T00:00:00Z")[0], "instant")
    assert ap.parse_time("2026-01-01T00:00:00-05:00")[0] == ap.parse_time("2026-01-01T05:00:00Z")[0]
    assert ap.parse_time("2026-Q2") == (ap.parse_time("2026-04-01")[0], "quarter")
