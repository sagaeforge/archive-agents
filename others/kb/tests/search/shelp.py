"""검색 시험 도우미. tests/read/rhelp.py의 World와 이벤트 도우미를 경로로 읽어 다시 쓴다."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_p = Path(__file__).resolve().parents[1] / "read" / "rhelp.py"
_spec = importlib.util.spec_from_file_location("kb_tests_rhelp", _p)
rhelp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rhelp)

World, E, T0, DAY = rhelp.World, rhelp.E, rhelp.T0, rhelp.DAY
snap, claim, entity, record = rhelp.snap, rhelp.claim, rhelp.entity, rhelp.record

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "tokens"


def fixture(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def ids(res: dict) -> list[str]:
    return [i["id"] for i in res["data"]["items"]]
