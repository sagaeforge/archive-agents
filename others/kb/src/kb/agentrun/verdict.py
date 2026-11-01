"""성공 판정(ADR 20.3): 네 조건 전부, 그 위에 적재 건수. exit 0이어도 실패를 잡는다."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class Verdict:
    ok: bool
    reasons: list[str] = field(default_factory=list)
    ingested: int | None = None


def judge(events: Iterable[dict], *, ingested: int | None = None, require_ingest: bool = False) -> Verdict:
    evs = list(events)
    why: list[str] = []
    results = [e for e in evs if e.get("type") == "result"]
    if not results:
        why.append("no_result")
    else:
        r = results[-1]
        if r.get("is_error") is not False:
            why.append("is_error" if r.get("is_error") else "is_error_missing")
        st = str(r.get("subtype") or "")
        if st and st != "success":
            why.append(f"subtype:{st}")  # error_max_budget_usd, error_max_turns 등: 예산·대기 상한
        if r.get("permission_denials"):
            why.append("permission_denials")
    for e in evs:
        if e.get("type") == "system" and e.get("subtype") == "task_notification" and e.get("status") not in (None, "completed"):
            why.append(f"task_{e.get('status')}")
        if e.get("type") == "system" and e.get("subtype") == "init":
            bad = [s.get("name") for s in (e.get("mcp_servers") or []) if s.get("status") == "failed"]
            if bad:
                why.append("mcp_failed:" + ",".join(map(str, bad)))
    # 최종 result에도 mcp_servers가 있으면 같이 본다
    if results:
        bad = [s.get("name") for s in (results[-1].get("mcp_servers") or []) if s.get("status") == "failed"]
        if bad:
            why.append("mcp_failed:" + ",".join(map(str, bad)))
    if require_ingest and not ingested:
        why.append("no_ingest")
    return Verdict(ok=not why, reasons=sorted(set(why)), ingested=ingested)
