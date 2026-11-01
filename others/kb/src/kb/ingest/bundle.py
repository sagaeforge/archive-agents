"""묶음 읽기: JSON Lines -> (머리, 항목 목록). 계약 오류(머리, contract 값, JSON 파싱 실패, 5,000항목 초과)는
ContractError이고 아무것도 쓰지 않는다(exit 2)."""
from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path

from kb.core import paths

CONTRACT = "kb-ingest/1"
MAX_BUNDLE_ITEMS = 5000
MAX_CALL_ITEMS = 100          # MCP 호출당 상한. 호출 경계(WP-12)가 check_call_limit으로 적용한다
ITEM_KINDS = ("snapshot", "entity", "claim", "edge", "liveness", "series", "record")


class ContractError(Exception):
    pass


@lru_cache(maxsize=16)
def _validator(root: str, name: str):
    import jsonschema
    s = json.loads((Path(root) / f"{name}.schema.json").read_text(encoding="utf-8"))
    cls = jsonschema.validators.validator_for(s)
    return cls(s, format_checker=cls.FORMAT_CHECKER)


def schema_error(item: dict, name: str) -> str | None:
    """schemas/ingest/<name>.schema.json 위반이면 사람이 읽는 한 줄, 아니면 None."""
    root = str(paths.share_dir() / "schemas" / "ingest")
    errs = sorted(_validator(root, name).iter_errors(item), key=lambda e: [str(x) for x in e.path])
    if not errs:
        return None
    e = errs[0]
    where = "/".join(str(x) for x in e.path) or "."
    return f"{name}:{where}: {e.message[:160]}"


def check_header(h) -> dict:
    if not isinstance(h, dict) or h.get("item") != "bundle":
        raise ContractError("첫 줄은 item=bundle 머리여야 한다")
    if h.get("contract") != CONTRACT:
        raise ContractError(f"contract는 {CONTRACT}여야 한다: {h.get('contract')!r}")
    err = schema_error(h, "bundle")
    if err:
        raise ContractError(f"머리 줄 위반 {err}")
    return h


def parse_lines(lines) -> tuple[dict, list]:
    """lines: 문자열 iterable. 결과 (머리, [(줄 번호, 객체 또는 None, 오류 문자열 또는 None)])."""
    header, items = None, []
    for n, raw in enumerate(lines, 1):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError as e:
            raise ContractError(f"{n}행 JSON 파싱 실패: {str(e)[:80]}") from None
        if header is None:
            header = check_header(obj)
            continue
        if not isinstance(obj, dict):
            raise ContractError(f"{n}행은 객체여야 한다")
        items.append((n, obj))
        if len(items) > MAX_BUNDLE_ITEMS:
            raise ContractError(f"묶음 항목이 {MAX_BUNDLE_ITEMS}개를 넘는다")
    if header is None:
        raise ContractError("머리 줄이 없다")
    return header, items


def read_path(path: str) -> tuple[dict, list]:
    if path == "-":
        return parse_lines(sys.stdin)
    try:
        with open(path, encoding="utf-8") as f:
            return parse_lines(f)
    except OSError as e:
        raise ContractError(f"묶음을 읽지 못함: {e}") from None


def from_objects(objs: list) -> tuple[dict, list]:
    """MCP처럼 객체 배열로 받은 묶음. 줄 번호는 1부터 센다."""
    return parse_lines(json.dumps(o, ensure_ascii=False) for o in objs)


def check_call_limit(objs: list) -> None:
    n = sum(1 for o in objs if not (isinstance(o, dict) and o.get("item") == "bundle"))
    if n > MAX_CALL_ITEMS:
        raise ContractError(f"호출당 항목은 {MAX_CALL_ITEMS}개 이하여야 한다(머리 줄 제외): {n}")
