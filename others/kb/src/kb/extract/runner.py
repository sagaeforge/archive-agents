"""kb agent run의 본체. 큐(문단) -> 창 -> 가드 -> 라우팅 -> 백엔드 -> 원응답 CAS -> extract.run -> kb.ingest(게이트) 순서다.
L2가 멈춰도 L0, L1, 조회는 돈다. 경로 전환은 재추출이 아니다: 큐 소속은 (para_sha, prompt_version, extract_schema)다."""
from __future__ import annotations

import json

from kb.core import canon, cas, gatelock, opsdb
from kb.extract import budget, cache, guard, items as itm, order, prompt, route, schema, settings, state, support, windows
from kb.extract.types import Job

QUEUE = "l2"
DOMAINS = tuple("ABCDEFG")
GUARD_TRANSIENT = {"read_failed", "unknown_value", "scan_failed", "empty"}      # 일시 오류. 재시도 뒤 DLQ로 간다
REEXTRACT = "ex:reextract:"                                                     # 재추출이 끝나지 않은 스냅샷 표식


def default_backends() -> dict:
    from kb.extract.backends.claude import Claude
    from kb.extract.backends.codex import Codex
    from kb.extract.backends.openrouter import OpenRouter
    from kb.extract.backends.sllm import Sllm
    return {"claude": Claude(), "openrouter": OpenRouter(), "codex": Codex(), "sllm": Sllm()}


def _dec(x, nd: int):
    """정규 JSON은 부동소수를 쓸 수 없다. 십진 문자열로 남긴다(null이면 null)."""
    return None if x is None else f"{float(x):.{nd}f}"


def _now_ms() -> int:
    return int(settings.now_s() * 1000)


def _qdone(ref: str, requeue_at: int | None = None, kind: str = QUEUE) -> None:
    c = opsdb.connect()
    try:
        opsdb.queue_done(c, kind, ref, requeue_at=requeue_at)
    finally:
        c.close()


def _dlq(it: dict, err: str, kind: str = QUEUE) -> None:
    c = opsdb.connect()
    try:
        c.execute("INSERT INTO dlq(kind, ref, stage, error, attempts, next_at, payload_sha) VALUES(?,?,?,?,?,NULL,NULL)",
                  (kind, it["ref"], "extract", err[:300], it.get("attempts", 0)))
    finally:
        c.close()


def _seen_spans(proc, w) -> list:
    """모델이 본 원문 구간. 창 문단과 본문이 같은 문단(para_sha 동일)은 창 구성이 한 번만 보냈어도 같은 문장이므로 함께 넣는다.
    그래야 반복 문단의 인용구가 첫 사본으로 조용히 정해지지 않고 E_QUOTE_AMBIGUOUS로 남는다."""
    shas = set(w.para_shas)
    info = proc.text_of(proc.snapshot_info(w.snapshot))
    out = {(a, b) for a, b in w.spans}
    out.update((x.start_cp, x.end_cp) for x in info.paras if x.para_sha in shas)
    return sorted(out)


def retry_or_dlq(it: dict, err: str, kind: str = QUEUE) -> None:
    """실패한 항목: 재시도 2회 뒤 DLQ, 그 전에는 10분 뒤로 미룬다."""
    if it.get("attempts", 1) >= int(settings.get("max_attempts", 3)):
        _dlq(it, err, kind)
        _qdone(it["ref"], kind=kind)
    else:
        _qdone(it["ref"], requeue_at=_now_ms() + 600_000, kind=kind)


def unattempted(ref: str, kind: str = QUEUE) -> None:
    """호출이 없었던 항목을 큐에 그대로 돌린다. 시도 횟수를 쓰지 않으므로 막힌 동안 DLQ로 가지 않는다."""
    c = opsdb.connect()
    try:
        c.execute("UPDATE queue SET state='queued', next_at=NULL, attempts=max(attempts-1, 0) WHERE kind=? AND ref=?", (kind, ref))
    finally:
        c.close()


def readmit_dlq(kind: str = QUEUE) -> int:
    """kb dlq retry가 next_at을 당긴 항목을 큐로 되돌린다."""
    c = opsdb.connect()
    try:
        rows = c.execute("SELECT id, ref FROM dlq WHERE kind=? AND next_at IS NOT NULL", (kind,)).fetchall()
        for i, ref in rows:
            opsdb.queue_put(c, kind, ref)
            c.execute("DELETE FROM dlq WHERE id=?", (i,))
    finally:
        c.close()
    return len(rows)


def queue_left(kind: str = QUEUE) -> int:
    c = opsdb.connect()
    try:
        return c.execute("SELECT count(*) FROM queue WHERE kind=?", (kind,)).fetchone()[0]
    finally:
        c.close()


def _domains_of(proc, sid: str) -> list:
    try:
        return [d for d in proc.gold.domains(sid) if d in DOMAINS][:1]
    except Exception:  # noqa: BLE001
        return []


class Run:
    def __init__(self, scope: str, backends: dict, max_windows: int | None, reextract: bool):
        self.scope, self.backends, self.max_windows, self.reextract = scope, backends, max_windows, reextract
        self.router = route.Router(backends)
        self.out = {"windows": 0, "claims": 0, "rejected": 0, "queue_left": 0, "is_error": False, "scope": scope,
                    "by_backend": {}, "needs_review": 0, "cache_hits": 0, "guarded": 0, "failed": 0, "reason": None,
                    "support": {}, "spent_usd": 0.0}
        self.pf: dict = {}
        self.claude_calls = 0
        self.last_called = False
        self.oversize = False
        self.stop = False

    # ------------------------------------------------------------------ 사전 점검
    def _pf(self, cand):
        k = cand.backend
        if k not in self.pf:
            be = self.backends.get(k)
            self.pf[k] = be.preflight() if be is not None else None
            p = self.pf[k]
            if p is not None and not p.ok:
                state.metric("llm.preflight_fail", 1, {"backend": k, "reason": p.reason})
            if p is not None and p.warn:
                state.metric("llm.preflight_warn", 1, {"backend": k, "warn": p.warn})
        return self.pf[k]

    # ------------------------------------------------------------------ 한 창
    def window(self, proc, w) -> str:
        """반환: ok | guarded | blocked | failed | stop."""
        inputs = self._inspect(proc, w)
        scope, why = guard.classify_inputs(inputs)
        if scope != guard.PUBLIC and self.scope == "public":
            state.metric("llm.guard_denied", 1, {"scope": scope, "why": why})
            self.out["guarded"] += 1
            for it in w.items:
                if why in GUARD_TRANSIENT:
                    retry_or_dlq(it, f"guard:{why}")          # 호출 0 방향의 일시 오류. 조용히 잃지 않는다
                else:
                    _qdone(it["ref"])
            return "guarded"
        plan = self.router.plan(self.scope, "extract")
        if not plan.cands:
            self.out["reason"] = plan.stop
            if plan.stop in ("halted", "cost_exceeded", "all_paths_down", "claude_overage"):
                self.out["is_error"] = plan.stop in ("halted",)
            self._requeue(w)
            return "blocked"
        last_err = None
        called = False
        self.oversize = False
        for cand in plan.cands:
            be = self.backends.get(cand.backend)
            pf = self._pf(cand)
            if be is None or pf is None or not pf.ok:
                continue
            if cand.backend == "claude" and not route.claude_gate(pf, be, start=self.claude_calls == 0):
                continue
            r = self._call(proc, w, cand, be, inputs)
            if r == "ok":
                return "ok"
            if r == "stop":
                self._requeue(w)
                return "stop"
            if r == "guard":                                  # 전송 직전 재검사가 거부했다. 호출 0이고 호출 쪽 사유가 남아 있다
                why = str(self.out["reason"] or "").removeprefix("guard:")
                for it in w.items:
                    if why in GUARD_TRANSIENT:
                        retry_or_dlq(it, f"guard:{why}")
                    else:
                        _qdone(it["ref"])
                return "guarded"
            if r == "switched":                               # 호출 없이 넘어갔거나 그 모델이 꺼졌다
                called = called or bool(self.last_called)
                continue
            last_err = r
            break
        if last_err is None and not called and self.oversize:  # 요청이 너무 커서 어느 경로로도 못 보낸다. 큐에 두면 영원히 돈다
            last_err = "too_large"
        if last_err is None and not called:                   # 전 경로가 막혔다. 호출 0이고 큐에 그대로 남는다
            self.out["reason"] = self.out["reason"] or "all_blocked"
            self._requeue(w)
            return "blocked"
        self.out["failed"] += 1
        self.out["reason"] = self.out["reason"] or last_err or "all_blocked"
        for it in w.items:
            retry_or_dlq(it, str(last_err or "switched"))
        return "failed"

    @staticmethod
    def _inspect(proc, w) -> list:
        return [guard.inspect_snapshot(w.snapshot, ptxt, proc.gold.conn()) for _, ptxt in w.paras]

    def _requeue(self, w) -> None:
        for it in w.items:
            unattempted(it["ref"])

    def _call(self, proc, w, cand, be, inputs):
        pv = str(settings.get("prompt_version"))
        extractor = itm.extractor_id(cand.backend, cand.model, pv)
        sch = schema.extract_schema([c["id"] for c in w.candidates])
        job = Job(w, "extract", self.scope, prompt.system_text(), prompt.user_message(w), sch, cand.model, cand.budget_usd)
        resv = None
        self.last_called = False
        cached = cache.raw_entry(w.sha, extractor, cand.model)
        res = None
        if cached:
            from kb.extract.types import Result
            res = Result(w.window_id, cand.backend, cand.model, raw=cas.get(cached["output_sha"]).decode("utf-8"), finish_reason="stop",
                         elapsed_s=0.0, cost_usd=0.0)
            res.extra.update(replayed=True, run_sha=cached.get("run_sha"))
        else:
            if cand.backend == "openrouter":
                try:
                    reserve = budget.reservation_for(be, job)      # 요청의 토큰 상한과 모델 가격에서 구한다
                except budget.TooLarge:
                    self.oversize = True
                    return "switched"
                d = budget.day()
                v = route.apply("daily_valve", spent=d["spent"] + d["reserved"], reserve=reserve)
                if v.action == "off":
                    self.out["reason"] = "daily_valve"
                    self.stop = True
                    return "stop"
                if budget.windows_today("openrouter") >= budget.daily_window_cap():
                    self.out["reason"] = "daily_windows"
                    return "switched"
                try:
                    resv = budget.reserve(reserve)
                except budget.Refused as e:
                    if e.reason == "valve":                  # 밸브 도달 뒤에는 다른 경로로 넘기지 않는다
                        d = budget.day()
                        route.apply("daily_valve", spent=d["spent"] + d["reserved"], reserve=reserve)
                        self.out["reason"] = "daily_valve"
                        self.stop = True
                        return "stop"
                    route.apply("balance_exhausted", balance=budget.balance()) if e.reason == "balance" else None
                    return "switched"
            try:
                # 사전 점검과 예약은 느릴 수 있다. 그 사이에 제한이 걸렸을 수 있으므로 전송 직전에 다시 검사한다
                permit = guard.authorize(self._inspect(proc, w), cand.backend, job.user)
            except guard.GuardDenied as e:
                if resv:
                    budget.release(resv)
                self.out["guarded"] += 1
                self.out["reason"] = f"guard:{e.reason}"
                return "stop" if e.reason == "halted" else "guard"
            try:
                res = be.extract(job, permit)
            except guard.PermitError:
                if resv:
                    budget.release(resv)
                self.out["is_error"], self.out["reason"] = True, "external_send"
                return "stop"
            except Exception:
                if resv:
                    budget.release(resv)                  # 예약이 그날 끝까지 남지 않게 한다
                raise
            self.last_called = True
            if cand.backend == "claude":
                self.claude_calls += 1
        if resv is not None:
            over = budget.settle(resv, res.cost_usd)         # 비용을 모르면(None) 예약액을 청구한다. 실패도 유료일 수 있다
            if res.error and "HTTP 402" in res.error:
                route.apply("balance_exhausted", http=402)
            if res.error and "HTTP 401" in res.error:
                route.apply("key_invalid", http=401)
            if over:
                route.apply("cost_exceeded", actual=res.cost_usd or 0.0, reserved=resv["usd"])
                self.out["reason"] = "cost_exceeded"
                return "stop"
        rate = res.extra.get("rate")
        if rate:
            if rate.get("five_hour") is not None or rate.get("seven_day") is not None:
                state.put("claude:rate", dict(rate, at=settings.now_s()))
            route.apply("claude_overage", isUsingOverage=rate.get("isUsingOverage"))
            route.apply("claude_five_hour", five_hour=rate.get("five_hour"), seven_day=rate.get("seven_day"), start=False)
            route.apply("claude_seven_day", seven_day=rate.get("seven_day"))
        replayed = bool(res.extra.get("replayed"))
        if not replayed:
            budget.count_window(cand.backend)
        key = route.model_key(cand.backend, cand.model)
        err = res.error
        obj = None
        if not err:
            if res.finish_reason == "length":
                err = "truncated"
            else:
                try:
                    obj = schema.parse_raw(res.raw)
                    bad = schema.validate(sch, obj)
                    if bad:
                        err = "schema: " + bad[0]
                except ValueError:
                    err = "bad_json"
        if cand.backend == "codex" and res.extra.get("tool_items"):
            err = err or "tool_items"
        if replayed and not err:                           # 저장된 응답 재사용은 호출이 아니다
            self._store(proc, w, cand, res, obj, extractor)
            return "ok"
        state.metric("llm.call", res.cost_usd or 0.0, {"backend": cand.backend, "model": cand.model, "error": bool(err),
                                                      "elapsed_s": res.elapsed_s, "reason": cand.reason,
                                                      "finish": res.finish_reason, "balance": budget.balance(),
                                                      "five_hour": (res.extra.get("rate") or {}).get("five_hour"),
                                                      "seven_day": (res.extra.get("rate") or {}).get("seven_day")})
        v = route.apply("error_rate", key=key, error=bool(err))
        if err:
            if v.action == "off":
                return "switched"
            return err
        self._store(proc, w, cand, res, obj, extractor)
        return "ok"

    # ------------------------------------------------------------------ 저장
    def _store(self, proc, w, cand, res, obj, extractor) -> None:
        from kb import ingest
        from kb.write import commit
        raw_b = res.raw.encode("utf-8")
        osha = cas.put(raw_b)
        pv = str(settings.get("prompt_version"))
        profile = (settings.get("openrouter.schema_profiles") or {}).get(cand.model, "full") if cand.backend == "openrouter" else "full"
        replayed = bool(res.extra.get("replayed"))
        run_sha = res.extra.get("run_sha")
        if replayed:
            payload = json.loads(cas.get(run_sha).decode("utf-8")) if run_sha else None
        else:
            payload = {"window_sha": w.sha, "para_shas": w.para_shas, "prompt_version": pv, "model": cand.model, "output_sha": osha,
                       "usage": res.usage or {}, "extractor": extractor, "backend": cand.backend, "provider": res.provider,
                       "served_model": res.served_model, "schema_profile": profile, "purpose": "extract", "scope": self.scope,
                       "route_reason": cand.reason, "finish_reason": res.finish_reason, "elapsed_s": _dec(res.elapsed_s, 3),
                       "cost_usd": _dec(0.0 if cand.backend == "sllm" else (None if cand.backend == "codex" else res.cost_usd), 6)}
            payload = {k: v for k, v in payload.items() if v is not None or k in ("cost_usd",)}
            run_sha = cas.put(canon.canon_json(payload))
            # 커밋 전에 페이로드까지 남긴다. 사이에서 죽어도 재실행이 같은 extract.run을 쓰므로 호출 기록이 빠지지 않는다
            cache.raw_put(w.sha, extractor, cand.model, osha, run_sha)
        if payload is not None:
            commit([{"kind": "extract.run", "actor": "l2", "origin": "system", "subject": w.snapshot,
                     "idem_key": f"extract.run:{w.sha}:{extractor}", "payload": payload}], "l2", timeout=60.0)
        doms = _domains_of(proc, w.snapshot)
        claims = obj["claims"]
        its = itm.to_items(w, claims, extractor, doms)
        acc = nr = rej = 0
        ids_new, existing = set(), []
        if its:
            rep = ingest.submit(itm.bundle(w.sha, its, doms), fetch=False, windows={w.snapshot: _seen_spans(proc, w)})
            for ln in rep.lines:
                if ln["result"] == "accepted":
                    acc += 1
                elif ln["result"] == "needs_review":
                    nr += 1
                elif ln["result"] == "rejected":
                    rej += 1
                wb = ln.get("would_be") or {}
                cid = wb.get("id")
                if cid and ln["result"] in ("accepted", "needs_review"):
                    ids_new.add(cid)
                    if wb.get("existing"):
                        existing.append((cid, wb.get("verification")))
        self._revive(w, existing, extractor)
        route.apply("low_yield", key=route.model_key(cand.backend, cand.model), empty=not claims)   # 모든 창. 빈 응답만 내는 모델을 끈다
        if claims:         # 주장이 없는 창(표지, 목차, 차트 표)은 게이트를 지나지 않았으므로 통과율 이력에 넣지 않는다. total=max(1, 0)은 실패 [0,1]로 남았다
            route.apply("gate_pass_drop", key=route.model_key(cand.backend, cand.model), passed=acc, total=len(claims))
        if self.reextract or state.get(REEXTRACT + w.snapshot):
            self._retract_old(w, extractor, ids_new)
        cache.mark_done(w.para_shas, w.sha)
        for it in w.items:
            _qdone(it["ref"])
        o = self.out
        o["windows"] += 1
        o["claims"] += acc + nr
        o["needs_review"] += nr
        o["rejected"] += rej + max(0, len(claims) - len(its))
        o["by_backend"][cand.backend] = o["by_backend"].get(cand.backend, 0) + 1
        o["spent_usd"] = round(o["spent_usd"] + (res.cost_usd or 0.0 if cand.backend == "openrouter" else 0.0), 6)

    def _revive(self, w, existing: list, extractor: str) -> None:
        """적재 단계는 같은 ID의 주장을 '이미 있음'으로 보고 건너뛴다. 철회된 주장이면 수락 응답만 남고 쓰기가 사라지므로
        (kb claim retract 뒤 재추출) 이 추출을 근거로 claim.assert를 다시 내어 되살린다."""
        from kb.core.conn import connect_ro
        from kb.project import current_gold_path
        from kb.write import commit
        gp = current_gold_path() if existing else None
        if gp is None:
            return
        con = connect_ro(gp, 60.0)
        evs = []
        try:
            for cid, ver in existing:
                n = con.execute("SELECT n.status, n.version, n.valid_from, n.valid_precision, c.subject, c.predicate, c.object, c.value, "
                                "c.unit, c.qualifiers, c.statement, c.kind, c.stance, c.speaker FROM node n JOIN claim c ON c.vid=n.vid "
                                "WHERE n.id=? AND n.expired_at IS NULL", (cid,)).fetchone()
                if n is None or n[0] == "active":
                    continue
                sel_keys = ("snapshot", "selector_kind", "exact", "start_cp", "end_cp", "prefix", "suffix", "text_sha", "gate_version")
                sel = [{k: v for k, v in zip(sel_keys, r) if v is not None} for r in con.execute(   # 위치 없는 행은 키를 뺀다(스키마)
                            "SELECT e.snapshot_id, e.selector_kind, e.exact, e.start_cp, e.end_cp, e.prefix, e.suffix, "
                            "COALESCE(e.text_sha, (SELECT json_extract(CAST(sn.props AS TEXT),'$.text_sha') FROM node sn "
                            "WHERE sn.id=e.snapshot_id AND sn.expired_at IS NULL)), e.gate_version "
                            "FROM evidence e WHERE e.claim_id=? ORDER BY e.id", (cid,))]
                p = {"id": cid, "subject": n[4], "statement": n[10], "kind": n[11], "stance": n[12], "method": "llm",
                     "verification": ver or "needs_review", "extractor": extractor, "evidence": sel}
                for k, v in (("predicate", n[5]), ("object", n[6]), ("value", n[7]), ("unit", n[8]), ("speaker", n[13])):
                    if v is not None:
                        p[k] = v
                if n[9]:
                    p["qualifiers"] = json.loads(n[9])
                if n[2] is not None:
                    p["valid"] = {"from": str(n[2])}
                    if n[3]:
                        p["valid"]["precision"] = n[3]
                evs.append({"kind": "claim.assert", "actor": itm.PRODUCER, "origin": "system", "subject": n[4],
                            "idem_key": f"l2:revive:{cid}:{n[1]}:{extractor}", "payload": p})
        finally:
            con.close()
        if evs:
            commit(evs, "l2", timeout=60.0)
            self.out["revived"] = self.out.get("revived", 0) + len(evs)

    def _retract_old(self, w, new_extractor: str, keep: set) -> None:
        """재추출: 이 창 문단에서 옛 extractor가 낸 주장 중 재추출에 없는 것을 claim.retract한다. 같은 ID는 유지."""
        from kb.core.conn import connect_ro
        from kb.project import current_gold_path
        from kb.write import commit
        gp = current_gold_path()
        if gp is None:
            return
        con = connect_ro(gp, 60.0)
        try:
            rows = con.execute("SELECT n.id, c.extractor, e.start_cp, e.exact FROM node n JOIN claim c ON c.vid=n.vid JOIN evidence e "
                               "ON e.claim_id=n.id WHERE n.type='Claim' AND n.expired_at IS NULL AND n.status='active' "
                               "AND c.extractor LIKE 'l2:%' AND c.extractor<>? AND e.snapshot_id=?",
                               (new_extractor, w.snapshot)).fetchall()
        finally:
            con.close()
        evs = []
        for cid, ex, st, exact in rows:
            # 소속은 시작 위치로 정한다. 위치가 없는 행(여러 곳에 있는 인용구, v1 확인)만 인용구가 창 본문에 있는지로 본다
            inside = any(a <= st < b for a, b in w.spans) if st is not None else bool(exact and exact in w.text)
            if cid in keep or not inside:
                continue
            evs.append({"kind": "claim.retract", "actor": "l2", "origin": "system", "subject": cid,
                        "idem_key": f"retract:{cid}:{new_extractor}",
                        "payload": {"id": cid, "extractor": ex, "reason": f"재추출({new_extractor})에 없음"}})
        if evs:
            commit(evs, "l2", timeout=60.0)
            self.out["retracted"] = self.out.get("retracted", 0) + len(evs)


def reextract_enqueue(proc, snapshot: str | None = None) -> int:
    """done 표시를 지우고 문단을 큐에 다시 넣는다. kb agent run --reextract만 쓴다."""
    from kb.core import cas as _cas
    con = proc.gold.conn()
    if con is None:
        return 0
    rows = con.execute("SELECT id, props FROM node WHERE type='Snapshot' AND expired_at IS NULL" +
                       (" AND id=?" if snapshot else ""), (snapshot,) if snapshot else ()).fetchall()
    n = 0
    for sid, props in rows:
        p = json.loads(props) if props else {}
        if not p.get("paras_sha"):
            continue
        paras = json.loads(_cas.get(p["paras_sha"]).decode("utf-8"))
        shas = [x["para_sha"] for x in paras]
        cache.clear_done(shas)
        state.put(REEXTRACT + sid, {"at": settings.now_s()})   # 상한을 넘겨 다음 회차로 밀려도 철회 규칙을 잇는다
        dom = (_domains_of(proc, sid) or [None])[0]
        c = opsdb.connect()
        try:
            for x in paras:
                if opsdb.queue_put(c, QUEUE, windows.ref_of(sid, x["para_sha"], x["start_cp"]), domain=dom):
                    n += 1
        finally:
            c.close()
    return n


def _finish_reextract() -> None:
    """남은 문단이 없는 스냅샷의 재추출 표식을 지운다."""
    keys = state.keys(REEXTRACT)
    if not keys:
        return
    c = opsdb.connect()
    try:
        for k in keys:
            sid = k[len(REEXTRACT):]
            if not c.execute("SELECT 1 FROM queue WHERE kind=? AND substr(ref, 1, ?)=? LIMIT 1", (QUEUE, len(sid) + 1, sid + "|")).fetchone():
                c.execute("DELETE FROM tick_state WHERE k=?", (k,))
    finally:
        c.close()


def _lock_gate(scope: str):
    return gatelock.Gate(opsdb.ops_path().parent / f"l2-{scope}.lock")


def _lock(scope: str):
    """같은 범위의 kb agent run은 한 번에 하나다. 지출 장부(tick_state)의 읽기-수정-쓰기를 지킨다. 못 잡으면 None."""
    try:
        return _lock_gate(scope).acquire(0.2)
    except TimeoutError:
        return None


def run_agent(scope: str = "public", max_windows: int | None = None, reextract: bool = False, snapshot: str | None = None,
              backends: dict | None = None, do_support: bool = True, do_cross: bool = False) -> dict:
    backends = backends if backends is not None else default_backends()
    run = Run(scope, backends, max_windows, reextract)
    out = run.out
    if guard.halted():
        out.update(is_error=True, reason="halted", queue_left=queue_left())
        return out
    stop = route.stopped()
    if stop:
        out.update(reason=stop, queue_left=queue_left())
        return out
    opsdb.connect().close()                                  # ops 폴더와 표를 보장한다
    fd = _lock(scope)
    if fd is None:
        out.update(reason="busy", queue_left=queue_left())
        return out
    try:
        return _run_locked(run, scope, max_windows, reextract, snapshot, backends, do_support, do_cross)
    finally:
        _lock_gate(scope).release(fd)


def _run_locked(run, scope, max_windows, reextract, snapshot, backends, do_support, do_cross) -> dict:
    out = run.out
    if scope == "sensitive":
        from kb.extract import sensitive
        readmit_dlq(sensitive.QUEUE)
        return sensitive.run(run)
    readmit_dlq()
    from kb.ingest.process import Processor
    from kb.extract import items as _i
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "l2-run", "producer": _i.PRODUCER},
                     fetch=False, write=True)
    try:
        if reextract:
            out["requeued"] = reextract_enqueue(proc, snapshot)
        cap = max_windows if max_windows is not None else budget.daily_window_cap()
        guard_rounds = 0
        meta_cache: dict = {}
        while out["windows"] < cap and not run.stop:
            c = opsdb.connect()
            try:
                taken = order.take(proc, c, QUEUE, min(int(settings.get("take_batch", 24)), 200), meta_cache)
            finally:
                c.close()
            if not taken:
                break
            wins, leftover, cached = windows.build(proc, taken)
            for it in cached:
                out["cache_hits"] += 1
                _qdone(it["ref"])
            for it in leftover:
                _qdone(it["ref"])
            for w in wins:
                if out["windows"] >= cap or run.stop:
                    run._requeue(w)
                    continue
                for it, att in zip(w.items, [t.get("attempts", 1) for t in w.items]):
                    it["attempts"] = att
                r = run.window(proc, w)
                if r in ("blocked", "stop"):
                    run.stop = True
            if guard_rounds > 1000:
                break
            guard_rounds += 1
    finally:
        proc.gold.close()
    _finish_reextract()
    if do_support and not run.stop and not guard.halted():
        out["support"] = support.run_queue(backends, run.router)
    if do_cross and not guard.halted():
        out["cross"] = support.cross_check(backends, run.router)
    out["queue_left"] = queue_left()
    if guard.halted():
        out["is_error"] = True
    return out
