"""R_ALIAS_MISMATCH의 비교 대상(known)에서 빠지는 별칭은 L2가 등록한 provisional Concept의 한글 별칭뿐이다.
라틴 문자 별칭, 다른 타입, 다른 주체의 별칭은 그대로 막는다. L2라는 출처는 묶음이 주장할 수 없다(ADR-0001 10.6 5단계)."""
import json

import pytest

from kb.cli import main
from kb.ingest.store import Gold
from kb.write import commit
from kb.write.engine import project_pending

from .conftest import bundle, capture, gold, res, run

DOC = """# Widget Toolkit

The Widget Toolkit stores 5 widgets per page.

Orbit Cache stores 9 items per page. Notes on 스트리밍 are in another chapter.

Cache eviction is LRU.
""".encode()
KO = "Widget Toolkit은 페이지당 5개 위젯을 저장하며 스트리밍과 무관하다."
DISNEY = "Disney의 Widget Toolkit은 페이지당 5개 위젯을 저장한다."
Q = "stores 5 widgets per page"
PROV = {"provisional": True}
STREAM = {"item": "entity", "ref": "e9", "key": "concept:stream-t", "type": "Concept", "label": "Streaming Service"}


@pytest.fixture
def snap(env):
    return capture("https://example.org/widget-alias", DOC)


def put(eid, label, actor, props=None, aliases=("스트리밍",), typ="Concept"):
    p = {"id": eid, "type": typ, "label": label, "aliases": list(aliases), "domain": ["A"]}
    if props is not None:
        p["props"] = props
    commit([{"kind": "entity.put", "actor": actor, "origin": "external", "subject": eid,
             "idem_key": f"t:{actor}:{eid}:{label}:{json.dumps(p, sort_keys=True)}", "payload": p}], actor)
    project_pending()


def claim(snap, statement=KO):
    ent = {"item": "entity", "ref": "e1", "key": "concept:widget-toolkit", "type": "Concept", "label": "Widget Toolkit"}
    cl = {"item": "claim", "ref": "c1", "subject": "e1", "statement": statement, "kind": "state", "stance": "stated",
          "evidence": {"snapshot": snap, "quote": Q}, "method": "llm"}
    return run([ent, cl])


def codes(rep):
    r = res(rep, "c1")
    return r["result"], (r.get("would_be") or {}).get("codes") or r.get("code")


def flagged(snap, statement=KO):
    return codes(claim(snap, statement)) == ("needs_review", ["R_ALIAS_MISMATCH"])


def row(nid):
    c = gold()
    try:
        a, p = c.execute("SELECT author, CAST(props AS TEXT) FROM node WHERE id=? AND expired_at IS NULL", (nid,)).fetchone()
    finally:
        c.close()
    return a, json.loads(p) if p else {}


def test_trusted_alias_still_flags(env, snap):
    put("e:concept:stream-t", "Streaming Service", "parser")
    assert flagged(snap)


def test_l2_hangul_concept_alias_is_ignored(env, snap):
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV)
    assert codes(claim(snap)) == ("accepted", None)


@pytest.mark.parametrize("typ", ["Concept", "Org", "Product", "Platform"])
def test_review_input_disney_stays_flagged(env, snap, typ):
    """리뷰 B1: 문서에 없는 Disney가 문장에 붙는다. L2가 provisional로 등록했어도 타입과 무관하게 잡는다."""
    put(f"e:{typ.lower()}:disney", "Disney", "agent:l2", PROV, aliases=("Disney",), typ=typ)
    assert flagged(snap, DISNEY)


def test_hangul_alias_of_non_concept_stays_flagged(env, snap):
    put("e:org:stream-co", "스트리밍", "agent:l2", PROV, typ="Org")
    assert flagged(snap)


def test_rule_is_per_alias_not_per_node(env, snap):
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV, aliases=("Disney",))
    assert codes(claim(snap)) == ("accepted", None)
    assert flagged(snap, DISNEY)


def test_new_subject_from_non_l2_producer_is_trusted(env, snap):
    """kb-collector의 __new__도 provisional이지만 L2가 아니므로 별칭이 남는다."""
    doc2 = capture("https://example.org/widget-alias2", DOC + "\n스트리밍 is a Korean word here.\n".encode())
    first = {"item": "claim", "ref": "c0", "subject": "__new__", "subject_new": {"label": "스트리밍", "type": "Concept"},
             "statement": "스트리밍은 한국어 단어다.", "kind": "state", "stance": "stated",
             "evidence": {"snapshot": doc2, "quote": "스트리밍 is a Korean word here"}, "method": "llm"}
    assert res(run([first], write=True, producer="agent:kb-collector"), "c0")["result"] == "accepted"
    project_pending()
    assert flagged(snap)


def test_trusted_wins_when_alias_shared(env, snap):
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV)
    put("e:concept:stream-t", "Streaming Service", "parser")
    assert flagged(snap)


def test_all_aliases_default_unchanged(env):
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV)
    g = Gold()
    try:
        assert "스트리밍" in g.all_aliases()
        assert "스트리밍" not in g.all_aliases(trusted_only=True)
    finally:
        g.close()


def test_in_batch_l2_rule_matches_gold_rule(env, snap):
    """같은 L2 묶음 안에서도 규칙이 같다: 앞 항목이 만든 한글 Concept은 뒤 항목을 막지 않고, 라틴 문자 별칭은 막는다."""
    from kb import ingest
    doc2 = capture("https://example.org/widget-alias2", DOC + "\n스트리밍 and Disney are words here.\n".encode())

    def first(ref, label):
        return {"item": "claim", "ref": ref, "subject": "__new__", "subject_new": {"label": label, "type": "Concept"},
                "statement": f"{label}는 단어다.", "kind": "state", "stance": "stated",
                "evidence": {"snapshot": doc2, "quote": "스트리밍 and Disney are words here"}, "method": "llm"}
    ent = {"item": "entity", "ref": "e1", "key": "concept:widget-toolkit", "type": "Concept", "label": "Widget Toolkit"}

    def second(ref, st):
        return {"item": "claim", "ref": ref, "subject": "e1", "statement": st, "kind": "state", "stance": "stated",
                "evidence": {"snapshot": doc2, "quote": Q}, "method": "llm"}
    items = [ent, first("c0", "스트리밍"), first("c9", "Disney"), second("c1", KO), second("c2", DISNEY)]
    rep2 = run(items, producer="agent:kb-collector")
    assert "R_ALIAS_MISMATCH" in (res(rep2, "c1").get("would_be") or {}).get("codes", [])
    rep = ingest.submit(bundle(items, producer="agent:l2"), fetch=False, windows={})
    assert res(rep, "c0")["result"] == "accepted", res(rep, "c0")
    assert res(rep, "c1")["result"] == "accepted", res(rep, "c1")
    assert "R_ALIAS_MISMATCH" in (res(rep, "c2").get("would_be") or {}).get("codes", [])


@pytest.mark.parametrize("fn", ["validate", "submit"])
def test_collector_claiming_l2_is_rejected(env, snap, fn):
    """리뷰 B2: 수집기 묶음이 agent:l2를 주장해도 파서 별칭을 끄지 못한다."""
    from kb import ingest
    put("e:concept:stream-t", "Streaming Service", "parser")
    it = dict(STREAM, props=PROV)
    rep = getattr(ingest, fn)(bundle([it], producer="agent:l2"), fetch=False, profile="collector")
    r = res(rep, "e9")
    assert (r["result"], r["code"]) == ("rejected", "E_POLICY") and rep.new_events == 0
    project_pending()
    assert row("e:concept:stream-t") == ("parser", {}) and flagged(snap)


def test_kb_ingest_cli_claiming_l2_is_rejected(env, snap, tmp_path, capsys):
    put("e:concept:stream-t", "Streaming Service", "parser")
    p = tmp_path / "b.jsonl"
    p.write_text("\n".join(json.dumps(o, ensure_ascii=False) for o in bundle([dict(STREAM, props=PROV)], producer="agent:l2")))
    assert main(["ingest", "submit", str(p), "--no-fetch", "--json"]) == 1
    assert "E_POLICY" in capsys.readouterr().out
    project_pending()
    assert row("e:concept:stream-t") == ("parser", {}) and flagged(snap)


def test_entity_item_cannot_set_provisional(env, snap):
    put("e:concept:stream-t", "Streaming Service", "parser")
    rep = run([dict(STREAM, props=dict(PROV, note="x"))], write=True, producer="agent:kb-collector")
    assert res(rep, "e9")["result"] == "accepted"
    project_pending()
    assert row("e:concept:stream-t") == ("agent:kb-collector", {"note": "x"}) and flagged(snap)


@pytest.mark.parametrize("extra", [{}, {"aliases": ["Streamingo"]}], ids=["identical", "new_alias"])
def test_trusted_entity_item_confirms(env, snap, extra):
    """리뷰 M1: 내용이 같은 재등록이나 새 별칭만 있는 항목도 확정이다. 표시가 지워지고 author가 바뀐다."""
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV)
    assert codes(claim(snap)) == ("accepted", None)
    it = {"item": "entity", "ref": "e9", "key": "concept:x-stream", "type": "Concept", "label": "스트리밍", **extra}
    assert res(run([it], write=True, producer="agent:kb-collector"), "e9")["result"] == "accepted"
    project_pending()
    assert row("e:concept:x-stream") == ("agent:kb-collector", {}) and flagged(snap)


def test_identical_put_by_other_actor_makes_new_version(env, snap):
    """묶음을 거치지 않는 쓰기: 같은 내용이어도 투영이 새 버전을 쓴다."""
    put("e:concept:x-stream", "스트리밍", "agent:l2", PROV)
    put("e:concept:x-stream", "스트리밍", "agent:kb-collector", PROV)
    assert row("e:concept:x-stream")[0] == "agent:kb-collector" and flagged(snap)


def test_identical_put_on_other_nodes_makes_no_version(env):
    put("e:concept:stream-t", "Streaming Service", "parser", {"a": 1})
    put("e:concept:stream-t", "Streaming Service", "agent:kb-collector", {"a": 1})
    assert row("e:concept:stream-t")[0] == "parser"
    put("e:concept:x-plain", "plain", "agent:l2", {"a": 1})
    put("e:concept:x-plain", "plain", "parser", {"a": 1})
    assert row("e:concept:x-plain")[0] == "agent:l2"          # provisional이 아니면 재등록은 그대로다


def test_l2_actor_constant_matches_producer():
    from kb.extract.items import PRODUCER
    from kb.project.apply import L2_ACTOR
    assert L2_ACTOR == PRODUCER
