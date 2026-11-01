"""민감 범위 추출(ADR-0003 3장): sLLM Nemotron만, 네트워크 없는 이름공간 안에서. 어떤 외부 LLM으로도 가지 않는다.
입력은 first_party 레코드 본문(CAS)이다. fp_open 전에는 돌지 않는다. 파생 주장은 원본 민감도를 물려받는다(ADR 7.9)."""
from __future__ import annotations

import hashlib
import json

from kb.core import canon, cas, ids, opsdb
from kb.extract import cache, guard, prompt, runner, schema, settings, windows
from kb.extract.types import Job, Window

QUEUE = "l2s"
SENS = {"public": 0, "internal": 1, "private": 2, "secret": 3}


def record_text(con, rid: str) -> tuple:
    """(본문, 민감도 정수) 또는 (None, None)."""
    n = con.execute("SELECT content_sha, sensitivity, origin FROM node WHERE id=? AND expired_at IS NULL", (rid,)).fetchone()
    if not n or not n[0]:
        return None, None
    r = con.execute("SELECT body FROM content WHERE sha=?", (n[0],)).fetchone()
    if r is not None:
        return r[0], n[1]
    for tier in ("fp", "objects"):
        try:
            return cas.get(n[0], tier).decode("utf-8"), n[1]
        except Exception:  # noqa: BLE001
            continue
    return None, None


def inherited(floor: int, subject_sens: int = 0) -> int:
    """파생 주장의 민감도: 원본 이상으로만 쓴다."""
    return max(int(floor), int(subject_sens))


def run(run) -> dict:
    from kb.write import fpgate
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    from kb.parse import paragraphs as pg
    from kb.extract.backends.sllm import Session
    out = run.out
    if not fpgate.is_open():
        out["reason"] = "fp_closed"
        out["queue_left"] = _left()
        return out
    c = opsdb.connect()
    try:
        n = c.execute("SELECT count(*) FROM queue WHERE kind=?", (QUEUE,)).fetchone()[0]
    finally:
        c.close()
    if n == 0:                                           # 큐가 비었으면 띄우지 않는다
        out["reason"] = "queue_empty"
        return out
    plan = run.router.plan("sensitive", "extract")
    if not plan.cands:
        out["reason"] = plan.stop
        out["queue_left"] = _left()
        return out
    be = run.backends.get("sllm")
    pf = be.preflight()
    if not pf.ok:
        out["reason"] = f"sllm:{pf.reason}"
        out["queue_left"] = _left()
        return out
    gp = current_gold_path()
    con = connect_ro(gp, 60.0) if gp else None
    if con is None:
        out["reason"] = "no_gold"
        return out
    from kb.ingest.process import Processor
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "l2s-run", "producer": "agent:l2"}, fetch=False)
    cap = run.max_windows if run.max_windows is not None else 10**9
    pv = str(settings.get("prompt_version"))
    ext = f"l2:sllm:{settings.get('sllm.model', 'nemotron')}:{pv}"
    try:
        with Session() as sess:
            if not getattr(sess, "started", False):
                out["reason"] = f"sllm_skipped:{sess.skipped}"
                out["queue_left"] = _left()
                return out
            c = opsdb.connect()
            try:
                taken = opsdb.queue_take(c, QUEUE, int(settings.get("take_batch", 24)))
            finally:
                c.close()
            calls = [0]
            for it in taken:
                rid = it["ref"].split("|")[0]
                text, sens = record_text(con, rid)
                if text is None or sens is None or sens >= 3 or _excluded(con, rid, text):
                    _qdone(it["ref"])                         # 읽기 실패, secret, 세션 자료는 원문만 저장한다
                    continue
                paras = pg.paragraphs(text, "markdown")
                st = "done"
                for chunk in chunks(text, paras):
                    st = _window(run, proc, plan, be, ext, pv, rid, text, paras, sens, chunk, cap, calls)
                    if st != "done":
                        break
                if st == "done":
                    _qdone(it["ref"])
                elif st == "cap":
                    runner.unattempted(it["ref"], QUEUE)      # 끝난 창은 CAS 재생으로 건너뛰고 뒤를 잇는다
                else:
                    out["failed"] += 1
                    runner.retry_or_dlq(it, st, QUEUE)
    finally:
        con.close()
        proc.gold.close()
    out["queue_left"] = _left()
    return out


def chunks(text: str, paras: list, limit: int | None = None) -> list:
    """레코드 본문 전체를 6,000자 이하 창으로 나눈다. 뒷부분이 추출 없이 끝나지 않게 한다."""
    limit = int(limit or settings.get("window_chars", 6000))
    out, cur, size = [], [], 0
    for p in paras:
        t = text[p.start_cp:p.end_cp]
        if cur and size + len(t) + 2 > limit:
            out.append(cur)
            cur, size = [], 0
        cur.append((p.para_sha, t))
        size += len(t) + 2
    if cur:
        out.append(cur)
    return out


def _excluded(con, rid: str, text: str) -> bool:
    """추출 제외 자료(세션 자료, 비밀 탐지 검출)는 sLLM도 부르지 않는다(ADR-0003 2장)."""
    scope, _ = guard.classify_inputs([guard.inspect_snapshot(rid, text, con)])
    return scope == guard.EXCLUDED


def _window(run, proc, plan, be, ext, pv, rid, text, paras, sens, chunk, cap, calls) -> str:
    """창 하나. 반환 done | cap | 실패 사유. 원응답과 extract.run 페이로드를 먼저 남겨 재실행이 같은 이벤트를 쓰게 한다."""
    from kb.gate import GateCtx, check_claim
    from kb.write import commit
    out = run.out
    body = "\n\n".join(t for _, t in chunk)
    w = Window(f"{rid}#{chunk[0][0][:8]}", rid, body, chunk, [], rid, "", "", "")
    w.candidates = windows.candidates_for(proc, body, public=False)
    w.sha = hashlib.sha256(body.encode()).hexdigest()
    sch = schema.extract_schema([x["id"] for x in w.candidates])
    model = ext.split(":")[2]
    got = cache.raw_entry(w.sha, ext, model)
    if got and got.get("run_sha"):
        raw, payload = cas.get(got["output_sha"]).decode("utf-8"), json.loads(cas.get(got["run_sha"]).decode("utf-8"))
    else:
        if calls[0] >= cap:
            return "cap"
        calls[0] += 1
        job = Job(w, "extract", "sensitive", prompt.system_text(), prompt.user_message(w), sch, model)
        res = be.extract(job, None)
        if res.error or res.finish_reason == "length":
            return f"sllm:{res.error or 'truncated'}"[:200]
        raw = res.raw
        osha = cas.put(raw.encode())
        payload = {"window_sha": w.sha, "para_shas": w.para_shas, "prompt_version": pv, "model": model, "output_sha": osha,
                   "usage": res.usage or {}, "extractor": ext, "backend": "sllm", "provider": "local", "served_model": res.served_model,
                   "schema_profile": "full", "purpose": "extract", "scope": "sensitive", "route_reason": plan.cands[0].reason,
                   "finish_reason": res.finish_reason, "elapsed_s": None if res.elapsed_s is None else f"{res.elapsed_s:.3f}",
                   "cost_usd": "0.000000"}
        cache.raw_put(w.sha, ext, model, osha, cas.put(canon.canon_json(payload)))
    try:
        obj = schema.parse_raw(raw)
        if schema.validate(sch, obj):
            raise ValueError("schema")
    except ValueError:
        return "sllm:schema"
    evs = [{"kind": "extract.run", "actor": "l2", "origin": "system", "subject": rid, "idem_key": f"extract.run:{w.sha}:{ext}", "payload": payload}]
    text_sha = hashlib.sha256(text.encode()).hexdigest()
    for cl in obj["claims"]:
        if cl["subject"] == "__new__":
            out["rejected"] += 1                          # 민감 범위는 임시 엔티티를 만들지 않는다
            continue
        ent = proc.entity_info(cl["subject"])
        if ent is None:
            out["rejected"] += 1
            continue
        g = check_claim({"statement": cl["statement"], "quote": cl["quote"], "kind": cl["kind"], "stance": cl["stance"],
                         "speaker": cl.get("speaker")}, text, paras,
                        GateCtx(subject=cl["subject"], subject_aliases=tuple([ent["label"], *ent["aliases"]]), scope="sensitive"))
        if g.rejected:
            out["rejected"] += 1
            continue
        cid = ids.claim_id_llm(cl["subject"], cl["quote"])
        pay = {"id": cid, "subject": cl["subject"], "predicate": cl.get("predicate"), "statement": cl["statement"],
               "kind": cl["kind"], "stance": g.stance, "method": "llm", "verification": g.verification,
               "extractor": ext, "sensitivity_floor": inherited(sens),
               "evidence": [{"snapshot": rid, "selector_kind": "text_quote", "exact": g.exact, "start_cp": g.start_cp,
                             "end_cp": g.end_cp, "prefix": text[max(0, g.start_cp - 24):g.start_cp],
                             "suffix": text[g.end_cp:g.end_cp + 24], "text_sha": text_sha, "gate_version": "gate@1"}]}
        if g.speaker:
            pay["speaker"] = g.speaker
        evs.append({"kind": "claim.assert", "actor": "agent:l2", "origin": "system", "subject": cl["subject"],
                    "idem_key": f"l2s:claim:{cid}", "payload": pay})
        out["claims"] += 1
    commit(evs, "l2", timeout=60.0)
    out["windows"] += 1
    out["by_backend"]["sllm"] = out["by_backend"].get("sllm", 0) + 1
    return "done"


def _qdone(ref: str, requeue_at: int | None = None) -> None:
    c = opsdb.connect()
    try:
        opsdb.queue_done(c, QUEUE, ref, requeue_at=requeue_at)
    finally:
        c.close()


def _left() -> int:
    c = opsdb.connect()
    try:
        return c.execute("SELECT count(*) FROM queue WHERE kind=?", (QUEUE,)).fetchone()[0]
    finally:
        c.close()
