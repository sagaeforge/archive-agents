"""tick 6.3 live. 만기가 된 생존 재확인 대상을 live 큐에서 꺼내 판정한다(ADR 11장 생존 재확인 R19).
수집은 capture를 지나므로 호스트 정책, robots, 예산이 그대로 걸린다. 결정 8 뒤에만 GraphQL 일괄을 쓴다."""
from __future__ import annotations

from kb.collect.stage import StageResult
from kb.live import gold as G, ghgraphql, probe, runner

LIMIT = 20


def run(ctx=None) -> StageResult:
    res = StageResult()
    con = G.open_gold()
    try:
        if con is None:
            res.detail = {"skipped": "no_gold"}
            return res
        runner.seed(con)
        targets = runner.select_targets(con, LIMIT)
        fx = probe.CaptureFetcher()
        gh = None
        if ghgraphql.enabled():
            names = [t["label"] for t in targets if t["type"] == "repo" and "/" in str(t["label"])]
            src = fx.owner("https://api.github.com/repos/x/y")
            gh = ghgraphql.GhBatch(names, source=src.id if src else None) if names else None
        s = runner.run(targets, fx, con=con, gh=gh)
    finally:
        if con is not None:
            con.close()
    res.detail = {k: s[k] for k in ("targets", "checked", "unreachable", "changed", "written", "queued", "capped", "rejected",
                                    "released", "propagated", "rechecks")}
    res.errors = list(s["errors"])
    return res


STAGES = [(6.3, "live", run)]
