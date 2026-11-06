"""WP-23 계약 초안 시험: openapi.yaml이 data-interface-v0.md 4장 표와 3장 규칙을 따르는지 본다."""
import json
import re
from pathlib import Path

import jsonschema
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = ROOT / "docs/contracts/openapi.yaml"
MD = (ROOT / "docs/contracts/data-interface-v0.md").read_text(encoding="utf-8")
SPEC = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
SCHEMAS = SPEC["components"]["schemas"]
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]*$")
F = ["types", "origin", "status", "domain", "source", "author", "include_unverified"]
T = ["as_of_valid", "as_of_observed"]


def resolve(node):
    while isinstance(node, dict) and "$ref" in node:
        cur = SPEC
        for part in node["$ref"][2:].split("/"):
            cur = cur[part]
        node = cur
    return node


def walk(node, path=""):
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}/{i}")


def table_rows():
    rows = []
    for line in MD.split("\n"):
        if re.match(r"^\| `/v1/", line):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) == 5:
                path, op_id, data, page, params = cells
                rows.append((path.strip("`"), op_id, data, page, params))
    return rows


ROWS = table_rows()


def expected_params(path, cell):
    names = []
    if "{id}" in path:
        names.append("id")
    if cell.startswith("없음"):
        return set(names)
    for tok in [t.strip() for t in cell.split(",")]:
        if tok == "F":
            names += F
        elif tok == "T":
            names += T
        else:
            names.append(tok.strip("`"))
    return set(names)


def validator(schema):
    wrapper = {"$schema": "https://json-schema.org/draft/2020-12/schema", "components": SPEC["components"], **schema}
    return jsonschema.Draft202012Validator(wrapper)


def op_params(op):
    return [resolve(p) for p in op["parameters"]]


def test_table_has_26_paths():
    assert len(ROWS) == 26
    assert set(r[0] for r in ROWS) == set(SPEC["paths"])
    assert len(SPEC["paths"]) == 26


@pytest.mark.parametrize("row", ROWS, ids=[r[1] for r in ROWS])
def test_operation_matches_table(row):
    path, op_id, data, page, params = row
    assert list(SPEC["paths"][path]) == ["get"]
    op = SPEC["paths"][path]["get"]
    assert op["operationId"] == op_id.strip("`")
    got = {p["name"] for p in op_params(op)}
    assert got == expected_params(path, params)
    names = [p["name"] for p in op_params(op)]
    assert len(names) == len(set(names)), "중복 파라미터"
    ok = op["responses"]["200"]
    media = ok["content"]
    if data.startswith("봉투 없음"):
        assert not any("Envelope" in json.dumps(m["schema"]) for m in media.values())
        return
    data = data.strip("`")
    schema = media["application/json"]["schema"]
    assert schema == {"$ref": f"#/components/schemas/{data}Envelope"}
    env = SCHEMAS[data + "Envelope"]
    assert env["allOf"][0] == {"$ref": "#/components/schemas/Envelope"}
    body = env["allOf"][1]
    want_req = ["data"] + (["page"] if page.strip() else [])
    assert body["required"] == want_req
    assert body["properties"]["data"] == {"$ref": f"#/components/schemas/{data}"}
    assert ("page" in body["properties"]) == bool(page.strip())
    inner = resolve(body["properties"]["data"])
    assert inner and inner != {}, "data가 빈 스키마"


@pytest.mark.parametrize("path", sorted(SPEC["paths"]))
def test_responses(path):
    op = SPEC["paths"][path]["get"]
    twoxx = [c for c in op["responses"] if c.startswith("2")]
    assert twoxx
    for c in twoxx:
        for m in resolve(op["responses"][c])["content"].values():
            assert m["schema"] and m["schema"] != {}
            assert m.get("examples"), f"{path} {c} examples 없음"
    for code, r in op["responses"].items():
        if code.startswith("2"):
            continue
        r = resolve(r)
        if code == "304":
            continue
        assert list(r["content"]) == ["application/problem+json"], (path, code)
        assert r["content"]["application/problem+json"]["schema"] == {"$ref": "#/components/schemas/Problem"}
        if code in ("429", "503"):
            assert r["headers"]["Retry-After"]["required"] is True
    assert "429" in op["responses"] and "503" in op["responses"]
    for p in op_params(op):
        if p["name"] == "id":
            assert p["examples"], f"{path} id examples 없음"
            for ex in p["examples"].values():
                assert ID_RE.match(ex["value"])


def test_429_503_headers_exist_everywhere():
    for path, item in SPEC["paths"].items():
        for code in ("429", "503"):
            r = resolve(item["get"]["responses"][code])
            assert "Retry-After" in r["headers"]


def test_envelope_has_no_data():
    assert "data" not in SCHEMAS["Envelope"]["properties"]
    assert "data" not in SCHEMAS["Envelope"].get("required", [])


def test_discriminated_oneof():
    found = 0
    for path, node in walk(SPEC):
        if isinstance(node, dict) and "oneOf" in node and "discriminator" in node:
            found += 1
            assert node["discriminator"] == {"propertyName": "kind"}, path
            assert "mapping" not in node["discriminator"]
            for v in node["oneOf"]:
                top = resolve(v)
                assert "const" in top["properties"]["kind"], path
                assert "kind" in top["required"], path
    assert found >= 1
    kinds = {resolve(v)["properties"]["kind"]["const"] for v in SCHEMAS["SearchHit"]["oneOf"]}
    assert kinds == {"claim", "record", "entity", "passage"}
    assert not any("mapping" in json.dumps(n) for _, n in walk(SPEC) if isinstance(n, dict) and "discriminator" in n)


def test_no_external_refs():
    for path, node in walk(SPEC):
        if isinstance(node, dict) and "$ref" in node:
            assert node["$ref"].startswith("#/"), (path, node["$ref"])


def test_filter_param_shape():
    p = SPEC["components"]["parameters"]["Filter"]
    assert p["style"] == "form" and p["explode"] is True
    assert p["schema"]["type"] == "array" and p["schema"]["items"] == {"type": "string"}


def test_common_params_in_components():
    names = {resolve(p)["name"] for item in SPEC["paths"].values() for p in item["get"]["parameters"]}
    for n in F + T + ["cursor", "limit", "filter"]:
        assert n in names
    for item in SPEC["paths"].values():
        for p in item["get"]["parameters"]:
            assert "$ref" in p, "파라미터는 components/parameters에 둔다"


def test_provisional():
    for path, item in SPEC["paths"].items():
        if path.startswith("/v1/ops/"):
            assert item["get"]["x-provisional"] is True
        else:
            assert "x-provisional" not in item["get"]
    for n in ("OpsFreshness", "OpsTicketList", "OpsRunList", "OpsMetrics"):
        assert SCHEMAS[n]["x-provisional"] is True


def test_version():
    assert SPEC["openapi"] == "3.1.1"
    assert SPEC["info"]["version"] == "0.3.2"
    assert "servers" not in SPEC


def _ver(s):
    return tuple(int(x) for x in s.split("."))


def test_baseline_in_sync():
    """기준선이 없으면 실패다(계약 8장). 같은 판이면 바이트가 같고, 더 높은 판이면 호환 변경만 허용한다.
    oasdiff가 없는 환경의 최소 점검이다: 경로, 파라미터, 속성, 필수 목록, 닫힌 enum을 줄이지 않는다."""
    base = ROOT / "docs/contracts/baseline/openapi.yaml"
    assert base.exists(), "기준선이 없으면 실패다(계약 8장)"
    b = yaml.safe_load(base.read_text(encoding="utf-8"))
    if _ver(SPEC["info"]["version"]) == _ver(b["info"]["version"]):
        assert base.read_bytes() == SPEC_PATH.read_bytes()
        return
    assert _ver(SPEC["info"]["version"]) > _ver(b["info"]["version"])
    for path, item in b["paths"].items():
        assert path in SPEC["paths"], f"경로 삭제: {path}"
        bp = {resolve_in(b, p)["name"] for p in item["get"]["parameters"]}
        sp = {resolve(p)["name"] for p in SPEC["paths"][path]["get"]["parameters"]}
        assert bp <= sp, f"파라미터 삭제: {path} {bp - sp}"
        assert item["get"]["operationId"] == SPEC["paths"][path]["get"]["operationId"]
    for name, sch in b["components"]["schemas"].items():
        assert name in SCHEMAS, f"스키마 삭제: {name}"
        for pth, node in walk(sch):
            cur = SCHEMAS[name]
            try:
                for part in [x for x in pth.split("/") if x]:
                    cur = cur[int(part)] if isinstance(cur, list) else cur[part]
            except (KeyError, IndexError, ValueError):
                raise AssertionError(f"속성 삭제: {name}{pth}")
            if isinstance(node, dict) and "enum" in node and "$ref" not in node:
                assert cur.get("enum") == node["enum"], f"enum 변경: {name}{pth}"
            if isinstance(node, dict) and "required" in node and isinstance(node["required"], list):
                assert set(node["required"]) <= set(cur.get("required", [])), f"required 완화: {name}{pth}"


def resolve_in(spec, node):
    while isinstance(node, dict) and "$ref" in node:
        cur = spec
        for part in node["$ref"][2:].split("/"):
            cur = cur[part]
        node = cur
    return node


def overlaps(a, b):
    """valid 구간 겹침. from 포함, to 미포함, null은 열림. 날짜 문자열 비교."""
    af, at, bf, bt = a["from"], a["to"], b["from"], b["to"]
    return (af is None or bt is None or af < bt) and (bf is None or at is None or bf < at)


def is_retro_correction(items, i):
    """계약 4.7 정정 판정. t는 items[i]의 recorded_at이다."""
    L = items[i]
    t = L["recorded_at"]
    for j, E in enumerate(items):
        if j == i:
            continue
        alive = E["recorded_at"] <= t and (E["expired_at"] is None or t < E["expired_at"])
        prev = E["id"] == L["id"] and E["version"] == L["version"] - 1
        if (alive and E["id"] != L["id"]) or prev:
            if E["value"] != L["value"] and overlaps(E["valid"], L["valid"]):
                return True
    return False


def test_correction_rule_on_contract_example():
    items = BLOCKS[("4.7", 0)]["data"]["chains"][0]["items"]
    assert [is_retro_correction(items, i) for i in range(3)] == [False, False, False]
    fixed = [dict(x) for x in items]
    fixed[1]["value"] = "5000"
    fixed[1]["valid"] = {"from": "2024-06-01", "to": None}
    assert is_retro_correction(fixed, 1) is True


def test_status_basis_fields():
    claim = SCHEMAS["Claim"]["allOf"][1]["properties"]
    assert {"own_status", "status_basis"} <= set(claim)
    assert {"own_status", "status_basis"} <= set(SCHEMAS["ChainItem"]["properties"])
    assert "in_overview" in SCHEMAS["NodeType"]["properties"]
    assert "id" in SCHEMAS["SearchHitPassage"]["properties"]


def test_edge_status_only_on_graph_routes():
    for path, item in SPEC["paths"].items():
        names = {resolve(p)["name"] for p in item["get"]["parameters"]}
        assert ("edge_status" in names) == (path in ("/v1/overview", "/v1/nodes/{id}/neighbors")), path


def test_core_table_group_cell_has_no_type_name():
    row = [l for l in MD.split("\n") if l.startswith("| `core` | `world`")][0]
    cells = [c.strip() for c in row.strip("|").split("|")]
    assert "`Series`" in cells[1] and "fact" in cells[1]
    assert "unverified" in cells[3] and "needs_review" in cells[3]


# ---- 예시 검증
def md_json_blocks():
    out, sec, cnt, cur = {}, None, {}, None
    for line in MD.split("\n"):
        m = re.match(r"^#{2,3} (\d+(?:\.\d+)?)[. ]", line)
        if m and cur is None:
            sec = m.group(1)
        if cur is None and line.startswith("```json"):
            cur = []
            continue
        if cur is not None and line.startswith("```"):
            i = cnt.get(sec, 0)
            cnt[sec] = i + 1
            out[(sec, i)] = json.loads("\n".join(cur))
            cur = None
            continue
        if cur is not None:
            cur.append(line)
    return out


BLOCKS = md_json_blocks()
# (절, 순번) -> 검증할 스키마 이름. 전체 봉투면 <이름>Envelope, 아니면 data만 검증한다.
DOC_MAP = {
    ("4.1", 0): ("Meta", True), ("4.2", 0): ("SchemaCatalog", False), ("4.3", 0): ("Overview", False),
    ("4.4", 0): ("NodeList", False), ("4.5", 0): ("NodeDetail", False), ("4.6", 0): ("Neighbors", False),
    ("4.7", 0): ("History", False), ("4.8", 0): ("SearchResult", False), ("4.9", 0): ("Facets", False),
    ("4.9", 1): ("Counts", False), ("4.10", 0): ("Series", False), ("4.11", 0): ("Snapshot", False),
    ("4.12", 0): ("ChangeList", False), ("4.14", 0): ("ClaimDetail", False), ("4.14", 1): ("EdgeDetail", False),
    ("5", 0): ("Manifest", False), ("5", 1): ("ExportFile", "file"), ("2.3", 0): ("Problem", "file"),
    ("2.1", 0): ("Envelope", "file"),
}


def test_doc_blocks_all_mapped():
    read_blocks = {k for k in BLOCKS if k[0] and (k[0].startswith("4.") or k[0] in ("5", "2.3", "2.1"))}
    assert read_blocks == set(DOC_MAP)


@pytest.mark.parametrize("key", sorted(DOC_MAP))
def test_doc_example_passes_schema(key):
    name, mode = DOC_MAP[key]
    doc = BLOCKS[key]
    if mode is True:
        validator({"$ref": f"#/components/schemas/{name}Envelope"}).validate(doc)
    elif mode == "file":
        validator({"$ref": f"#/components/schemas/{name}"}).validate(doc)
        if key == ("2.1", 0):
            validator({"$ref": "#/components/schemas/Page"}).validate(doc["page"])
    else:
        validator({"$ref": f"#/components/schemas/{name}"}).validate(doc["data"])
        if "page" in doc:
            validator({"$ref": "#/components/schemas/Page"}).validate(doc["page"])


def test_openapi_examples_pass_schema():
    n = 0
    for path, item in SPEC["paths"].items():
        for code, r in item["get"]["responses"].items():
            r = resolve(r)
            for media, m in r.get("content", {}).items():
                for ex in (m.get("examples") or {}).values():
                    v = ex["value"]
                    if media == "application/json":
                        validator(m["schema"]).validate(v)
                    elif media == "application/zstd":
                        validator({"$ref": "#/components/schemas/ExportFile"}).validate(json.loads(v))
                    elif media == "application/problem+json":
                        validator(m["schema"]).validate(v)
                    n += 1
    assert n >= 26


def public_ids(node, key=None):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from public_ids(v, k)
    elif isinstance(node, list):
        for v in node:
            yield from public_ids(v, key)
    elif isinstance(node, str) and key in ("id", "src", "dst", "snapshot_id", "claim_id", "subject", "superseded_by"):
        yield node


def test_public_ids_match_pattern():
    docs = [d for d in BLOCKS.values()]
    for path, item in SPEC["paths"].items():
        for r in item["get"]["responses"].values():
            r = resolve(r)
            for m in r.get("content", {}).values():
                for ex in (m.get("examples") or {}).values():
                    if isinstance(ex["value"], dict):
                        docs.append(ex["value"])
    for p in SPEC["components"]["parameters"].values():
        for ex in (p.get("examples") or {}).values():
            assert ID_RE.match(ex["value"]), ex
    seen = 0
    for d in docs:
        for s in public_ids(d):
            if s.startswith("src:") or ":" in s or "-" in s or s:
                seen += 1
                assert ID_RE.match(s), s
    assert seen > 50
