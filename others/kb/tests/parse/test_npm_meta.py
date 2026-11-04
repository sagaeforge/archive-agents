"""npm_meta@1 골든 시험(ADR-0004 D1). 세 모양(버전 문서, 전체 packument, 축약 메타)에서 같은 주장을 내고,
주장의 jsonpointer가 표시 본문에서 풀리며, 끝에서 끝까지 쓰기 게이트를 지나 gold에 들어간다."""
import json

from kb.parse import tick_stage
from kb.parse.events import resolve_pointer

from .conftest import capture, fx, gold
from .test_formats import ctx_for
from .test_pipeline import set_registry, src_raw, tctx

PACKUMENT_GOLDEN = [
    ("latest_version", "2.0.1", "/dist-tags/latest", '"2.0.1"', {}),
    ("license", "MIT", "/license", '"MIT"', {}),
]
ABBREVIATED_GOLDEN = [
    ("latest_version", "0.9.0", "/dist-tags/latest", '"0.9.0"', {}),
    ("maintained_status", "deprecated", "/versions/0.9.0/deprecated", '"Renamed to @scope/demo-tool2"', {"version": "0.9.0"}),
]


def _rows(res):
    return [(c.predicate, c.value, c.selector["json_pointer"], c.selector["exact"], c.qualifiers or {}) for c in res.claims]


def test_full_packument_golden():
    ad, c = ctx_for("n", "npm_meta", fx("npm_packument.json"), "application/json", url="https://registry.npmjs.org/demo-pkg")
    res = ad.parse(c)
    assert _rows(res) == PACKUMENT_GOLDEN
    assert [(e.id, e.type, e.label) for e in res.entities] == [("e:package:npm-demo-pkg", "Package", "demo-pkg")]
    doc = json.loads(c.text.text)
    for cl in res.claims:
        assert resolve_pointer(doc, cl.selector["json_pointer"]) is not None


def test_abbreviated_metadata_golden_has_no_license_and_marks_deprecated():
    ad, c = ctx_for("n", "npm_meta", fx("npm_abbreviated.json"), "application/vnd.npm.install-v1+json",
                    url="https://registry.npmjs.org/@scope/demo-tool")
    res = ad.parse(c)
    assert _rows(res) == ABBREVIATED_GOLDEN
    assert res.entities[0].id == "e:package:npm-scope-demo-tool"
    doc = json.loads(c.text.text)
    for cl in res.claims:
        assert json.dumps(resolve_pointer(doc, cl.selector["json_pointer"]), ensure_ascii=False) == cl.selector["exact"]


def test_version_document_shape_is_unchanged():
    ad, c = ctx_for("n", "npm_meta", fx("npm.json"), "application/json")
    res = ad.parse(c)
    got = {x.predicate: (x.value, x.selector["json_pointer"]) for x in res.claims}
    assert got["latest_version"][1] == "/version" and got["license"] == ("SEE LICENSE IN README.md", "/license")


def test_unknown_shape_gives_no_claims():
    ad, c = ctx_for("n", "npm_meta", b'{"error": "Not found"}', "application/json")
    res = ad.parse(c)
    assert res.claims == [] and "no_package" in res.notes
    ad, c = ctx_for("n", "npm_meta", b'{"name": "x", "dist-tags": {}}', "application/json")
    assert ad.parse(c).claims == []


def test_packument_claims_pass_the_write_gate_into_gold(env):
    url = "https://registry.npmjs.org/demo-pkg"
    set_registry(env, [src_raw("src:npmr", "npm_meta@1", url, l2="none")])
    capture(url, fx("npm_packument.json"), "application/json", source="src:npmr")
    res = tick_stage.run(tctx())
    assert res.ok and res.detail["parsed"] == 1 and not res.errors
    con = gold()
    rows = con.execute("SELECT c.predicate, c.value, c.method, n.verification FROM node n JOIN claim c ON c.vid=n.vid "
                       "WHERE n.type='Claim' AND n.expired_at IS NULL ORDER BY c.predicate").fetchall()
    assert rows == [("latest_version", "2.0.1", "deterministic", "parser_derived"), ("license", "MIT", "deterministic", "parser_derived")]
    assert con.execute("SELECT count(*) FROM evidence WHERE selector_kind='jsonpointer'").fetchone()[0] == 2
    assert con.execute("SELECT label FROM node WHERE id='e:package:npm-demo-pkg' AND expired_at IS NULL").fetchone() == ("demo-pkg",)


def test_abbreviated_claims_pass_the_write_gate_into_gold(env):
    url = "https://registry.npmjs.org/@scope/demo-tool"
    set_registry(env, [src_raw("src:npmr", "npm_meta@1", url, l2="none")])
    capture(url, fx("npm_abbreviated.json"), "application/vnd.npm.install-v1+json", source="src:npmr")
    res = tick_stage.run(tctx())
    assert res.ok and res.detail["parsed"] == 1 and not res.errors
    con = gold()
    rows = con.execute("SELECT c.predicate, c.value FROM node n JOIN claim c ON c.vid=n.vid WHERE n.type='Claim' AND n.expired_at IS NULL "
                       "ORDER BY c.predicate").fetchall()
    assert rows == [("latest_version", "0.9.0"), ("maintained_status", "deprecated")]
