"""정규 JSON(정렬 키, 부동소수 거부)과 sha256."""
from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any


class CanonError(ValueError):
    pass


def _check(o: Any, path: str = "$") -> None:
    if o is None or isinstance(o, (bool, int, str)):
        return
    if isinstance(o, float):
        raise CanonError(f"부동소수는 정규 JSON에 쓸 수 없음: {path}")
    if isinstance(o, (list, tuple)):
        for i, x in enumerate(o):
            _check(x, f"{path}[{i}]")
        return
    if isinstance(o, dict):
        for k, v in o.items():
            if not isinstance(k, str):
                raise CanonError(f"키는 문자열이어야 함: {path}")
            _check(v, f"{path}.{k}")
        return
    raise CanonError(f"지원하지 않는 타입 {type(o).__name__}: {path}")


def canon_json(obj: Any) -> bytes:
    """키 정렬, 공백 없음, UTF-8 원문(ensure_ascii 끔). 부동소수와 NaN은 거부한다."""
    _check(obj)
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)
