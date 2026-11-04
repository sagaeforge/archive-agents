"""tick 5단계 confirm(WP-19). LLM을 부르지 않는다: 새 문단을 L2 큐에 넣고, 인용구 재확인과 효력일 대체 완결을 돈다.
L2 호출 자체는 `kb agent run`이다(kind=agent 작업). 네트워크 0."""
from __future__ import annotations

import json

from kb.collect.stage import StageResult
from kb.core import cas, ledger, opsdb
from kb.extract import cache, policy, reconfirm, settings, state

CURSOR = "extract:enq:seq"
QUEUE, QUEUE_SENSITIVE = "l2", "l2s"
BATCH = 500


def _enqueue_record(e: dict) -> bool:
    """first_party 레코드 -> 민감 범위 큐. secret과 세션 자료(작성자 agent:*)는 추출하지 않는다(ADR-0003 3장).
    처리 시점에 sensitive.run이 가드로 다시 본다."""
    p = e["payload"]
    if e.get("origin") != "first_party" or p.get("sensitivity") == "secret" or str(e.get("actor") or "").startswith("agent:"):
        return False
    c = opsdb.connect()
    try:
        return opsdb.queue_put(c, QUEUE_SENSITIVE, f"{p['id']}|{e['seq']}")
    finally:
        c.close()


def enqueue_new(limit: int = BATCH) -> dict:
    """새 snapshot.text의 문단 중 아직 추출하지 않은 것을 큐에 넣는다. 도메인은 소스 목록의 첫 값이다."""
    after = int(state.get(CURSOR, 0) or 0)
    ver = f"{settings.get('prompt_version')}|{settings.get('extract_schema')}"
    prev = state.get("extract:enq:ver")
    if prev not in (None, ver) and not cache.is_carried(str(prev)):
        after = 0                       # 프롬프트나 스키마 판본이 바뀌면 큐 소속이 달라진다: 처음부터 다시 훑는다. done_carry의 옛 판본은 소속이 그대로다
    tab = policy.table()                # 소스별 L2 정책(ADR-0004 D1). none은 큐에 넣지 않고 declared는 선언 구간, prose는 산문 문단만 넣는다
    led = ledger.open_ledger()
    try:
        evs = ledger.iter_events(led, after, limit)
        caps = {}
        last, queued, skipped, skipped_policy, undecided = after, 0, 0, 0, 0
        for e in evs:
            last = max(last, e["seq"])
            if e["kind"] == "snapshot.captured" and e.get("payload"):
                caps[e["payload"]["id"]] = e["payload"]
            if e["kind"] == "record.put" and e.get("payload"):
                queued += 1 if _enqueue_record(e) else 0
            if e["kind"] != "snapshot.text" or not e.get("payload"):
                continue
            p = e["payload"]
            sid = p["snapshot"]
            try:
                paras = json.loads(cas.get(p["paras_sha"]).decode("utf-8"))
            except Exception:  # noqa: BLE001
                continue
            cap = caps.get(sid)
            if cap is None:
                r = led.execute("SELECT p.body FROM event e JOIN payload p ON p.sha=e.payload_sha WHERE e.kind='snapshot.captured' "
                                "AND e.subject=? ORDER BY e.seq LIMIT 1", (sid,)).fetchone()
                cap = json.loads(r[0]) if r and r[0] else {}
            doms = [d for d in (cap.get("domain") or []) if d]
            dom = doms[0] if doms else None
            c = opsdb.connect()
            try:
                r = policy.enqueue_snapshot(c, tab, sid, paras, p, cap, dom)
            finally:
                c.close()
            queued += r["queued"]
            skipped += r["skipped_done"]
            skipped_policy += r["skipped_policy"]
            undecided += r["undecided"]
    finally:
        led.close()
    state.put(CURSOR, last)
    state.put("extract:enq:ver", ver)      # 커서 뒤에 쓴다. 사이에서 죽으면 다시 훑을 뿐이고 큐 적재는 멱등이다
    return {"queued": queued, "skipped_done": skipped, "skipped_policy": skipped_policy, "policy_undecided": undecided, "cursor": last}


def run(ctx=None) -> StageResult:
    res = StageResult()
    try:
        res.detail["enqueue"] = enqueue_new()
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"enqueue: {type(e).__name__}: {e}"[:300])
    try:
        res.detail["policy_sweep"] = policy.sweep_if_changed()      # 정책이 바뀐 첫 tick에 기존 행을 맞춘다(skipped_policy 표시와 되돌림)
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"policy_sweep: {type(e).__name__}: {e}"[:300])
    try:
        res.detail["reconfirm"] = reconfirm.run_new_snapshots()
    except Exception as e:  # noqa: BLE001
        res.ok = False
        res.errors.append(f"reconfirm: {type(e).__name__}: {e}"[:300])
    return res


STAGES = [(5, "confirm", run)]
