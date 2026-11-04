"""이벤트 payload 검증. schemas/events/가 원본이다. jsonschema가 없는 환경에서는 건너뛴다(구조 검사는 원장이 한다)."""
from __future__ import annotations

import json
from functools import lru_cache

from kb.core import paths
from kb.write.errors import WriteRejected


def available() -> bool:
    try:
        import jsonschema  # noqa: F401
        import referencing  # noqa: F401
        return True
    except ImportError:
        return False


@lru_cache(maxsize=1)
def _registry(root: str):
    from pathlib import Path
    from referencing import Registry, Resource
    reg = Registry()
    for p in Path(root).rglob("*.schema.json"):
        s = json.loads(p.read_text(encoding="utf-8"))
        reg = reg.with_resource(s["$id"], Resource.from_contents(s))
    return reg


@lru_cache(maxsize=64)
def _validator(root: str, kind: str):
    import jsonschema
    from pathlib import Path
    s = json.loads((Path(root) / f"{kind}.schema.json").read_text(encoding="utf-8"))
    cls = jsonschema.validators.validator_for(s)
    return cls(s, registry=_registry(root), format_checker=cls.FORMAT_CHECKER)


def _why(e) -> str:
    """검사 오류의 이유. jsonschema의 message는 입력 값을 그대로 담으므로 쓰지 않고, 스키마가 정한 값만 쓴다."""
    return f"{e.validator} 위반({str(e.validator_value)[:100]})"


def _safe_path(e) -> list[str]:
    """오류 위치. 배열 번호는 그대로 두고 객체 키는 짧은 식별자 꼴만 남긴다."""
    return [str(x) if isinstance(x, int) or (isinstance(x, str) and len(x) <= 40 and x.replace("_", "").isalnum()) else "<키>"
            for x in e.path]


def validate_event(ev: dict) -> None:
    """envelope 필드와 kind별 payload를 검사한다. 위반이면 WriteRejected(schema_invalid)."""
    if not available():
        return
    root = str(paths.share_dir() / "schemas" / "events")
    for name, obj in (("envelope", {k: ev[k] for k in ("kind", "actor", "origin", "idem_key", "subject", "on_behalf_of",
                                                       "generated_by", "v", "payload") if k in ev}),
                      (ev["kind"], ev["payload"])):
        try:
            errs = sorted(_validator(root, name).iter_errors(obj), key=lambda e: list(e.path))
        except FileNotFoundError:
            continue
        if errs:
            e = errs[0]
            where = "/".join(_safe_path(e)) or "."
            raise WriteRejected("schema_invalid", f"{ev['kind']} {name}:{where}: {_why(e)}")


def validate_props(schema: dict, props: dict, type_name: str) -> None:
    if not available() or not schema:
        return
    import jsonschema
    s = {k: v for k, v in schema.items() if not k.startswith("x-kb-")}
    s.pop("$schema", None)
    errs = sorted(jsonschema.Draft202012Validator(s).iter_errors(props), key=lambda e: list(e.path))
    if errs:
        e = errs[0]
        raise WriteRejected("schema_invalid", f"{type_name}.props/{'/'.join(_safe_path(e))}: {_why(e)}")
