"""kb.parse.discover.DISCOVERERS 로더. 모듈은 WP-07이 낸다. 없으면 색인과 urls만 받는다."""
from __future__ import annotations

import importlib


def load_discoverers() -> tuple[dict, str | None]:
    """(kind -> 함수, 경고). 모듈이 아직 없으면 ({}, None)."""
    try:
        mod = importlib.import_module("kb.parse.discover")
    except ModuleNotFoundError as e:
        if (e.name or "").startswith("kb.parse"):
            return {}, None
        return {}, f"discover 임포트 실패: {e}"
    except Exception as e:  # noqa: BLE001 옆 패키지가 쓰는 중인 깨진 모듈
        return {}, f"discover 임포트 실패: {type(e).__name__}: {e}"
    return dict(getattr(mod, "DISCOVERERS", {}) or {}), None
