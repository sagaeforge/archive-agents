"""함의 판정(ADR-0003 2장). 공개 범위 주장의 R_VALUE_MISMATCH, R_SUBJECT_CONTEXT, R_ALIAS_MISMATCH만 대상이다.
뒷받침되면 claim.review로 quote_found가 되고 support_check를 기록한다. 민감 범위 주장은 판정하지 않고 needs_review로 둔다.
교차 확인(표본 감사)도 같은 judge() 함수를 쓰고 지표만 남긴다. 주장 상태를 바꾸지 않는다."""
from __future__ import annotations

import time

from kb.core import opsdb
from kb.extract import budget, guard, prompt, route, schema, settings, state
from kb.extract.types import Job, Window

QUEUE = "support_check"


def _claim(con, cid: str) -> dict | None:
    r = con.execute("SELECT n.verification, n.sensitivity, c.statement, c.extractor, n.origin FROM node n JOIN claim c ON c.vid=n.vid "
                    "WHERE n.id=? AND n.expired_at IS NULL", (cid,)).fetchone()
    if not r:
        return None
    e = con.execute("SELECT snapshot_id, exact, prefix, suffix FROM evidence WHERE claim_id=? ORDER BY id LIMIT 1", (cid,)).fetchone()
    if not e:
        return None
    return {"id": cid, "verification": r[0], "sensitivity": r[1], "statement": r[2], "extractor": r[3] or "",
            "origin": r[4], "snapshot": e[0], "quote": e[1] or "", "context": f"{e[2] or ''}{e[1] or ''}{e[3] or ''}"}


def judge(c: dict, backends: dict, router, *, purpose: str = "support", extractor: str = "") -> dict:
    """반환 {ok, supported, backend, model, same_vendor, reason, error}. 외부 호출은 가드를 지난다."""
    plan = router.plan("public", purpose, extractor=extractor)
    if not plan.cands:
        return {"ok": False, "reason": plan.stop or "no_route"}
    # job.user에는 주장 문장과 인용구, 앞뒤 문맥이 간다. 문장은 주장 노드의 출처와 민감도로, 문맥은 스냅샷으로 따로 검사한다
    inputs = [guard.inspect_snapshot(c["snapshot"], c["context"] or c["quote"]),
              guard.inspect_snapshot(c["id"], c["statement"])]
    last = "no_route"
    called = False
    for cand in plan.cands:
        be = backends.get(cand.backend)
        if be is None:
            continue
        pf = be.preflight()
        if not pf.ok:
            last = pf.reason
            continue
        if cand.backend == "claude" and not route.claude_gate(pf, be):
            last = "claude_limit"
            continue
        w = Window(f"support:{c['id']}", c["snapshot"], c["quote"], [], [], "", "", "", "")
        job = Job(w, purpose, "public", prompt.SUPPORT_SYSTEM, prompt.support_user(c["statement"], c["quote"], c["context"]),
                  schema.SUPPORT_SCHEMA, cand.model, cand.budget_usd)
        try:
            permit = guard.authorize(inputs, cand.backend, job.user)
        except guard.GuardDenied as e:
            return {"ok": False, "reason": f"guard:{e.reason}"}
        res = None
        resv = None
        if cand.backend == "openrouter":
            try:
                reserve = budget.reservation_for(be, job)
                resv = budget.reserve(reserve, purpose="support")
            except budget.TooLarge:
                last = "too_large"
                continue
            except budget.Refused as e:
                if e.reason == "valve":                        # 밸브 도달 뒤에는 Claude, Codex로 번지지 않는다
                    d = budget.day()
                    route.apply("daily_valve", spent=d["spent"] + d["reserved"], reserve=reserve)
                    return {"ok": False, "reason": "daily_valve"}
                last = e.reason
                continue
        try:
            res = be.extract(job, permit)
        except Exception:
            if resv is not None:
                budget.release(resv)
            raise
        called = True
        rate = res.extra.get("rate")
        if rate and (rate.get("five_hour") is not None or rate.get("seven_day") is not None):
            state.put("claude:rate", dict(rate, at=settings.now_s()))
        if resv is not None:
            if budget.settle(resv, res.cost_usd):             # 호출당 비용 초과: 배치를 멈추고 사고로 남긴다
                route.apply("cost_exceeded", actual=res.cost_usd or 0.0, reserved=resv["usd"])
                budget.count_window(cand.backend, support=True)
                return {"ok": False, "reason": "cost_exceeded", "called": True}
        budget.count_window(cand.backend, support=True)
        if res.error or res.raw is None:
            last = res.error or "empty"
            continue
        try:
            obj = schema.parse_raw(res.raw)
        except ValueError:
            last = "bad_json"
            continue
        if schema.validate(schema.SUPPORT_SCHEMA, obj):
            last = "bad_schema"
            continue
        return {"ok": True, "supported": bool(obj["supported"]), "backend": cand.backend, "model": cand.model,
                "same_vendor": cand.same_vendor, "reason": cand.reason}
    return {"ok": False, "reason": last, "called": called}


STOP_REASONS = ("daily_valve", "cost_exceeded")        # 배치를 멈춘다. 다른 경로로 넘기지 않는다


def _release(ref: str) -> None:
    c = opsdb.connect()
    try:
        c.execute("UPDATE queue SET state='queued', next_at=NULL, attempts=max(attempts-1, 0) WHERE kind=? AND ref=?", (QUEUE, ref))
    finally:
        c.close()


def run_queue(backends: dict, router, limit: int = 20) -> dict:
    """support_check 큐를 처리한다. 뒷받침되면 claim.review(quote_found), 아니면 needs_review 유지."""
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    out = {"checked": 0, "supported": 0, "unsupported": 0, "skipped": 0}
    c = opsdb.connect()
    try:
        items = opsdb.queue_take(c, QUEUE, limit)
    finally:
        c.close()
    if not items:
        return out
    gp = current_gold_path()
    con = connect_ro(gp, 60.0) if gp else None
    from kb.write import commit
    stop = None
    try:
        for it in items:
            if stop:                                           # 멈춘 뒤의 항목은 시도 횟수를 쓰지 않고 돌려놓는다
                _release(it["ref"])
                continue
            cl = _claim(con, it["ref"]) if con is not None else None
            done = True
            if cl is None or cl["verification"] != "needs_review" or cl["sensitivity"] > 0 or cl["origin"] != "external":
                out["skipped"] += 1
            else:
                j = judge(cl, backends, router)
                if not j["ok"] and j["reason"] in STOP_REASONS:
                    stop = out["stopped"] = j["reason"]
                    _release(it["ref"])
                    continue
                if not j["ok"]:
                    out["skipped"] += 1
                    # 호출 없이 막힌 항목은 한도가 풀리면 다시 본다. 실제 호출이 실패한 항목만 시도 횟수를 쓴다
                    done = str(j["reason"]).startswith("guard:") or (bool(j.get("called")) and it["attempts"] >= int(settings.get("max_attempts", 3)))
                else:
                    sup = j["supported"]
                    commit([{"kind": "claim.review", "actor": "l2", "origin": "system", "subject": cl["id"],
                             "idem_key": f"support:{cl['id']}:{j['backend']}:{j['model']}",
                             "payload": {"id": cl["id"], "verification": "quote_found" if sup else "needs_review",
                                         "support_check": "supported" if sup else "unsupported",
                                         "decided_by": f"l2:support:{j['backend']}:{j['model']}"}}], "l2", timeout=60.0)
                    out["checked"] += 1
                    out["supported" if sup else "unsupported"] += 1
            c = opsdb.connect()
            try:
                if done:
                    opsdb.queue_done(c, QUEUE, it["ref"])
                else:
                    opsdb.queue_done(c, QUEUE, it["ref"], requeue_at=int(time.time() * 1000) + 3600_000)
            finally:
                c.close()
    finally:
        if con is not None:
            con.close()
    return out


def cross_check(backends: dict, router, now_s: float | None = None) -> dict:
    """주 80건(언어별 40) 표본 감사. 같은 judge() 경로를 쓰고 지표만 남긴다. 주장 상태를 바꾸지 않고 claim.assert를 내지 않는다."""
    import datetime as dt
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    now = now_s if now_s is not None else settings.now_s()
    iso = dt.datetime.fromtimestamp(now).isocalendar()
    wk = f"llm:cross:{iso[0]}-W{iso[1]:02d}"
    total, per = int(settings.get("cross_check.weekly_total", 80)), int(settings.get("cross_check.per_language", 40))
    got = state.get(wk) or {"n": 0, "ko": 0, "en": 0}
    out = {"sampled": 0, "gap": False}
    gp = current_gold_path()
    if gp is None or got["n"] >= total:
        return out
    con = connect_ro(gp, 60.0)
    try:
        rows = con.execute("SELECT n.id FROM node n JOIN claim c ON c.vid=n.vid WHERE n.type='Claim' AND n.expired_at IS NULL "
                           "AND n.sensitivity=0 AND n.origin='external' AND c.method='llm' AND c.extractor LIKE 'l2:%' ORDER BY n.id").fetchall()
        for (cid,) in rows:
            if got["n"] >= total:
                break
            cl = _claim(con, cid)
            if cl is None:
                continue
            lang = "ko" if any("가" <= ch <= "힣" for ch in cl["statement"]) else "en"
            if got[lang] >= per:
                continue
            ex_model = cl["extractor"].split(":")[2] if cl["extractor"].count(":") >= 3 else ""
            j = judge(cl, backends, router, purpose="cross", extractor=ex_model)
            if not j["ok"]:
                if str(j["reason"]).startswith("guard:"):
                    continue                                   # 가드가 거부한 주장 하나가 표본 감사를 끝내지 않는다
                if j["reason"] == "week_gap":
                    out["gap"] = True
                    state.metric("llm.cross_gap", 1, {"week": wk})
                break
            got["n"] += 1
            got[lang] += 1
            out["sampled"] += 1
            state.metric("llm.cross_check", 1 if j["supported"] else 0,
                         {"extractor": cl["extractor"], "backend": j["backend"], "model": j["model"],
                          "same_vendor": j["same_vendor"], "lang": lang})
    finally:
        con.close()
        state.put(wk, got)
    return out
