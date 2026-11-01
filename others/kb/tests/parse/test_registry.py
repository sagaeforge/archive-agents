"""소스 레지스트리(sources/domains/*.yaml): 구조, 인벤토리 111개 분류, ADR 10.4 표 일치. 네트워크 없음."""
import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml
import jsonschema

from kb.collect import hostpolicy, registry

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "sources"

INVENTORY = ([f"P{i:02d}" for i in range(1, 16)] + [f"X{i:02d}" for i in range(1, 22)] + [f"D{i:02d}" for i in range(1, 24)] +
             [f"C{i:02d}" for i in range(1, 17)] + [f"O{i:02d}" for i in range(1, 14)] + [f"U{i:02d}" for i in range(1, 17)] +
             [f"L{i:02d}" for i in range(1, 8)])
# ADR 10.4 초기 비활성 표
ADR_INACTIVE = ([f"P{i:02d}" for i in (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15)] + [f"X{i:02d}" for i in range(1, 15)] +
                [f"X{i}" for i in (18, 19, 20, 21)] + ["D02", "D05", "D06", "D07", "D08", "D11", "D14", "D18", "D20", "D23",
                                                       "L06", "L07", "O13", "U03", "U07", "U12", "U13", "U16"])
# ADR 10.4 약관 등급 표
TOS = {
    "allowed": [f"C{i:02d}" for i in range(1, 17)] + ["U01", "U02", "O01", "O08", "O11", "U04", "L02", "O07", "X15", "D16", "X17",
                                                        "src:f-tools", "src:g4-repos"],
    "no_clause": ["P10", "L01", "U06", "X16", "D15", "D19", "D22", "src:yt-api-docs"],
    "unverified": ["D01", "D03", "D04", "D09", "D10", "D12", "D13", "D17", "D23", "L03", "L04", "L05", "M21", "O10", "U05", "U08",
                   "U09", "U10", "U11", "U14", "U15", "src:g4-npm"],
    "signals_conflict": ["O02", "O03", "O04", "O05", "O06", "O09", "O12", "O13", "U03", "U16", "D21", "D05"],
    "forbidden": ["X11", "D20", "D11", "D18", "P05", "P06", "P11", "P12", "P13", "P14", "X01", "D14"],
}

SCHEMA = {
    "type": "object",
    "required": ["id", "name", "domain", "class", "fetch", "policy"],
    "properties": {
        "id": {"type": "string", "pattern": r"^src:[a-z0-9]+([._-][a-z0-9]+)*$"},
        "inventory_id": {"type": ["string", "null"], "pattern": r"^[A-Z][0-9]{2}$"},
        "name": {"type": "string", "minLength": 1},
        "domain": {"type": "array", "items": {"enum": list("ABCDEFG")}, "minItems": 1, "uniqueItems": True},
        "class": {"type": "string"},
        "fetch": {"type": "object", "required": ["kind"], "properties": {
            "kind": {"enum": ["https", "local_exec"]}, "url": {"type": "string", "pattern": r"^https://"},
            "urls": {"type": "array", "minItems": 1, "items": {"anyOf": [
                {"type": "string", "pattern": r"^https://"},
                {"type": "object", "required": ["url"], "properties": {"url": {"type": "string"}, "requires_decision": {"type": "integer"}}}]}},
            "discover": {"type": "object", "required": ["kind", "max_pages"], "properties": {
                "kind": {"enum": ["llms_txt", "sitemap", "html_index"]}, "max_pages": {"type": "integer", "minimum": 1},
                "max_depth": {"type": "integer"}, "include": {"type": "array"}, "exclude": {"type": "array"}, "selector": {"type": "string"}}},
            "conditional": {"type": "boolean"}, "interval_s": {"type": "integer"}, "max_pages_per_tick": {"type": "integer"}}},
        "parser": {"type": "string", "pattern": r"^[a-z_]+@[0-9]+$"},
        "parse": {"type": "object"},
        "expect": {"type": "object"},
        "fallbacks": {"type": "array", "items": {"type": "string"}},
        "policy": {"type": "object", "required": ["enabled", "tos", "tos_ref", "robots", "requires_decision", "trust", "retention", "pii",
                                                  "needs_contact"], "properties": {
            "enabled": {"type": "boolean"}, "tos": {"enum": list(registry.TOS_RANK)}, "tos_ref": {"type": ["string", "null"]},
            "robots": {"enum": list(registry.ROBOTS_MODES)}, "requires_decision": {"type": ["integer", "null"]},
            "trust": {"enum": ["primary", "secondary", "community", "unknown"]},
            "retention": {"enum": ["permanent", "ttl"]}, "pii": {"type": "boolean"}, "needs_contact": {"type": "boolean"},
            "reason": {"type": "string"}}},
    },
}


@pytest.fixture(scope="module")
def srcs():
    assert not (SRC / "overlays").exists(), "기본 레지스트리 시험은 overlay 없이 돈다"
    return registry.load_registry(SRC)


def test_every_domain_file_passes_schema_and_domain_is_a_list():
    files = sorted((SRC / "domains").glob("*.yaml"))
    assert files
    n = 0
    for p in files:
        for e in yaml.safe_load(p.read_text(encoding="utf-8"))["sources"]:
            jsonschema.validate(e, SCHEMA)
            assert isinstance(e["domain"], list)
            n += 1
    assert n >= 111


def test_registry_loads_with_structure_validation(srcs):
    assert len({s.id for s in srcs}) == len(srcs)
    for s in srcs:
        if s.enabled:
            assert s.class_ and s.all_urls()
            assert s.tos != "forbidden"


def test_inventory_111_ids_all_classified(srcs):
    assert len(INVENTORY) == len(set(INVENTORY)) == 111
    inv = {}
    for s in srcs:
        if s.inventory_id:
            assert s.inventory_id not in inv, f"inventory_id 중복: {s.inventory_id}"
            inv[s.inventory_id] = s
    assert set(INVENTORY) <= set(inv)
    for i in INVENTORY:
        s = inv[i]
        pol = s.policy
        if pol["enabled"]:
            assert pol["requires_decision"] in (None, 8, 9), i
        else:
            assert pol.get("reason"), f"{i}: 비활성 사유가 없다"


def test_adr_inactive_table_is_not_active(srcs):
    by = {s.inventory_id: s for s in srcs if s.inventory_id}
    for i in ADR_INACTIVE:
        assert by[i].enabled is False, i


def test_tos_matches_adr_grade_table(srcs):
    by = {}
    for s in srcs:
        by[s.id] = s
        if s.inventory_id:
            by[s.inventory_id] = s
    for grade, ids_ in TOS.items():
        for i in ids_:
            assert by[i].tos == grade, f"{i}: {by[i].tos} != {grade}"


def test_decision_8_and_9_sources_start_enabled_with_requires_decision(srcs):
    by = {s.inventory_id: s for s in srcs if s.inventory_id}
    for i in ("X15", "D16", "X17"):
        assert by[i].enabled and by[i].policy["requires_decision"] == 8 and by[i].policy["robots"] == "official_api"
        assert by[i].policy["tos_ref"]
    for s in srcs:
        if s.enabled and s.tos == "signals_conflict":
            assert s.policy["requires_decision"] == 9, s.id
    for i in ("O02", "O03", "O04", "O05", "O06", "O09", "O12", "D21"):
        assert by[i].enabled and by[i].policy["requires_decision"] == 9


def test_d2_naver_url_needs_decision_9_and_unverified_stay_active(srcs):
    u11 = next(s for s in srcs if s.inventory_id == "U11")
    assert u11.enabled and u11.policy["requires_decision"] is None and u11.tos == "unverified"
    assert dict(u11.static_urls())["https://d2.naver.com/d2.atom"] == 9
    assert [u for u, d in u11.static_urls() if d is None] == ["https://tech.kakao.com/feed/", "https://techblog.woowahan.com/feed/",
                                                              "https://toss.tech/rss.xml"]


def test_fetch_and_discover_fields(srcs):
    kinds = {}
    for s in srcs:
        if not s.enabled:
            continue
        assert s.fetch.get("url") or s.fetch.get("urls"), s.id
        if s.discover:
            assert s.discover["kind"] and s.fetch["url"] and s.discover["max_pages"] >= 1
            kinds[s.inventory_id] = s.discover["kind"]
    assert kinds["C03"] == "llms_txt" and kinds["C04"] == "llms_txt" and kinds["O02"] == "llms_txt"
    assert kinds["C09"] == "sitemap" and kinds["C08"] == "html_index"


def test_no_forbidden_active_and_hosts_not_denied(srcs, monkeypatch):
    monkeypatch.setenv("KB_SHARE", str(REPO))
    assert [s.id for s in srcs if s.enabled and s.tos == "forbidden"] == []
    for s in srcs:
        if not s.enabled:
            continue
        for u in s.all_urls():
            h = urlsplit(u).hostname
            assert hostpolicy.denied_reason(h) is None, f"{s.id}: {h} 거부 호스트"


def test_youtube_automation_paths_are_not_built(srcs):
    for s in srcs:
        for u in s.all_urls():
            h = urlsplit(u).hostname or ""
            assert not (h.endswith("youtube.com") or h.endswith("youtu.be")) or not s.enabled, s.id
    by = {s.inventory_id: s for s in srcs if s.inventory_id}
    for i in ("P04", "P05", "P06", "P07", "P09", "P13", "P14", "D14", "D18"):
        assert not by[i].enabled


def test_class_matches_classes_yaml_ids(srcs):
    cls = yaml.safe_load((SRC / "classes.yaml").read_text())["classes"]
    want = {i: name for name, c in cls.items() for i in c.get("ids", [])}
    for s in srcs:
        key = s.inventory_id if s.inventory_id in want else s.id if s.id in want else None
        if key and s.enabled:
            assert s.class_ == want[key], f"{s.id}: {s.class_} != {want[key]}"


def test_parser_refs_exist_for_active_sources(srcs):
    from kb.parse import adapters
    for s in srcs:
        if s.enabled or s.parser:
            assert adapters.get(s.parser) is not None, f"{s.id}: 알 수 없는 parser {s.parser}"


def test_d19_url_and_yt_docs_and_f_tools(srcs):
    by = {s.id: s for s in srcs}
    assert by["src:yt-how-recommendations"].fetch["url"] == "https://support.google.com/youtube/answer/16089387"
    assert len(by["src:yt-api-docs"].static_urls()) == 3 and len(by["src:f-tools"].static_urls()) == 7
    assert by["src:f-tools"].static_urls()[0][0].startswith("https://api.github.com/repos/")
    assert by["src:cc-changelog-gh"].inventory_id == "C01" and by["src:cc-changelog-gh"].parser == "changelog_md@1"
