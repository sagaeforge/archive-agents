"""내부 작업 등록(sources/internal.d/*.yaml). tick은 LLM을 부르지 않는 작업만 돈다."""
from __future__ import annotations

import importlib

from kb.collect import clock, registry
from kb.collect.state import State


def load_jobs() -> list[dict]:
    d = registry.sources_dir() / "internal.d"
    out: list[dict] = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.yaml")):
        doc = registry.read_yaml(p) or {}
        for j in doc.get("jobs") or []:
            if isinstance(j, dict) and j.get("id") and j.get("run"):
                out.append(dict(j, _file=p.name))
    return out


def run_due(stage_no: float, ctx, st: State) -> tuple[dict, list[str]]:
    """stage_no 단계 뒤에 돌 작업 중 만기인 것을 돈다. (결과, 경고)."""
    res: dict = {}
    warns: list[str] = []
    now = clock.now_ms()
    for j in load_jobs():
        if float(j.get("stage", 3)) != float(stage_no):
            continue
        key = f"job:{j['id']}"
        last = st.kv_get(key)
        if last and now - int(last) < float(j.get("every_s", 86400)) * 1000:
            continue
        try:
            mod, fn = str(j["run"]).split(":", 1)
            out = getattr(importlib.import_module(mod), fn)(ctx)
            res[j["id"]] = out
            st.kv_set(key, now)
        except Exception as e:  # noqa: BLE001 한 작업의 실패가 단계를 막지 않는다
            warns.append(f"internal job {j['id']}: {type(e).__name__}: {e}"[:300])
    return res, warns
