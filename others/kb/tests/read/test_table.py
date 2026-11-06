"""표 문법: filter(name:op:value), sort, 커서. 계약 4장."""
import pytest

from kb import read
from kb.read.nodes import build_list_query
from .rhelp import E, entity

TYPE = {"name": "Repo", "kind": "node", "version": 1, "status": "active", "schema_json": {"type": "object", "properties": {
    "stars": {"type": "integer", "x-kb-sortable": True}, "lang": {"type": "string"}, "ratio": {"type": "number", "x-kb-sortable": True},
    "tags": {"type": "array", "items": {"type": "string"}}, "created": {"type": "string", "format": "date-time"},
    "flag": {"type": "boolean"}, "hidden": {"type": "string", "x-kb-filterable": False}}}}

ROWS = [  # id, label, props
    ("a", "Hooks", {"stars": 10, "lang": "go", "ratio": "0.5", "tags": ["x", "y"], "created": "2027-01-01T00:00:00Z", "flag": True}),
    ("b", "hook-lib", {"stars": 9, "lang": "go", "ratio": "1.25", "tags": ["y"], "created": "2027-02-01", "flag": False}),
    ("c", "a:b:c", {"stars": 100, "lang": "Rust", "tags": [], "created": "2026-12-31T23:59:59Z"}),
    ("d", "a,b", {"lang": "go", "hidden": "s"}),
    ("e", "Éa", {"stars": 9, "ratio": 2}),
    ("f", "éa", {"stars": 9}),
    ("g", "zeta", {}),
]


@pytest.fixture
def world(w):
    w.add(E("schema.type_defined", TYPE), *[entity(f"e:repo:{i}", lab, props=p) for i, lab, p in ROWS])
    return w


def q(w, filt=(), sort=None, **kw):
    with w.rd() as (con, c):
        data, page = read.list_nodes(con, c, type="Repo", filter=list(filt) or None, sort=sort, **kw)
        return [x["id"].split(":")[-1] for x in data["items"]], page


def test_and_eq_ne_typed_compare(world):
    w = world
    assert q(w, ["lang:eq:go", "stars:gte:10"])[0] == ["a"]
    assert q(w, ["stars:gt:9"])[0] == ["a", "c"]  # 수 비교: 9 < 10 < 100 (문자열 순서가 아니다)
    assert q(w, ["stars:lt:10"])[0] == ["b", "e", "f"]
    assert q(w, ["stars:ne:9"])[0] == ["a", "c"]  # null은 어떤 연산자에도 거짓
    assert q(w, ["ratio:gte:1.25"])[0] == ["b", "e"]
    assert q(w, ["created:lt:2027-01-15"])[0] == ["a", "c"]  # 시각 비교, 날짜만 있는 값도
    assert q(w, ["created:gte:2027-01-15T00:00:00Z"])[0] == ["b"]
    assert q(w, ["flag:eq:true"])[0] == ["a"] and q(w, ["flag:ne:true"])[0] == ["b"]
    assert q(w, ["tags:eq:y"])[0] == ["a", "b"]  # 배열은 원소 하나가 맞으면 참
    assert q(w, ["lang:eq:go", "lang:ne:go"])[0] == []


def test_value_with_colons_and_in_escape(world):
    w = world
    assert q(w, ["label:eq:a:b:c"])[0] == ["c"]
    assert q(w, [r"label:in:a\,b,zeta"])[0] == ["d", "g"]
    assert q(w, [r"label:in:a\\b,x"])[0] == []
    assert q(w, ["stars:in:10,100"])[0] == ["a", "c"]
    with world.rd() as (con, c):
        with pytest.raises(read.BadParam):
            read.list_nodes(con, c, type="Repo", filter=["label:in:" + ",".join("x" * 1 + str(i) for i in range(101))])


def test_prefix_ascii_case_insensitive_nfc(world):
    w = world
    assert q(w, ["label:prefix:hook"])[0] == ["a", "b"]
    assert q(w, ["label:prefix:HOOK"])[0] == ["a", "b"]
    assert q(w, ["label:prefix:éa"])[0] == ["f"]  # ASCII만 대소문자를 무시한다
    assert q(w, ["label:prefix:éa"])[0] == ["f"]  # NFC로 맞춘 뒤 비교
    assert q(w, ["lang:prefix:r"])[0] == ["c"]


def test_bad_param_cases(world):
    with world.rd() as (con, c):
        for bad in ("nope:eq:1", "stars:prefix:1", "flag:gt:true", "stars:eq:abc", "label", "label:zz:a", "hidden:eq:s", "ratio:in:" + "z",
                    "created:eq:어제"):
            with pytest.raises(read.BadParam):
                read.list_nodes(con, c, type="Repo", filter=[bad])
        for bad in ("lang", "-nope", "tags", "hidden"):
            with pytest.raises(read.BadParam):
                read.list_nodes(con, c, type="Repo", sort=bad)
        with pytest.raises(read.BadParam):  # 타입이 여럿이면 * 키만
            read.list_nodes(con, c, sort="stars")


def test_sort_direction_ties_and_nulls(world):
    w = world
    assert q(w, sort="stars")[0] == ["b", "e", "f", "a", "c", "d", "g"]  # 동률은 id 오름차순, null은 끝
    assert q(w, sort="-stars")[0] == ["c", "a", "b", "e", "f", "d", "g"]  # 내림차순에도 null은 끝
    assert q(w, sort="-label")[0][0] == "f" and q(w, sort="label")[0][0] == "a"  # 코드포인트 순서
    assert q(w, sort="-recorded_at")[0][0] == "g"
    assert q(w)[0] == list("abcdefg")  # 기본은 id 오름차순


def test_cursor_walk_equals_full_list_and_mismatch(world):
    w = world
    for sort in (None, "stars", "-stars", "-ratio", "label"):
        full = q(w, sort=sort)[0]
        got, cur = [], None
        for _ in range(10):
            ids, page = q(w, sort=sort, limit=2, cursor=cur)
            got += ids
            assert page["total"] == 7
            cur = page["next_cursor"]
            if not cur:
                break
            assert page["truncated"] is True
        assert got == full, sort
    _, page = q(w, sort="stars", limit=2)
    with world.rd() as (con, c):
        with pytest.raises(read.CursorMismatch):
            read.list_nodes(con, c, type="Repo", sort="-stars", limit=2, cursor=page["next_cursor"])
        with pytest.raises(read.CursorMismatch):
            read.list_nodes(con, c, type="Repo", sort="stars", limit=2, cursor="not-a-cursor")
    with pytest.raises(read.LimitTooLarge):
        q(world, limit=501)


def test_label_prefix_uses_node_label_index(world):
    with world.rd() as (con, c):
        sql, args = build_list_query(con, c.with_(types=("Repo",)), filters=["label:prefix:hook"], limit=10)
        plan = " ".join(r[3] for r in con.execute("EXPLAIN QUERY PLAN " + sql, args))
        assert "node_label" in plan, plan
