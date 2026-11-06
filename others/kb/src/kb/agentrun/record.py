"""스트림에서 꺼낸 사고를 ops.db incident와 $KB_HOME/ops/incidents.ndjson에 바로 쓴다(메인 세션이 이 파일을 감시한다)."""
from __future__ import annotations

import datetime
import json
import os

from kb.core import opsdb, paths


def ndjson_path():
    return paths.ops_dir() / "incidents.ndjson"


def write_incident(job: str, inc: dict, run_id: int | None = None) -> int:
    at = inc.get("at") or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    iid = opsdb.record_incident(inc["kind"], f"[{job}] {inc['detail']}"[:600], inc.get("path"), run_id)
    p = ndjson_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps({"job": job, "kind": inc["kind"], "detail": inc["detail"], "path": inc.get("path"), "at": at,
                            "incident_id": iid}, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    return iid


def write_rate_limit(event: dict, job: str) -> None:
    """rate_limit_event의 활용률을 지표로 넘긴다."""
    wins = event.get("unifiedWindows") or (event.get("rate_limit_info") or {}).get("unifiedWindows") or {}
    for name, w in wins.items():
        u = w.get("utilization") if isinstance(w, dict) else None
        if isinstance(u, (int, float)):
            opsdb.record_metric(f"claude.utilization.{name}", float(u), {"job": job})
