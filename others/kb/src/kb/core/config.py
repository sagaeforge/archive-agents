"""$KB_CONFIG_DIR/config.toml, decisions.toml 읽기."""
from __future__ import annotations

import tomllib
from typing import Any

from kb.core import paths

DEFAULTS: dict[str, Any] = {
    "collect": {"session_tick": False},
    "lexical": {"rare_only": False},
    "export": {"push_allowed": False, "local_commit": False},
    "read": {"allowed_hosts": ["127.0.0.1", "localhost"]},
}


def _load(name: str) -> dict:
    p = paths.config_dir() / name
    try:
        with open(p, "rb") as f:
            return tomllib.load(f)
    except FileNotFoundError:
        return {}


def get(key: str, default: Any = None) -> Any:
    """점 표기 키. 파일 값, 기본값, 인수 default 순."""
    for src in (_load("config.toml"), DEFAULTS):
        cur: Any = src
        for part in key.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                break
        else:
            return cur
    return default


def decisions() -> set[int]:
    """승인된 결정 번호. `approved = [1, 2]` 또는 `[decisions] 1 = true` 형식."""
    d = _load("decisions.toml")
    out: set[int] = set()
    for v in d.get("approved", []) or []:
        out.add(int(v))
    tbl = d.get("decisions", {})
    if isinstance(tbl, dict):
        for k, v in tbl.items():
            if v is True or (isinstance(v, dict) and v.get("approved") is True):
                out.add(int(k))
    return out


def decision_ok(n: int) -> bool:
    return int(n) in decisions()
