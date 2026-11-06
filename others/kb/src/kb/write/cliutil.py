"""WP-03 명령 공통: JSON 출력, 오류 변환."""
from __future__ import annotations

import json
import sys

from kb.write.errors import IdemConflict, VersionConflict, WriteRejected


def emit(obj, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
    elif isinstance(obj, dict):
        for k, v in obj.items():
            print(f"{k}: {v}")
    else:
        print(obj)


def fail(code: str, message: str, as_json: bool) -> int:
    if as_json:
        print(json.dumps({"error": code, "message": message}, ensure_ascii=False, sort_keys=True))
    else:
        print(f"오류 {code}: {message}", file=sys.stderr)
    return 1


def guarded(fn, as_json: bool) -> int:
    try:
        return fn()
    except WriteRejected as e:
        return fail(e.code, e.message, as_json)
    except VersionConflict as e:
        return fail("version_conflict", str(e), as_json)
    except IdemConflict as e:
        return fail("idempotency_conflict", str(e), as_json)

