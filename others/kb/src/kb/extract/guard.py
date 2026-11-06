"""민감도 경계(ADR-0003 3장). 외부 LLM으로 가는 모든 전송이 여기를 지난다. 모르면 거부한다.
허가 근거는 저장된 origin, sensitivity, 표시, 비밀 탐지뿐이다. LLM 분류는 허가 근거가 아니다.
외부 어댑터는 이 모듈이 낸 SendPermit 없이 요청을 만들 수 없다. 위반은 incidents external_send와 L2 정지다."""
from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass

from kb.extract import state
from kb.extract.types import EXTERNAL

HALT_KEY = "llm:halt"
_SECRET = os.urandom(32)
PUBLIC, SENSITIVE, EXCLUDED = "public", "sensitive", "excluded"


class GuardDenied(Exception):
    def __init__(self, reason: str, scope: str = SENSITIVE):
        super().__init__(reason)
        self.reason, self.scope = reason, scope


class PermitError(Exception):
    pass


@dataclass(frozen=True)
class SendPermit:
    backend: str
    window_sha: str
    sig: str

    def valid_for(self, backend: str, window_sha: str) -> bool:
        return (self.backend == backend and self.window_sha == window_sha
                and hmac.compare_digest(self.sig, _sig(backend, window_sha)))


def _sig(backend: str, window_sha: str) -> str:
    return hmac.new(_SECRET, f"{backend}|{window_sha}".encode(), hashlib.sha256).hexdigest()


def window_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _para_scope(p: dict) -> tuple:
    """p: {origin, sensitivity, display, text}. 반환 (scope, 사유)."""
    if p.get("error"):
        return SENSITIVE, "read_failed"
    sens, origin, disp = p.get("sensitivity"), p.get("origin"), p.get("display") or ""
    if sens is None or origin is None:
        return SENSITIVE, "unknown_value"
    if str(disp).startswith("f:agent:"):
        return EXCLUDED, "session_material"
    if sens >= 3:
        return EXCLUDED, "secret"
    text = p.get("text") or ""
    if text:
        from kb.write import secrets_scan
        try:
            if secrets_scan.scan_text(text):
                return EXCLUDED, "secret_detected"
        except Exception:  # noqa: BLE001 탐지기를 못 돌리면 모르는 것이다
            return SENSITIVE, "scan_failed"
    if origin != "external" or str(disp).startswith("f:"):
        return SENSITIVE, "first_party"
    if sens >= 1:
        return SENSITIVE, "sensitivity"
    return PUBLIC, "public"


def classify_inputs(paras: list) -> tuple:
    """창 안 문단 하나라도 공개가 아니면 창 전체가 그 범위다. 제외 > 민감 > 공개."""
    if not paras:
        return SENSITIVE, "empty"
    worst, why = PUBLIC, "public"
    for p in paras:
        s, r = _para_scope(p)
        if s == EXCLUDED:
            return s, r
        if s == SENSITIVE and worst == PUBLIC:
            worst, why = s, r
    return worst, why


def _body_not_external(con, snapshot_id: str) -> bool:
    """스냅샷의 본문 출처. (1) 이 노드의 어느 판에서든 출처가 외부가 아니었던 적이 있으면(first_party snapshot.text가 본문을
    바꾼 경우) 참. (2) 같은 text_sha를 가진 다른 스냅샷이 외부가 아니면 참(본문 객체를 공유한다)."""
    if con.execute("SELECT 1 FROM node WHERE id=? AND origin<>'external' LIMIT 1", (snapshot_id,)).fetchone():
        return True
    cur = con.execute("SELECT json_extract(CAST(props AS TEXT),'$.text_sha') FROM node WHERE id=? AND expired_at IS NULL",
                      (snapshot_id,)).fetchone()
    sha = cur[0] if cur else None
    if not sha:
        return False
    return con.execute("SELECT 1 FROM node WHERE type='Snapshot' AND origin<>'external' AND id<>? AND expired_at IS NULL "
                       "AND json_extract(CAST(props AS TEXT),'$.text_sha')=? LIMIT 1", (snapshot_id, sha)).fetchone() is not None


def inspect_snapshot(snapshot_id: str, text: str, con=None) -> dict:
    """gold의 head에서 최신 민감도를 읽는다. 읽기 실패나 값 없음이면 error/None이다."""
    from kb.core.conn import connect_ro
    from kb.project import current_gold_path
    out = {"text": text, "origin": None, "sensitivity": None, "display": None}
    own = None
    try:
        if con is None:
            p = current_gold_path()
            if p is None:
                out["error"] = "no_gold"
                return out
            own = con = connect_ro(p, 30.0)
        n = con.execute("SELECT origin, type, author FROM node WHERE id=? AND expired_at IS NULL", (snapshot_id,)).fetchone()
        h = con.execute("SELECT sensitivity FROM head WHERE id=?", (snapshot_id,)).fetchone()
        if n:
            out["origin"] = n[0]
            out["display"] = ("f:" + (n[2] or "user")) if n[0] == "first_party" else None
        out["sensitivity"] = h[0] if h else None
        if n and n[0] == "external" and n[1] == "Snapshot" and _body_not_external(con, snapshot_id):
            out["origin"] = "first_party"                  # 본문 출처가 외부가 아니다. 모르면 막는다
            out["display"] = "f:user"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}"
    finally:
        if own is not None:
            own.close()
    return out


def authorize(paras: list, backend: str, text_sent: str) -> SendPermit | None:
    """외부 백엔드면 SendPermit, sLLM이면 None. 공개 범위가 아니면 GuardDenied."""
    if halted():
        raise GuardDenied("halted", SENSITIVE)
    scope, why = classify_inputs(paras)
    if backend in EXTERNAL:
        if scope != PUBLIC:
            state.metric("llm.guard_denied", 1, {"backend": backend, "scope": scope, "why": why})
            raise GuardDenied(why, scope)
        sha = window_sha(text_sent)
        return SendPermit(backend, sha, _sig(backend, sha))
    return None


def verify(permit, backend: str, text_sent: str) -> None:
    """어댑터가 요청을 만들기 직전에 부른다. 허가가 없거나 다르면 사고로 남기고 L2를 멈춘다."""
    if not (isinstance(permit, SendPermit) and permit.valid_for(backend, window_sha(text_sent))):
        violation(backend, "SendPermit 없이 외부 전송 시도")
        raise PermitError(f"{backend}: SendPermit 없음")


def violation(backend: str, detail: str) -> None:
    state.incident("external_send", f"{backend}: {detail}")
    state.put(HALT_KEY, {"reason": detail, "backend": backend})
    state.metric("llm.external_send_incident", 1, {"backend": backend})


def halted() -> bool:
    return bool(state.get(HALT_KEY))


def clear_halt() -> None:
    state.delete(HALT_KEY)
