"""적재 계약 kb-ingest/1(WP-08). 공개 함수: validate, submit. ADR 9장이 규범이고 계약 원본은 schemas/ingest/다."""
from __future__ import annotations

from dataclasses import dataclass, field

from kb.ingest.bundle import (CONTRACT, MAX_BUNDLE_ITEMS, MAX_CALL_ITEMS, ContractError, check_call_limit, from_objects,
                              parse_lines, read_path)
from kb.ingest.process import Outcome, Processor
from kb.write.errors import IdemConflict, VersionConflict, WriteRejected

__all__ = ["validate", "submit", "Report", "ContractError", "read_path", "from_objects", "parse_lines", "check_call_limit",
           "CONTRACT", "MAX_BUNDLE_ITEMS", "MAX_CALL_ITEMS"]


@dataclass
class Report:
    header: dict
    lines: list = field(default_factory=list)       # 항목별 결과 dict (ADR 9.3)
    new_events: int = 0
    replayed: int = 0
    wrote: bool = False

    def summary(self) -> dict:
        c = {"accepted": 0, "needs_review": 0, "held": 0, "rejected": 0}
        for r in self.lines:
            c[r["result"]] += 1
        return {**c, "batch_id": self.header["batch_id"], "contract": CONTRACT, "new_events": self.new_events,
                "replayed": self.replayed}

    @property
    def exit_code(self) -> int:
        return 1 if self.summary()["rejected"] else 0

    def ndjson(self) -> list:
        return [*self.lines, {"summary": self.summary()}]


def _map_reject(e: WriteRejected) -> tuple:
    if e.code == "policy_r6":
        return "E_R6_SCORE", str(e)[:160]
    if e.code in ("schema_invalid", "bad_transport", "bad_session"):
        return "E_SCHEMA", str(e)[:160]
    return "E_POLICY", str(e)[:160]


def _commit(p: Processor, events: list) -> tuple:
    """이벤트를 쓴다. 멱등 충돌은 그 이벤트만의 일이다. 묶어 쓰다 충돌하면 나머지를 버리지 않게 하나씩 쓴다.
    예: 다른 actor가 같은 series.define을 먼저 썼어도 series.batch는 저장되어야 한다. 반환: (결과 목록, 충돌 수)."""
    from kb.write import commit
    try:
        return [commit(events, p.producer, timeout=60.0)], 0
    except IdemConflict as e:
        if len(events) == 1:
            raise
        first = e
    done, conflicts = [], 0
    for ev in events:
        try:
            done.append(commit([ev], p.producer, timeout=60.0))
        except IdemConflict as e:
            first, conflicts = e, conflicts + 1
    if not done:
        raise first
    return done, conflicts


def _persist(p: Processor, out: Outcome, rep: Report) -> None:
    """쓰기. out을 제자리에서 바꾼다."""
    if out.record is not None:
        from kb.write import put_record
        rec, key = out.record
        try:
            r = put_record(rec, key, "inbox")
        except WriteRejected as e:
            out.result, out.code, out.detail = "rejected", *_map_reject(e)
            return
        except (IdemConflict, VersionConflict) as e:
            out.result, out.code, out.detail = "rejected", "E_POLICY", f"같은 키에 다른 내용이 이미 있다: {str(e)[:120]}"
            return
        if r.held:
            out.result, out.code, out.detail = "held", "H_FP_CLOSED", "first_party 개방 전"
        rep.new_events += sum(1 for e in r.events if not e["replayed"])
        rep.replayed += sum(1 for e in r.events if e["replayed"])
        rep.wrote = True
        return
    if not out.events:
        return
    for f in out.before:
        f()
    try:
        results, _ = _commit(p, out.events)
    except WriteRejected as e:
        if not out.audit:
            out.result, out.code, out.detail = "rejected", *_map_reject(e)
            p.rollback(out.undo)
        return
    except IdemConflict as e:
        if any(ev.get("kind") == "claim.assert" for ev in out.events):
            # 주장은 id가 내용이 아닌 증거 문구로 정해진다. 다른 내용과 부딪히면 gold에 없으니 수락이 아니다.
            out.result, out.code = "rejected", "E_POLICY"
            out.detail = f"같은 키에 다른 내용이 이미 있다: {str(e)[:120]}"
            p.rollback(out.undo)
            return
        out.would_be = dict(out.would_be or {}, existing=True)
        out.detail = out.detail or f"같은 키에 다른 내용이 이미 있다(새 항목을 만들지 않는다): {str(e)[:80]}"
        return
    for r in results:
        rep.new_events += sum(1 for e in r.events if not e["replayed"])
        rep.replayed += sum(1 for e in r.events if e["replayed"])
    if any(r.held for r in results):
        out.result, out.code, out.detail = "held", "H_FP_CLOSED", "first_party 개방 전"
    rep.wrote = True
    if p.gold.conn() is None:           # 첫 쓰기: gold가 아직 없으면 만든다
        from kb.write.engine import project_pending
        project_pending()
    for f in out.after:
        f()


def _run(header: dict, items: list, *, fetch: bool, write: bool, profile: str | None) -> Report:
    p = Processor(header, fetch=fetch, write=write, profile=profile)
    rep = Report(header)
    try:
        for line, it in items:
            out = p.handle(line, it)
            if write and (out.events or out.record is not None):
                _persist(p, out, rep)
            elif not write and out.result == "rejected":
                pass
            row = {"line": line, "ref": it.get("ref"), "result": out.result}
            if out.code:
                row["code"] = out.code
            if out.detail:
                row["detail"] = out.detail
            if out.would_be and out.result in ("accepted", "needs_review", "held"):
                row["would_be"] = out.would_be
            rep.lines.append(row)
    finally:
        p.gold.close()
    return rep


def validate(items, *, fetch: bool = True, profile: str | None = None) -> Report:
    """쓰기 없음. 스냅샷 생성(capture)만 예외다. fetch=False면 네트워크 없이 24시간 안의 기존 스냅샷만 쓴다.
    items: (머리, [(줄, 객체)]) 또는 객체 배열(첫 객체가 머리)."""
    header, rows = _norm(items)
    return _run(header, rows, fetch=fetch, write=False, profile=profile)


def submit(items, *, fetch: bool = True, profile: str | None = None) -> Report:
    """게이트를 지나 쓴다. 멱등: 같은 묶음을 다시 내면 새 이벤트가 0건이다."""
    header, rows = _norm(items)
    return _run(header, rows, fetch=fetch, write=True, profile=profile)


def _norm(items):
    if isinstance(items, tuple) and len(items) == 2 and isinstance(items[0], dict):
        return items
    return from_objects(list(items))
