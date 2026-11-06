"""sources/internal.d/extract.yaml의 settings. 모든 [설정값]은 거기서 바꾼다. 시험은 override()로 덮는다."""
from __future__ import annotations

import copy
import os
import time
from contextlib import contextmanager

from kb.core import paths

_OVERRIDE: dict = {}
KST_OFFSET_S = 9 * 3600


def _merge(a: dict, b: dict) -> dict:
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            _merge(a[k], v)
        else:
            a[k] = copy.deepcopy(v)
    return a


def load() -> dict:
    from kb.collect import registry
    p = paths.share_dir() / "sources" / "internal.d" / "extract.yaml"
    doc = {}
    if p.is_file():
        doc = (registry.read_yaml(p) or {}).get("settings") or {}
    return _merge(copy.deepcopy(doc), _OVERRIDE)


def get(path: str, default=None):
    cur = load()
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


@contextmanager
def override(**kw):
    """시험용. 점 표기 키를 쓴다: override(**{"claude.daily_windows": 2})."""
    global _OVERRIDE
    old = copy.deepcopy(_OVERRIDE)
    for k, v in kw.items():
        cur = _OVERRIDE
        parts = k.split(".")
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = v
    try:
        yield
    finally:
        _OVERRIDE = old


def now_s() -> float:
    return float(os.environ.get("KB_EXTRACT_NOW") or time.time())


def kst_day(at_s: float | None = None) -> str:
    t = (now_s() if at_s is None else at_s) + KST_OFFSET_S
    return time.strftime("%Y-%m-%d", time.gmtime(t))


def next_kst_midnight_s(at_s: float | None = None) -> float:
    t = (now_s() if at_s is None else at_s) + KST_OFFSET_S
    return (int(t // 86400) + 1) * 86400 - KST_OFFSET_S
