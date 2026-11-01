"""판정 규칙. 적용 순서는 이동 -> 명시 선언 -> 단위 분리 -> 조건 추출 -> 날짜 -> 침묵 -> 교차 확인 -> 재검사 -> 기법 전파
(sources-inventory-g 3.4, ADR 13장). 입력은 Sig 목록이고 출력은 Decision이다. 점수를 만들지 않는다.
단일 신호로 죽음을 확정하지 않는다: removed는 묘비·상태 행(M12, M14, M20 퇴역) + 독립된 교차 확인이 있을 때만 자동이다."""
from __future__ import annotations

from kb.live.model import Decision, Item, Sig

MOVE_IDS = ("M02", "M11", "M15")
DECL_IDS = ("M01", "M05", "M06", "M07", "M08", "M12", "M14", "M20", "M21", "M18")
SILENT_IDS = ("M04", "M09")
HARD_REMOVED_IDS = ("M12", "M14", "M20", "M21", "M18")


def canonical_chain(start: str, step, max_hops: int = 6) -> list:
    """이동 체인을 끝까지 따라간다. step(name) -> 다음 이름 또는 None. 순환과 과도한 길이를 막는다.
    glittercowboy -> gsd-build -> open-gsd/gsd-core처럼 뒤 단계는 README만 알리는 경우도 step이 처리한다."""
    chain, seen = [start], {start.lower()}
    cur = start
    for _ in range(max_hops):
        nxt = step(cur)
        if not nxt or nxt.lower() in seen:
            break
        chain.append(nxt)
        seen.add(nxt.lower())
        cur = nxt
    return chain


def _by(sigs, *ids):
    return [s for s in sigs if s.id in ids]


def _first_succ(sigs):
    for s in sigs:
        v = (s.data or {}).get("successor")
        if v:
            return v, s
    return None, None


def cross_checked(sigs) -> bool:
    """독립된 두 종류의 제거 근거. 하나는 묘비·상태 행·퇴역 표(M12, M14, M20, M21, M18)여야 한다.
    제품 기능은 변경 이력(M16 후보)과 현행 문서(M14, M12)를 둘 다 봐야 한다(한쪽에만 있는 제거가 실제로 있었다)."""
    kinds = set()
    for s in sigs:
        if s.id in HARD_REMOVED_IDS and s.kind in ("removed",):
            kinds.add(s.id)
        elif s.id == "M16" and s.kind == "candidate" and (s.data or {}).get("verb") in ("removed", "dropped", "retired", "unshipped", "no longer available", "sunset"):
            kinds.add("M16")
        elif s.id == "M05" and s.kind == "decl":
            kinds.add("M05")
        elif s.id == "M01" and s.kind == "archive":
            kinds.add("M01")
    hard = kinds & set(HARD_REMOVED_IDS)
    return bool(hard) and len(kinds) >= 2


def decide(target: str, unit: str, sigs: list, *, current: str | None = None, now_ms: int | None = None,
           self_name: str = "") -> Decision:
    """target의 단위 unit에 대한 판정. current는 지금 gold의 liveness(없으면 None)."""
    d = Decision(target=target, unit=unit, liveness="alive", current=current)
    sigs = list(sigs)
    d.signals = sigs

    # 9. 기법: 근거 기능에 묶는다. 자동 판정이 없고 항상 H05다
    if unit == "technique":
        dead = [s for s in sigs if s.id == "DEP" and s.kind == "removed"]
        d.liveness = current or "alive"
        d.auto = False
        if dead:
            d.queue.append(Item("H05", f"근거 기능이 죽음: {dead[0].quote}", "stale_suspect"))
        return d

    # 8. 재검사: removed/superseded가 번복되었는가(M17). revived는 H06, H07이므로 후보로만 남는다
    revive = _by(sigs, "M17")
    if current in ("removed", "superseded") and revive:
        d.liveness, d.auto = "revived", False
        d.queue.append(Item("H07", f"번복 문구: {revive[0].quote}", "revived"))
        d.notes.append("번복 후보. 사람이 확정한다")
        return d

    # 1. 이동 먼저
    moves = _by(sigs, *MOVE_IDS)
    for m in moves:
        c = (m.data or {}).get("canonical")
        if c:
            d.canonical = c
            break

    # 2. 명시 선언
    decl = [s for s in sigs if s.id in DECL_IDS and s.kind != "info"]
    removed_hard = [s for s in decl if s.id in HARD_REMOVED_IDS and s.kind == "removed"]
    succ, succ_sig = _first_succ(decl)
    silent = _by(sigs, *SILENT_IDS) + _by(sigs, "M03", "M10", "M13", "M23")
    suspects = [s for s in silent if s.kind == "suspect"]
    dates = [s for s in sigs if s.id in ("M20", "M14", "M16") and (s.data or {}).get("removal_date")]
    conds = []
    for s in sigs:
        for c in (s.data or {}).get("conditions") or []:
            if c not in conds:
                conds.append(c)

    if decl or [s for s in sigs if s.id == "M16" and s.kind == "candidate"]:
        # 3. 단위 분리: 저장소 신호를 프로젝트 판정으로 올리지 않는다
        if unit == "repo":
            archived = _by(sigs, "M01")
            readme = _by(sigs, "M05")
            if succ:
                d.liveness, d.successor = "superseded", succ
                d.recheck.append({"unit": "project", "target": succ, "why": "저장소 후속 명시. 프로젝트는 후속을 따라 재검사"})
                d.notes.append("저장소 단위 superseded. 프로젝트 판정은 후속 저장소에서 다시 한다")
                return _finish(d, sigs, silent, current)
            if readme:
                d.liveness, d.auto = "deprecated", True
                d.queue.append(Item("H02", "README가 폐기를 선언했으나 후속 불명", "removed"))
                return _finish(d, sigs, silent, current)
            if archived:
                # archived는 양방향으로 틀린다. 저장소 종료일 뿐 removed가 아니다
                d.liveness = "stale_suspect"
                d.queue.append(Item("H02", "archived. 프로젝트 종료 여부는 사람이 본다", "removed"))
                return _finish(d, sigs, silent, current)
        # 패키지, 문서, 기능, 모델, 피드
        # 4. 조건 추출: 제거가 모델, 요금제, 인증, 플랫폼 조건에서만 일어나면 partial이다(H08)
        if conds and any(s.kind in ("removed", "deprecated", "candidate") for s in sigs if s.id in ("M14", "M16")):
            d.liveness, d.conditions = "partial", conds
            return _finish(d, sigs, silent, current)
        if removed_hard:
            if cross_checked(sigs):
                if succ:
                    d.liveness, d.successor = "superseded", succ
                else:
                    d.liveness = "removed"
                return _finish(d, sigs, silent, current)
            # 교차 확인 없음: 자동 확정하지 않는다
            d.liveness = current or "alive"
            d.auto = False
            d.queue.append(Item("H01", "제거 신호가 한쪽에만 있음(교차 확인 필요): " + (removed_hard[0].quote or ""), "removed"))
            d.notes.append("교차 확인 대기")
            return _finish(d, sigs, silent, current, keep=True)
        if succ:
            d.liveness, d.successor = "superseded", succ
            return _finish(d, sigs, silent, current)
        # 5. 날짜
        if dates:
            d.liveness, d.removal_date = "scheduled_removal", max(s.data["removal_date"] for s in dates)
            d.conditions = conds
            return _finish(d, sigs, silent, current)
        if [s for s in decl if s.kind in ("deprecated", "decl")]:
            d.liveness = "deprecated"
            return _finish(d, sigs, silent, current)
        # M16 후보만 있음: 사람이 본다
        cands = [s for s in sigs if s.id == "M16" and s.kind == "candidate"]
        if cands:
            d.liveness, d.auto = current or "alive", False
            d.queue.append(Item("H05" if unit == "feature" else "H08", "변경 이력 후보: " + (cands[0].quote or ""), "removed"))
            return _finish(d, sigs, silent, current, keep=True)

    # 날짜가 있는 모델 표 행(M20 date)은 위 decl 에 안 든다(kind=date)
    if dates:
        d.liveness, d.removal_date = "scheduled_removal", max(s.data["removal_date"] for s in dates)
        d.conditions = conds
        return _finish(d, sigs, silent, current)

    # 이동만 있으면 renamed
    if moves and d.canonical:
        d.liveness = "renamed"
        return _finish(d, sigs, silent, current)

    # 6. 침묵: M04, M09, M10 등은 stale_suspect까지만 간다. 자동으로 removed가 되지 않는다
    if suspects:
        d.liveness = "stale_suspect"
        d.queue.append(Item("H04", "선언 없이 멈춤: " + ", ".join(sorted({s.id for s in suspects})), "removed"))
        return _finish(d, sigs, silent, current)

    d.liveness = "alive"
    return _finish(d, sigs, silent, current)


def _finish(d: Decision, sigs, silent, current, keep: bool = False) -> Decision:
    """7. 교차 확인은 위에서 했다. 마지막으로 단위별 부가 규칙과 증거 정리를 한다."""
    if d.liveness == "superseded" and not d.successor:
        # 후속이 불명이면 removed 경로로 간다. 자동 확정은 없다
        d.liveness = "removed"
        d.auto = False
    if d.liveness == "removed" and not cross_checked(sigs):
        d.liveness, d.auto = (d.current or "alive"), False
        if not any(i.proposed == "removed" for i in d.queue):
            d.queue.append(Item("H01", "removed 후보. 단일 신호로 확정하지 않는다", "removed"))
    if keep:
        d.auto = False
    if d.liveness == "stale_suspect":
        for s in sigs:
            if s.id in ("M04", "M09"):
                break
    return d
