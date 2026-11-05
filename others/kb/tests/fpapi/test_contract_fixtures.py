"""FW1 계약 전용 사례. HTTP 구현·dry-run 무저장 검증이 아니다."""
import copy
import json
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

REPO = Path(__file__).resolve().parents[2]
FIX = REPO / "docs/contracts/fixtures"
CASES = {"create": 201, "edit": 200, "conflict": 409, "hidden-404": 404,
         "tombstone": 200, "promote": 201, "secret-reject": 422,
         "quarantine-save": 201, "spool-reference": 200,
         "research-request": 201, "research-status": 200}


@pytest.fixture
def contract():
    return yaml.safe_load((REPO / "docs/contracts/openapi.yaml").read_text())


@pytest.fixture
def packet():
    return json.loads((FIX / "first-party.json").read_text())


def validate(contract, schema, value):
    Draft202012Validator({"$ref": schema, "components": contract["components"]}).validate(value)


def test_contract_version_and_eleven_cases(contract, packet):
    assert contract["info"]["version"] == "0.4.0"
    assert packet["synthetic"] is True
    assert {c["id"]: c["status"] for c in packet["cases"]} == CASES
    for case in packet["cases"]:
        operation = contract["x-first-party-paths"][case["path_template"]][case["method"].lower()]
        response = operation["responses"][str(case["status"])]
        if "$ref" in response:
            response = contract["components"]["responses"][response["$ref"].rsplit("/", 1)[1]]
        media = "application/problem+json" if case["status"] >= 400 else "application/json"
        schema = dict(response["content"][media]["schema"], components=contract["components"])
        Draft202012Validator(schema).validate(case["response"])
        if "request" in case:
            schema = dict(operation["requestBody"]["content"]["application/json"]["schema"],
                          components=contract["components"])
            Draft202012Validator(schema).validate(case["request"])


def test_single_readiness_schema_before_and_after(contract, packet):
    ref = contract["components"]["schemas"]["Meta"]["properties"]["write"]["$ref"]
    for name in ("meta_unready", "meta_ready"):
        validate(contract, ref, packet[name])
    unready = packet["meta_unready"]
    assert unready["editor_routes"] == [] and unready["private_open"] is False
    assert unready["hitl"]["available"] is False
    assert unready["secret_rules"] == {"version": None, "sha": None}
    assert packet["deployment"]["editor_routes"] == []
    assert packet["deployment"]["private_open"] is False
    assert packet["deployment"]["hitl"]["available"] is False
    validate(contract, ref, packet["deployment"])


def test_errors_and_provenance(contract, packet):
    by = {c["id"]: c["response"] for c in packet["cases"]}
    assert (by["conflict"]["code"], by["conflict"]["detail"]) == (
        "version_conflict", "다른 곳에서 먼저 고쳤습니다")
    assert (by["hidden-404"]["code"], by["hidden-404"]["detail"]) == (
        "not_found", "문서를 찾을 수 없습니다")
    assert by["secret-reject"]["code"] == "secret_detected"
    assert by["secret-reject"]["stored"] is False
    assert by["quarantine-save"]["quarantined"] is True
    assert by["quarantine-save"]["sensitivity"] == "secret"
    assert by["spool-reference"]["data"]["state"] in {"pending", "committed", "failed", "purged"}
    properties = contract["components"]["schemas"]["VersionRow"]["properties"]
    assert {"actor", "claimed_author", "generated_by", "payload_sha"} <= properties.keys()
    for name in ("create", "edit", "tombstone", "promote", "quarantine-save"):
        assert by[name]["actor"] == "app:loupe"
        assert by[name]["claimed_author"] == "user:sagae"
        assert by[name]["generated_by"].startswith("app:loupe:")
        assert len(by[name]["payload_sha"]) == 64


def test_existing_label_prefix_fixture():
    requests = yaml.safe_load((FIX / "requests.yaml").read_text())
    cases = [c for c in requests["cases"] if "filter=label:prefix:" in c["path"]]
    assert cases, "label prefix를 기존 읽기 재생 fixture에 추가해야 한다"
    for case in cases:
        assert case.get("method", "GET") == "GET" and case["status"] == 200
        response = json.loads((FIX / "responses" / (case["id"] + ".json")).read_text())
        assert response["body"]["data"]["items"]
        assert [item["id"] for item in response["body"]["data"]["items"]] == ["e:repo:c"]


def test_all_adr_error_codes_and_fixed_text(contract, packet):
    """7.5의 표와 스키마를 대조하고 변형된 오류 문구는 거절한다."""
    import re
    from jsonschema import ValidationError
    section = (REPO / "docs/adr/0005-first-party-write-api.md").read_text().split("### 7.5 오류")[1].split("### 7.6")[0]
    expected, previous = {}, None
    for line in section.splitlines():
        if not re.match(r"\| \d{3} \|", line):
            continue
        cells = [c.strip() for c in line.split("|")[1:-1]]
        detail = previous if cells[3] == "같음" else cells[3]
        previous = detail
        for code in re.findall(r"`([^`]+)`", cells[1]):
            expected[code] = {"status": int(cells[0]), "detail": detail}
    assert expected == contract["x-first-party-errors"]
    assert {p["code"] for p in packet["errors"]} == set(expected)
    schema = "#/components/schemas/FirstPartyProblem"
    for problem in packet["errors"]:
        validate(contract, schema, problem)
        with pytest.raises(ValidationError):
            validate(contract, schema, dict(problem, detail=problem["detail"] + ": submitted-value"))
    hidden = next(p for p in packet["errors"] if p["code"] == "not_found")
    with pytest.raises(ValidationError):
        validate(contract, schema, dict(hidden, current={"version": 1, "status": "dead"}))


def test_request_restrictions_and_dry_run_schema(contract, packet):
    from jsonschema import ValidationError
    create = copy.deepcopy(next(c["request"] for c in packet["cases"] if c["id"] == "create"))
    for forbidden in ("actor", "author", "origin", "generated_by", "on_behalf_of", "source_url", "quote", "retention"):
        request = copy.deepcopy(create)
        request["record"][forbidden] = "untrusted"
        with pytest.raises(ValidationError):
            validate(contract, "#/components/schemas/RecordWriteRequest", request)
    for hint in ("source_path", "path", "file", "filename", "source_file_path", "quarantine"):
        request = copy.deepcopy(create)
        request["record"]["props"][hint] = "untrusted"
        with pytest.raises(ValidationError):
            validate(contract, "#/components/schemas/RecordWriteRequest", request)
    request = dict(create, on_secret="quarantine", change="autosave")
    with pytest.raises(ValidationError):
        validate(contract, "#/components/schemas/RecordWriteRequest", request)
    validate(contract, "#/components/schemas/DryRunResult", packet["dry_run"])
    validate(contract, "#/components/schemas/RecordWriteResult", packet["spooled"])
    with pytest.raises(ValidationError):
        validate(contract, "#/components/schemas/DryRunResult", dict(packet["dry_run"], body="not echoed"))


def test_no_unimplemented_path_is_advertised_as_deployed(contract):
    for path, item in contract["x-first-party-paths"].items():
        for method, operation in item.items():
            assert operation["x-implemented"] is False
            assert method not in contract["paths"].get(path, {})
    assert contract["info"]["version"] == yaml.safe_load((FIX / "requests.yaml").read_text())["meta"]["contract_version"]
