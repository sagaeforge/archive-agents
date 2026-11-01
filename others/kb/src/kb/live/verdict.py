"""survival.verdict 만들기와 쓰기. 근거 없는 상태 변경은 여기서 거부한다(스키마는 signals 배열이 비어도 통과시키므로).
- 신호는 1개 이상이고 각 신호에 gold에 있는 스냅샷이 있어야 한다.
- 신호 스냅샷의 소스는 trust=primary여야 한다(소스가 src:adhoc이면 URL이 대상의 공식 위치일 때만).
- superseded는 successor가 필수다. 후속이 불명이면 호출자가 removed 경로로 보낸다."""
from __future__ import annotations

import hashlib
import json

from kb.core import ids
from kb.live import gold as G
from kb.live.model import LIVENESS, Decision, Sig, status_of

ACTOR = "live"
ADHOC = "src:adhoc"


class VerdictRejected(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


def successor_entity(unit: str, raw: str) -> str:
    """후속 이름 -> 엔티티 ID. 이미 e:로 시작하면 그대로 둔다. repo는 owner-name, package는 정규화한 이름이다."""
    if raw.startswith("e:"):
        return ids.check_public_id(raw)
    t = "repo" if unit in ("repo", "project") else ("package" if unit == "package" else unit if unit != "technique" else "technique")
    if unit == "project":
        t = "repo"
    return ids.entity_id(t, G.slug(raw))


def check_sources(con, sigs, unit: str, target_node: dict | None, require_gold: bool = True) -> None:
    from kb.ingest import rules as irules
    props = (target_node or {}).get("props") or {}
    label = (target_node or {}).get("label") or ""
    primary_hosts = _primary_hosts()
    for s in sigs:
        info = G.snapshot_source(con, s.snapshot) if s.snapshot else None
        if info is None:
            raise VerdictRejected("E_NO_EVIDENCE", f"신호 {s.id}: 스냅샷이 없거나 gold에 없다")
        if info["trust"] == "primary":
            continue
        if info["source"] == ADHOC and irules.official(unit, props, label, info["url"] or "", primary_hosts):
            continue
        raise VerdictRejected("E_LIVENESS_SOURCE", f"신호 {s.id}의 출처({info['source']}, trust={info['trust']})는 1차 출처가 아니다")


def _primary_hosts() -> set:
    try:
        from kb.collect import registry
        return {h for s in registry.load_registry(validate=False) if s.enabled and s.policy.get("trust") == "primary" for h in s.hosts()}
    except Exception:  # noqa: BLE001
        return set()


def build(d: Decision, decided_by: str, con=None, *, check: bool = True, liveness: str | None = None,
          successor: str | None = None) -> dict:
    """Decision(또는 사람 결정으로 덮은 liveness, successor)에서 survival.verdict 페이로드를 만든다."""
    lv = liveness or d.liveness
    if lv not in LIVENESS:
        raise VerdictRejected("E_SCHEMA", f"알 수 없는 liveness: {lv}")
    succ = successor or d.successor
    sigs = [s for s in d.signals if s.snapshot or not check]
    if check:
        with_snap = [s for s in d.signals if s.snapshot]
        if not with_snap:
            raise VerdictRejected("E_NO_EVIDENCE", "liveness 신호가 없다. 근거 없는 상태 변경은 거부한다")
        check_sources(con, with_snap, d.unit, G.node(con, d.target))
        sigs = with_snap
    elif not sigs:
        sigs = list(d.signals)
    if not sigs and check:
        raise VerdictRejected("E_NO_EVIDENCE", "liveness 신호가 없다")
    p = {"target": d.target, "unit": d.unit, "liveness": lv, "status": status_of(lv),
         "signals": [s.event() for s in sigs], "decided_by": decided_by}
    if lv == "superseded":
        if not succ:
            raise VerdictRejected("E_SUCCESSOR", "superseded에는 successor가 필요하다. 후속이 불명이면 removed 경로로 보낸다")
        p["successor"] = successor_entity(d.unit, succ)
    elif succ and lv in ("removed", "deprecated"):
        pass       # 후속 언급이 있어도 superseded가 아니면 edge를 만들지 않는다
    return p


def write(payload: dict, *, actor: str = ACTOR, origin: str = "system"):
    from kb.write import commit
    k = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    res = commit([{"kind": "survival.verdict", "actor": actor, "origin": origin, "subject": payload["target"],
                   "idem_key": f"live:verdict:{payload['target']}:{k}", "payload": payload}], actor, timeout=60.0)
    if getattr(res, "held", False):
        raise VerdictRejected("E_HELD", f"원장이 판정을 보류했다: {res.reason}")
    return res
