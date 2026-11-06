"""결정적 주장의 자동 대체와 충돌. 순수 함수와 파이프라인 끝에서 끝까지."""
import json

from kb.parse import conflicts, pipeline
from kb.parse.conflicts import resolve, slot_of

from .conftest import capture, gold, mk_source

NOW = 1_790_000_000_000
SUBJ = "e:repo:o-r"


def claim(value, valid_from=None, cid=None):
    p = {"id": cid or f"c-{value}", "subject": SUBJ, "predicate": "latest_version", "value": value, "statement": f"v {value}",
         "slot": slot_of(SUBJ, "latest_version", {})}
    if valid_from:
        p["valid"] = {"from": valid_from}
    return p


def old(value, source="src:a", valid_from=None, payload=True):
    d = {"id": f"c-{value}", "source": source, "value": value, "valid_from": valid_from, "valid_to": None}
    if payload:
        d["payload"] = claim(value, valid_from)
    return d


def test_same_source_functional_value_change_supersedes():
    r = resolve(claim("2"), "src:a", [old("1")], True, NOW)
    assert [e["kind"] for e in r.events] == ["claim.supersede"]
    assert r.events[0]["payload"] == {"id": "c-1", "by": "c-2", "reason": "value_changed"}


def test_different_source_coexists_with_conflicts_edge():
    r = resolve(claim("2"), "src:b", [old("1", "src:a")], True, NOW)
    assert [e["kind"] for e in r.events] == ["edge.put"]
    e = r.events[0]["payload"]
    assert (e["rtype"], e["src"], e["dst"]) == ("CONFLICTS_WITH", "c-2", "c-1")


def test_non_functional_predicate_never_auto_supersedes():
    assert resolve(claim("2"), "src:a", [old("1")], False, NOW).events == []


def test_same_value_or_same_id_is_ignored():
    assert resolve(claim("1"), "src:a", [old("1")], True, NOW).events == []


def test_future_effective_value_closes_old_valid_to_without_superseding():
    r = resolve(claim("2", "2099-01-01"), "src:a", [old("1")], True, NOW)
    assert [e["kind"] for e in r.events] == ["claim.assert"]
    p = r.events[0]["payload"]
    assert p["id"] == "c-1" and p["valid"]["to"] == "2099-01-01"
    assert "claim.supersede" not in [e["kind"] for e in r.events]


def test_retroactive_correction_keeps_old_and_closes_new():
    r = resolve(claim("0", "2020-01-01"), "src:a", [old("1", valid_from="2024-01-01T00:00:00Z")], True, NOW)
    assert r.events == [] and r.new_valid_to == "2024-01-01T00:00:00Z"


def test_functional_predicates_come_from_vocabulary():
    f = conflicts.functional_predicates()
    assert "latest_version" in f and "released_on" not in f


def _release(tag, pub="2026-10-29T00:00:00Z"):
    return json.dumps({"tag_name": tag, "published_at": pub, "name": tag}).encode()


def _parse(env, source, url, body):
    snap = capture(url, body, "application/json", source=source.id)
    return pipeline.parse_snapshot(snap, source)


def test_end_to_end_same_source_supersedes_in_gold(env):
    src = mk_source("src:rel", "github_release@1")
    url = "https://api.github.com/repos/o/r/releases/latest"
    assert _parse(env, src, url, _release("v1.0.0"))["status"] == "ok"
    assert _parse(env, src, url, _release("v1.1.0", "2026-10-30T00:00:00Z"))["status"] == "ok"
    con = gold()
    rows = con.execute("SELECT c.value, n.status FROM node n JOIN claim c ON c.vid=n.vid WHERE c.predicate='latest_version' "
                       "AND n.expired_at IS NULL ORDER BY c.value").fetchall()
    assert rows == [("v1.0.0", "superseded"), ("v1.1.0", "active")]
    assert con.execute("SELECT count(*) FROM edge WHERE rtype='SUPERSEDES' AND expired_at IS NULL").fetchone()[0] == 1


def test_end_to_end_different_sources_conflict_not_supersede(env):
    url = "https://api.github.com/repos/o/r/releases/latest"
    cfg = {"parse": {"entity": {"slug": "same", "label": "Same", "type": "Tool"}}}
    a, b = mk_source("src:a", "github_release@1", **cfg), mk_source("src:b", "github_release@1", **cfg)
    _parse(env, a, url, _release("v1.0.0"))
    _parse(env, b, url + "?x=1", _release("v2.0.0"))
    con = gold()
    rows = con.execute("SELECT c.value, n.status FROM node n JOIN claim c ON c.vid=n.vid WHERE c.predicate='latest_version' "
                       "AND n.expired_at IS NULL ORDER BY c.value").fetchall()
    assert rows == [("v1.0.0", "active"), ("v2.0.0", "active")]
    assert con.execute("SELECT count(*) FROM edge WHERE rtype='CONFLICTS_WITH' AND expired_at IS NULL").fetchone()[0] == 1


def test_end_to_end_future_value_closes_old_valid_to(env):
    from kb.parse import events
    from kb.parse.model import Claim, Result, pointer
    from kb.parse.display import Text
    src = mk_source("src:rel", "github_release@1")
    url = "https://api.github.com/repos/o/r/releases/latest"
    _parse(env, src, url, _release("v1.0.0"))
    snap = capture(url + "?n=2", _release("v9.0.0"), "application/json", source=src.id)
    res = Result(claims=[Claim("e:repo:o-r", "latest_version", "v9.0.0", "미래 효력", pointer("/tag_name", "v9.0.0"),
                               valid_from="2099-01-01", precision="day")])
    txt = Text(json.dumps({"tag_name": "v9.0.0"}), "json", "x")
    evs, st = events.build(snap, res, txt, "0" * 64, "t@1", source=src.id, functional={"latest_version"}, now_ms=NOW)
    assert "claim.supersede" not in [e["kind"] for e in evs] and st["claims"] == 2
