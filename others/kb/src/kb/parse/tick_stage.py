"""tick 4단계 parse. 새 snapshot.captured마다 구조 가드 -> 어댑터 -> 표시 본문 -> 문단 -> 이벤트. LLM 비용 0, 네트워크 0.
커서는 ops.db tick_state의 parse:cursor(원장 seq)다. 실패한 스냅샷은 DLQ(kind=parse)로 가고 커서는 앞으로 간다.
kb tick --only <소스>는 그 소스를 지금 처리하라는 명시 요청이다. 이번 tick에 새 스냅샷이 없으면 그 소스의 최신 스냅샷을
저장된 표시 본문으로 다시 파싱한다. 멱등이라 같은 파서 버전이면 새 이벤트가 없고, 새 파서 버전이면 새 결과를 쌓는다."""
from __future__ import annotations

import json

from kb.collect import clock, registry
from kb.collect.stage import StageResult
from kb.collect.state import State
from kb.core import ledger
from kb.parse import pipeline

CURSOR = "parse:cursor"
BATCH = 200


def snapshot_payload(led, sid: str) -> dict | None:
    r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.captured' AND e.subject=? "
                    "ORDER BY e.seq LIMIT 1", (sid,)).fetchone()
    return json.loads(r[0]) if r and r[0] else None


def latest_snapshot(led, source: str) -> dict | None:
    r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.captured' "
                    "AND json_extract(p.body, '$.source')=? ORDER BY e.seq DESC LIMIT 1", (source,)).fetchone()
    return json.loads(r[0]) if r and r[0] else None


def _source_map() -> dict:
    return {s.id: s for s in registry.load_registry(validate=False)}


def _one(snap: dict, srcs: dict, st: State, res: StageResult, detail: dict, *, reuse_text: bool = False) -> bool:
    try:
        out = pipeline.parse_snapshot(snap, srcs.get(snap.get("source")), state=st, reuse_text=reuse_text)
    except Exception as e:  # noqa: BLE001 파서 예외는 구조 변경이다: DLQ에 두고 원본은 유지한다
        st.dlq_put("parse", snap["id"], "parse", f"{type(e).__name__}: {e}"[:400], snap.get("raw_sha"))
        detail["failed"] = detail.get("failed", 0) + 1
        return False
    k = out["status"]
    detail[k] = detail.get(k, 0) + 1
    return k == "ok"


def run(ctx) -> StageResult:
    res = StageResult()
    detail = {"ok": 0}
    only = getattr(ctx, "only", None)
    only_done = False
    try:
        srcs = _source_map()
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"registry: {type(e).__name__}: {e}"[:300])
        srcs = {}
    led = ledger.open_ledger()
    try:
        with State() as st:
            cur = int(st.kv_get(CURSOR, 0))
            done = 0
            while not ctx.expired():
                evs = ledger.iter_events(led, cur, BATCH)
                if not evs:
                    break
                for ev in evs:
                    if ctx.expired():
                        break
                    if ev["kind"] == "snapshot.captured" and ev.get("payload"):
                        if _one(ev["payload"], srcs, st, res, detail):
                            done += 1
                            only_done = only_done or ev["payload"].get("source") == only
                    cur = ev["seq"]
                    st.kv_set(CURSOR, cur)
                else:
                    continue
                break
            now = clock.now_ms()       # DLQ 재시도: 1시간, 1일, 7일 뒤
            for row in st.dlq_list("parse"):
                if ctx.expired():
                    break
                if row["next_at"] and row["next_at"] <= now:
                    snap = snapshot_payload(led, row["ref"])
                    if snap and _one(snap, srcs, st, res, detail):
                        st.c.execute("DELETE FROM dlq WHERE id=?", (row["id"],))
                        done += 1
            if only and not only_done and not ctx.expired():
                snap = latest_snapshot(led, only)
                if snap and _one(snap, srcs, st, res, detail, reuse_text=True):
                    done += 1
                    detail["reparsed_only"] = snap["id"]
            detail["parsed"] = done
            detail["cursor"] = cur
    finally:
        led.close()
    res.detail.update(detail)
    return res


STAGES = [(4, "parse", run)]
