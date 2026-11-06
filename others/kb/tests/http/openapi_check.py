"""openapi.yaml 응답 스키마 검증 도우미."""
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

DOC = yaml.safe_load((Path(__file__).resolve().parents[2] / "docs/contracts/openapi.yaml").read_text(encoding="utf-8"))


def response_schema(path: str, status: str = "200", ctype: str = "application/json"):
    op = DOC["paths"][path]["get"]
    r = op["responses"][status]
    if "$ref" in r:
        r = DOC["components"]["responses"][r["$ref"].rsplit("/", 1)[1]]
    return r["content"][ctype]["schema"]


def validate(path: str, body, status: str = "200", ctype: str = "application/json") -> None:
    sch = dict(response_schema(path, status, ctype))
    sch["components"] = DOC["components"]
    errs = sorted(Draft202012Validator(sch).iter_errors(body), key=lambda e: list(e.path))
    assert not errs, "; ".join(f"{list(e.path)}: {e.message}"[:200] for e in errs[:5])


def declared_params() -> dict:
    """경로 템플릿 -> 쿼리 파라미터 이름 집합(openapi.yaml)."""
    comps = DOC["components"].get("parameters", {})
    out = {}
    for path, item in DOC["paths"].items():
        names = set()
        for prm in item["get"].get("parameters", []) + item.get("parameters", []):
            if "$ref" in prm:
                prm = comps[prm["$ref"].rsplit("/", 1)[1]]
            if prm["in"] == "query":
                names.add(prm["name"])
        out[path] = names
    return out
