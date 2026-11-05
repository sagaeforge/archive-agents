"""모든 쓰기가 지나는 함수 하나(ADR 8장). ledger.db에 쓰는 코드는 이 모듈뿐이다.

순서: 검증(스키마, R6) -> first_party 게이트 -> Gate.acquire(5초, 수집기 60초)
      -> ledger BEGIN IMMEDIATE(가시성, 멱등, 버전, 내용 해시, CAS) -> COMMIT(FULL) -> 투영 -> 해제.

- 투영 실패나 문단 예산 초과는 쓰기 성공이다(projected=False). tick의 recover 단계가 잇는다.
- 게이트 시간 초과면 spool/in에 fsync로 남기고 spooled=True다. 재적재는 저장된 이벤트를 그대로 쓴다.
  귀속(actor, on_behalf_of, generated_by)은 멱등 비교에 들어가므로 재시도와 재적재에서 다시 계산하지 않는다.
- 보류와 스풀 파일은 queued_ns에 쓴 순서를 남긴다. 재적재는 파일 이름이 아니라 이 순서로 돈다. 같은 레코드를
  여러 번 쓰면 뒤 응답이 현재 버전이 되어야 하기 때문이다.
- 게이트 보유당 이벤트 100개 이하, 투영 문단 200개 이하. 이벤트가 더 많으면 100개씩 끊어 게이트를 나눠 쥐고
  묶음 사이에 10 ms 쉰다. 묶음은 서로 원자적이지 않다(한 묶음 안은 원자적이다).
- record.redact가 든 묶음은 읽기 연결이 막으면 busy_timeout(5초)까지 WAL 비우기를 기다리며 게이트를 쥔다
  (WP-01 인수인계). 그 사이 다른 쓰기는 게이트 대기 시간 제한 안에서 기다리고, 넘으면 spooled=True가 된다.
- record.redact로 지운 본문과 같은 내용을 새 idem_key로 쓰면 원장이 RedactedPayload를 던진다.
  commit은 이를 WriteRejected("redacted_payload")로 바꾸고, 스풀 재적재는 거부로 처리한다.
"""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any

from kb.core import cas, ledger, spool
from kb.core.canon import canon_json, sha256_hex
from kb.core.gatelock import Gate
from kb.project import current_gold_path, gate_path, open_gold, project_tail
from kb.write import policy, validate
from kb.write.errors import IdemConflict, RedactedPayload, VersionConflict, WriteRejected

MAX_EVENTS = 100
PARA_BUDGET = 200
BATCH_SLEEP_S = 0.010
GATE_TIMEOUT_S = 5.0
COLLECTOR_TIMEOUT_S = 60.0
BIG_BODY_BYTES = 64 * 1024
HELD_REASON = "offsite_path_missing"
EVENT_KEYS = ("kind", "actor", "origin", "idem_key", "subject", "payload", "on_behalf_of", "generated_by", "v",
              "event_id", "expected_version", "at", "noop_if_same", "editor_create", "editor_slug_missing")


@dataclass
class WriteResult:
    id: str | None = None
    version: int | None = None
    seq: int | None = None
    replayed: bool = False
    projected: bool = False
    spooled: bool = False
    held: bool = False
    warnings: list[str] = field(default_factory=list)
    reason: str | None = None
    events: list[dict] = field(default_factory=list)  # 이벤트별 {seq, version, replayed}. as_dict에는 없다
    unchanged: bool = False
    write_ref: str | None = None
    payload_sha: str | None = None
    quarantined: bool = False
    actor: str | None = None
    claimed_author: str | None = None
    generated_by: str | None = None

    def as_dict(self) -> dict:
        return {"id": self.id, "version": self.version, "seq": self.seq, "replayed": self.replayed,
                "projected": self.projected, "spooled": self.spooled, "held": self.held,
                "warnings": list(self.warnings), "reason": self.reason, "unchanged": self.unchanged,
                "write_ref": self.write_ref, "payload_sha": self.payload_sha, "quarantined": self.quarantined,
                "actor": self.actor, "claimed_author": self.claimed_author, "generated_by": self.generated_by}


def _ms() -> int:
    return int(time.time() * 1000)


def core_of(events: list[dict]) -> list[dict]:
    """authored_at을 뺀 비교용 사본. 보류 시각은 내용이 아니다."""
    out = []
    for e in events:
        e = {k: v for k, v in e.items() if k in EVENT_KEYS}
        if e.get("kind") == "record.put" and isinstance(e.get("payload"), dict):
            e["payload"] = {k: v for k, v in e["payload"].items() if k != "authored_at"}
        out.append(e)
    return out


def prepare(events, actor: str | None) -> list[dict]:
    evs = []
    for e in events:
        if not isinstance(e, dict):
            raise WriteRejected("schema_invalid", "이벤트는 객체여야 한다")
        ev = {k: e[k] for k in EVENT_KEYS if k in e}
        ev["actor"] = ev.get("actor") or actor
        if not ev["actor"]:
            raise WriteRejected("schema_invalid", "actor 필수")
        if ev.get("kind") not in ledger.KINDS:
            raise WriteRejected("schema_invalid", f"알 수 없는 kind: {ev.get('kind')!r}")
        if not isinstance(ev.get("payload"), dict):
            raise WriteRejected("schema_invalid", "payload는 객체")
        if ev.get("origin") not in ledger.ORIGINS:
            raise WriteRejected("schema_invalid", f"origin 오류: {ev.get('origin')!r}")
        if not ev.get("idem_key") or not isinstance(ev["idem_key"], str):
            raise WriteRejected("schema_invalid", "idem_key 필수")
        ev["payload"] = dict(ev["payload"])
        evs.append(ev)
    return evs


def _cas_bodies(evs: list[dict]) -> None:
    """64 KB 넘는 본문은 raw/fp에 넣고 다이제스트만 원장에 둔다."""
    for ev in evs:
        p = ev["payload"]
        if ev["kind"] == "record.put" and isinstance(p.get("body"), str) and len(p["body"].encode()) > BIG_BODY_BYTES:
            p["body_sha"] = cas.put(p.pop("body").encode(), tier="fp")


def fp_is_open(led) -> bool:
    return ledger.meta_get(led, "fp_open") is not None


def hold_name(evs: list[dict]) -> str:
    return sha256_hex("\n".join(sorted(e["idem_key"] for e in evs)).encode())


def _spool_name(evs: list[dict]) -> str:
    return sha256_hex(canon_json({"v": 1, "events": evs}))


def _queued(evs: list[dict]) -> dict:
    """스풀 본문. 파일 이름은 해시라 순서가 없으므로 쓴 순서를 queued_ns로 남긴다(fpgate.ordered가 쓴다)."""
    return {"v": 1, "queued_ns": time.time_ns(), "events": evs}


def _hold(evs: list[dict]) -> WriteResult:
    now = _ms()
    for ev in evs:
        if ev["kind"] == "record.put":
            ev["payload"].setdefault("authored_at", now)
    body = _queued(evs)
    name = hold_name(evs)
    try:
        spool.put("fp-held", body, name)
    except spool.SpoolConflict:
        old = spool.dir_of("fp-held") / f"{name}.json"
        import json as _json
        prior = _json.loads(old.read_bytes())
        if canon_json(core_of(prior["events"])) != canon_json(core_of(evs)):
            raise IdemConflict(f"fp-held {name[:12]}: 같은 키에 내용이 다른 보류 항목이 있음") from None
    first = evs[0]
    primary = next((e for e in evs if e["kind"] in ledger.RECORD_KINDS), first)
    return WriteResult(id=first.get("subject") or first["payload"].get("id"), held=True, reason=HELD_REASON,
                       payload_sha=sha256_hex(canon_json(storage_payload(primary["payload"]))),
                       actor=primary["actor"], claimed_author=primary.get("on_behalf_of"),
                       generated_by=primary.get("generated_by"),
                       quarantined=bool((primary["payload"].get("props") or {}).get("quarantine")))


def _done(led, r) -> bool:
    """예산이 정확히 찬 마지막 이벤트도 따라잡은 것이다. 원장 머리까지 갔는지로 판정한다."""
    return not r.env_error and (bool(r.caught_up) or r.last_seq >= ledger.head(led)[0])


def _project(led, budget: int = PARA_BUDGET) -> tuple[bool, list[str]]:
    p = current_gold_path()
    if p is None:
        return False, []
    try:
        g = open_gold(p)
        try:
            r = project_tail(led, g, None, budget)
        finally:
            g.close()
    except Exception as e:  # noqa: BLE001 투영 실패는 쓰기 성공이다
        return False, [f"projection_failed:{type(e).__name__}"]
    return _done(led, r), []


def storage_payload(payload: dict) -> dict:
    """CAS를 만들지 않고 원장에 들어갈 본문 해시 표현을 계산한다."""
    p = dict(payload)
    if isinstance(p.get("body"), str) and len(p["body"].encode()) > BIG_BODY_BYTES:
        p["body_sha"] = sha256_hex(p.pop("body").encode())
    return p


def comparable_payload(payload: dict) -> dict:
    """보류 시각을 제외한 내용을 비교한다. 입력/CAS를 바꾸지 않는다."""
    return storage_payload({k: v for k, v in payload.items() if k != "authored_at"})


def _is_editor(ev):
    return ev.get("origin") == "first_party" and str(ev.get("actor", "")).startswith("app:") \
        and ev.get("kind") in ("record.put", "record.tombstone")


def _prefilter(led, chunk: list[dict]) -> tuple[list[dict], dict[int, dict]]:
    keep, skipped = [], {}
    pending_subjects = set()
    for i, ev in enumerate(chunk):
        if ev["kind"] in ledger.RECORD_KINDS and ev["subject"] in pending_subjects:
            # 같은 묶음 앞쪽에서 머리가 바뀔 대상은 append의 순차 판정에 맡긴다.
            keep.append(ev)
            continue
        flag = ev.get("noop_if_same", False)
        prior = prior_event(led, ev["idem_key"])
        if not prior and ev["kind"] in ledger.RECORD_KINDS:
            head = ledger.record_head(led, ev["subject"])
            expected = ev.get("expected_version")
            current = head[0] if head else 0
            if expected is not None and expected != current:
                raise VersionConflict()
        if flag and ev["kind"] == "record.put":
            head = ledger.record_head(led, ev["subject"])
            # 지운(redact) 본문은 같은 내용이어도 무연산으로 넘기지 않는다. 원장이 RedactedPayload로 거부하게 둔다
            old = ledger.get_payload(led, head[1]) if head else None
            same = old is not None and comparable_payload(old) == comparable_payload(ev["payload"])
            # 같은 idem_key의 이벤트가 이미 있으면 멱등 판정(귀속 포함)은 원장에 맡긴다
            if same and not prior:
                r = led.execute("SELECT seq FROM event WHERE subject=? AND kind IN ('record.put','record.tombstone',"
                                "'record.redact') ORDER BY seq DESC LIMIT 1", (ev["subject"],)).fetchone()
                skipped[i] = {"seq": r[0] if r else None, "version": head[0], "replayed": True, "unchanged": True}
                continue
        keep.append(ev)
        if ev["kind"] in ledger.RECORD_KINDS:
            pending_subjects.add(ev["subject"])
    return keep, skipped


def _write_chunk(led, chunk: list[dict], *, dry_run: bool = False) -> tuple[list[dict], bool, list[str], bool]:
    keep, skipped = [], {}
    warns: list[str] = []
    held = False

    def prepare_locked(events):
        nonlocal keep, skipped, held
        for ev in events:
            if _is_editor(ev):
                from kb.write.record import editor_guard, editor_dangling
                editor_guard(led, ev)
                warns.extend(editor_dangling(led, ev))
        keep, skipped = _prefilter(led, events)
        if dry_run:
            return []
        if any(e["origin"] == "first_party" for e in keep) and not fp_is_open(led):
            held = True
            return []
        # 큰 본문은 가시성/재생/판/무연산을 확인한 뒤에만 CAS에 둔다.
        for ev in keep:
            view = storage_payload(ev["payload"])
            sha = sha256_hex(canon_json(view))
            if not led.execute("SELECT 1 FROM payload WHERE sha=?", (sha,)).fetchone() \
                    and led.execute("SELECT 1 FROM event WHERE payload_sha=? LIMIT 1", (sha,)).fetchone():
                raise RedactedPayload("지운 본문과 같은 내용")
            if prior_event(led, ev["idem_key"]):
                ev["payload"] = view
            else:
                _cas_bodies([ev])
        return keep

    try:
        done = ledger.append(led, chunk, prepare_locked=prepare_locked)
    except RedactedPayload as e:
        raise WriteRejected("redacted_payload", str(e)) from e
    if dry_run or held:
        return [], False, warns, held
    for r in done:
        if r.get("wal_cleared") is False:
            warns.append("wal_not_cleared")
    it = iter(done)
    out = [skipped[i] if i in skipped else next(it) for i in range(len(chunk))]
    proj, w = _project(led)
    return out, proj, warns + w, False


def commit(events, actor: str | None = None, *, timeout: float = GATE_TIMEOUT_S, spool_on_timeout: bool = True,
           stored: bool = False, _led=None, dry_run: bool = False) -> WriteResult:
    """이벤트를 원장에 쓴다. 입력 검증 실패는 WriteRejected, 멱등 충돌과 버전 불일치는 원장 예외 그대로다.
    stored=True는 스풀에서 꺼낸 이벤트다. 입력 검증은 건너뛰고 잠금 안 대상/판/CAS 검사는 반복한다."""
    evs = prepare(events, actor)
    if not evs:
        raise WriteRejected("schema_invalid", "이벤트가 없다")
    if not stored:
        for ev in evs:
            validate.validate_event(ev)
        policy.lint_events(evs)
    led = _led or ledger.open_ledger()
    try:
        if not dry_run and not any(_is_editor(e) for e in evs) \
                and any(e["origin"] == "first_party" for e in evs) and not fp_is_open(led):
            return _hold(evs)
        chunks = [evs[i:i + MAX_EVENTS] for i in range(0, len(evs), MAX_EVENTS)]
        items: list[dict] = []
        warns: list[str] = []
        projected, spooled, reason = True, False, None
        gate = Gate(gate_path())
        for ci, chunk in enumerate(chunks):
            if ci:
                time.sleep(BATCH_SLEEP_S)
            if dry_run:
                # SQLite의 BEGIN IMMEDIATE가 검증 스냅샷을 고정한다. 읽기뿐인
                # 검증에는 파일을 만드는 flock 게이트/투영/스풀이 필요하지 않다.
                out, proj, w, held = _write_chunk(led, chunk, dry_run=True)
                warns += w
                projected = False
                continue
            if not gate.path.exists():
                # 첫 게이트 파일은 대상/재생/판 검사를 통과한 후보에만 만든다.
                # 사전 검사는 권한 부여가 아니다. 게이트 획득 뒤 같은 검사를
                # 다시 실행해 그 사이의 변경도 확인한다. 잠금 파일은 지우지 않는다.
                _write_chunk(led, chunk, dry_run=True)
            try:
                fd = gate.acquire(timeout)
            except TimeoutError:
                if not spool_on_timeout or dry_run:
                    raise
                rest = [e for c in chunks[ci:] for e in c]
                for e in rest:
                    e.pop("noop_if_same", None)
                try:
                    spool.put("in", _queued(rest), _spool_name(rest))
                except spool.SpoolConflict:  # 이름이 이벤트의 해시다. 같은 이벤트가 먼저 대기 중이고 그 순서를 지킨다
                    pass
                spooled, projected, reason = True, False, "gate_timeout"
                break
            try:
                out, proj, w, held = _write_chunk(led, chunk, dry_run=dry_run)
                if held:
                    return _hold(chunk)
            finally:
                gate.release(fd)
            items.extend(out)
            warns += w
            projected = projected and proj
        if not items and not spooled:
            projected = False
        first = evs[0]
        primary = next((e for e in evs if e["kind"] in ledger.RECORD_KINDS), first)
        ver = next((i["version"] for i in items if i.get("version") is not None), None)
        row = led.execute("SELECT payload_sha, actor, on_behalf_of, generated_by FROM event WHERE seq=?",
                          (items[-1]["seq"],)).fetchone() if items else None
        return WriteResult(id=first.get("subject") or first["payload"].get("id"), version=ver,
                           seq=items[-1]["seq"] if items else None,
                           replayed=bool(items) and all(i["replayed"] for i in items) and not spooled,
                           projected=projected, spooled=spooled, warnings=warns, reason=reason,
                           unchanged=any(i.get("unchanged", False) for i in items),
                           payload_sha=row[0] if row else sha256_hex(canon_json(comparable_payload(primary["payload"]))),
                           actor=row[1] if row else primary["actor"],
                           claimed_author=row[2] if row else primary.get("on_behalf_of"),
                           generated_by=row[3] if row else primary.get("generated_by"),
                           quarantined=bool((primary["payload"].get("props") or {}).get("quarantine")),
                           events=[{"seq": i["seq"], "version": i.get("version"), "replayed": i["replayed"]} for i in items])
    finally:
        if _led is None:
            led.close()


def project_pending(*, timeout: float = GATE_TIMEOUT_S, max_rounds: int = 50) -> dict:
    """gold가 원장 머리를 따라잡게 한다. 한 번에 게이트를 쥐는 투영은 문단 200개 이하이고 라운드 사이에 10 ms 쉰다.
    current gold가 없으면 재구축한다."""
    if current_gold_path() is None:
        from kb.project import rebuild
        r = rebuild()
        return {"caught_up": True, "rounds": 0, "rebuilt": True, "build": r.build}
    led = ledger.open_ledger()
    gate = Gate(gate_path())
    rounds, caught = 0, False
    try:
        while rounds < max_rounds:
            fd = gate.acquire(timeout)
            try:
                p = current_gold_path()
                g = open_gold(p)
                try:
                    r = project_tail(led, g, None, PARA_BUDGET)
                finally:
                    g.close()
            finally:
                gate.release(fd)
            rounds += 1
            if r.env_error:
                raise RuntimeError(f"투영 환경 오류: {r.env_error}")
            if _done(led, r):
                caught = True
                break
            time.sleep(BATCH_SLEEP_S)
    finally:
        led.close()
    return {"caught_up": caught, "rounds": rounds, "rebuilt": False}


def prior_event(led, idem_key: str) -> dict | None:
    """idem_key로 이미 쓴 이벤트(귀속 포함)와 payload."""
    r = led.execute("SELECT seq, kind, subject, actor, on_behalf_of, generated_by, payload_sha FROM event WHERE idem_key=?",
                    (idem_key,)).fetchone()
    if not r:
        return None
    return {"seq": r[0], "kind": r[1], "subject": r[2], "actor": r[3], "on_behalf_of": r[4], "generated_by": r[5],
            "payload": ledger.get_payload(led, r[6])}
