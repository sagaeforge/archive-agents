"""kb tick 틀(ADR 10.2). 0단계 preflight와 단계 자동 탐색을 맡는다. 1~8단계의 실제 일은 각 패키지의
src/kb/<패키지>/tick_stage*.py가 STAGES = [(순번, 이름, run)]으로 낸다. 없는 단계는 absent로 표시한다.
단계 실패는 다음 단계를 막지 않는다. 경로 오류만 전체를 멈춘다."""
from __future__ import annotations

import importlib
import os
import pkgutil
import shutil
import traceback
from dataclasses import dataclass, field

from kb.collect import clock, internal
from kb.collect.state import State
from kb.core import ledger, opsdb, paths
from kb.core.gatelock import Gate

MIN_FREE_BYTES = 50 * 1024 ** 3
MIN_FREE_FRAC = 0.10
DEFAULT_MAX_RUNTIME_S = 12 * 60
TICK_LOCK_WAIT_S = 0.5     # 겹친 tick은 재시도 없이 바로 끝난다. 대기 스레드가 빈 잠금을 얻을 시간만 준다
# 2.3 tick 단계 등록표. 모듈이 없으면 absent, 임포트가 깨지면 failed
EXPECTED = [
    (1, "recover", "kb.write.tick_stage"),
    (2, "registry", "kb.parse.tick_stage_registry"),
    (3, "fetch", "kb.collect.tick_stage"),
    (4, "parse", "kb.parse.tick_stage"),
    (4.5, "gate_l1", "kb.gate.tick_stage"),
    (5, "confirm", "kb.extract.tick_stage"),
    (6.1, "seal", "kb.guard.tick_stage_ship"),
    (6.2, "publish", "kb.publish.tick_stage"),
    (6.3, "live", "kb.live.tick_stage"),
    (6.4, "vector", "kb.rank.tick_stage"),
    (6.5, "checkpoint", "kb.guard.tick_stage_watch"),
    (7, "ship", "kb.guard.tick_stage_ship"),
    (8, "watchdog", "kb.guard.tick_stage_watch"),
]
COUNTER_KEYS = ("sources", "failed_sources", "robots_denied", "parsed", "pages_fetched", "pages_queued", "pages_capped", "gaps")


class TickFatal(Exception):
    """경로 오류. tick 전체를 멈춘다."""


@dataclass
class TickCtx:
    at: int
    deadline: float | None = None
    until_idle: bool = False
    only: str | None = None
    batch: list | None = None
    batch_caps: dict = field(default_factory=dict)    # 소스 id -> --batch 항목의 max_pages
    paused: bool = False
    discoverers: dict | None = None
    counters: dict = field(default_factory=lambda: {k: 0 for k in COUNTER_KEYS})
    warnings: list = field(default_factory=list)
    errors: list = field(default_factory=list)

    def expired(self) -> bool:
        return self.deadline is not None and clock.mono() >= self.deadline


def parse_duration(s: str | float | int | None) -> float | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip().lower()
    mult = {"s": 1, "m": 60, "h": 3600}
    if s and s[-1] in mult:
        return float(s[:-1]) * mult[s[-1]]
    return float(s)


def discover_stages() -> tuple[dict, dict]:
    """(순번, 이름) -> run, (순번, 이름) -> 임포트 실패 사유. kb 아래 모든 패키지의 tick_stage* 모듈을 훑는다."""
    import kb
    found: dict = {}
    failed: dict = {}
    mods: list[str] = []
    for m in pkgutil.iter_modules(kb.__path__):
        if not m.ispkg:
            continue
        try:
            pkg = importlib.import_module(f"kb.{m.name}")
        except Exception as e:  # noqa: BLE001 옆 패키지가 쓰는 중인 깨진 패키지
            for n, name, mod in EXPECTED:
                if mod.startswith(f"kb.{m.name}."):
                    failed[(n, name)] = f"{type(e).__name__}: {e}"
            continue
        for sm in pkgutil.iter_modules(getattr(pkg, "__path__", [])):
            if sm.name.startswith("tick_stage"):
                mods.append(f"kb.{m.name}.{sm.name}")
    for modname in sorted(mods):
        try:
            stages = importlib.import_module(modname).STAGES
            for n, name, run in stages:
                found[(n, name)] = run
        except Exception as e:  # noqa: BLE001
            hit = False
            for n, name, mod in EXPECTED:
                if mod == modname:
                    failed[(n, name)] = f"{type(e).__name__}: {e}"
                    hit = True
            if not hit:
                failed[(99, modname)] = f"{type(e).__name__}: {e}"
    return found, failed


def _check_paths() -> None:
    try:
        paths.check_fs(paths.kb_home())
        paths.check_fs(paths.ops_dir().parent)
        paths.ops_dir().mkdir(parents=True, exist_ok=True)
        paths.check_fs(paths.ops_dir())
    except Exception as e:  # noqa: BLE001
        raise TickFatal(f"경로 오류: {type(e).__name__}: {e}") from e


def _preflight(ctx: TickCtx) -> dict:
    """0단계. 디스크, 투영 정지 검사. 잠금은 호출자가 쥔다. 경로 검사는 잠금 전에 끝났다."""
    out: dict = {}
    try:
        du = shutil.disk_usage(paths.kb_home())
        if du.free < MIN_FREE_BYTES or du.free / du.total < MIN_FREE_FRAC:
            ctx.paused = True
            ctx.warnings.append(f"디스크 여유 부족({du.free // 1024 ** 3} GB): 수집 중지, 쓰기 유지")
    except OSError as e:
        raise TickFatal(f"디스크 확인 실패: {e}") from e
    out["rebuilt"] = _guard_projection(ctx)
    return out


def _guard_projection(ctx: TickCtx) -> bool:
    """gold가 원장 머리보다 앞서면(원장만 되돌린 상태) 투영을 멈추고 재구축한다."""
    from kb.project import current_gold_path, open_gold, rebuild
    from kb.project.db import meta_get
    p = current_gold_path()
    if p is None:
        return False
    led = ledger.open_ledger()
    try:
        head = ledger.head(led)[0]
    finally:
        led.close()
    g = open_gold(p)
    try:
        applied = int(meta_get(g, "applied_seq") or 0)
    finally:
        g.close()
    if applied <= head:
        return False
    ctx.warnings.append(f"gold가 원장보다 앞섬(applied_seq={applied} > head={head}): 투영 정지, 재구축")
    # 앞선 gold를 current에서 뗀다. 그대로 두면 rebuild가 옛 gold와 applied_seq를 대조하다 멈춘다.
    # 옛 빌드 폴더는 지우지 않는다(rebuild가 오래된 것부터 정리한다)
    from kb.core.gatelock import Gate
    from kb.project import gate_path
    from kb.project.build import current_link
    gate = Gate(gate_path())
    fd = gate.acquire(60.0)
    try:
        try:
            os.unlink(current_link())
        except FileNotFoundError:
            pass
    finally:
        gate.release(fd)
    rebuild()
    return True


def _run_stages(ctx: TickCtx, report: dict, st: State) -> bool:
    found, failed = discover_stages()
    names: dict = {}
    order = sorted(set(found) | set(failed) | {(n, name) for n, name, _ in EXPECTED}, key=lambda k: (float(k[0]), k[1]))
    any_failed = False
    for key in order:
        n, name = key
        if key in failed:
            names[name] = "failed"
            ctx.errors.append(f"{name}: 임포트 실패: {failed[key]}"[:300])
            any_failed = True
            continue
        run = found.get(key)
        if run is None:
            names[name] = "absent"
            continue
        try:
            r = run(ctx)
        except Exception as e:  # noqa: BLE001 단계 실패가 다음 단계를 막지 않는다
            names[name] = "failed"
            ctx.errors.append(f"{name}: {type(e).__name__}: {e}"[:300])
            traceback.print_exc()
            any_failed = True
            continue
        ok = getattr(r, "ok", True)
        names[name] = "ok" if ok else "failed"
        if not ok:
            any_failed = True
            ctx.errors += [f"{name}: {x}" for x in (getattr(r, "errors", None) or [])] or [f"{name}: failed"]
        detail = getattr(r, "detail", None) or {}
        v = detail.get("parsed")
        if isinstance(v, int) and not isinstance(v, bool):
            ctx.counters["parsed"] += v
        jobs, warns = internal.run_due(float(n), ctx, st)
        ctx.warnings += warns
    report["stages"] = names
    return any_failed


def run_tick(*, until_idle: bool = False, max_runtime: str | float | None = None, only: str | None = None,
             batch: list | None = None, batch_caps: dict | None = None) -> tuple[dict, int]:
    """(보고, 종료 코드). 종료 코드: 0 정상, 1 단계 실패 있음, 3 경로 오류."""
    mr = parse_duration(max_runtime) if max_runtime is not None else DEFAULT_MAX_RUNTIME_S
    ctx = TickCtx(at=clock.now_ms(), deadline=clock.mono() + mr, until_idle=until_idle, only=only, batch=batch,
                   batch_caps=dict(batch_caps or {}))
    report: dict = {"at": ctx.at}
    try:
        _check_paths()
    except TickFatal as e:
        return {"error": "E_PATH", "message": str(e), **_empty(report)}, 3
    try:
        lock = Gate(paths.ops_dir() / "tick.lock")
        fd = lock.acquire(TICK_LOCK_WAIT_S)
    except TimeoutError:
        return {**_empty(report), "skipped": "locked"}, 0
    except OSError as e:
        return {"error": "E_PATH", "message": str(e), **_empty(report)}, 3
    try:
        opsdb.tick_state_set("last_tick_at", ctx.at)
        opsdb.tick_state_set("lock_pid", os.getpid())
        opsdb.tick_state_set("lock_since", ctx.at)
        try:
            pre = _preflight(ctx)
        except TickFatal as e:
            return {"error": "E_PATH", "message": str(e), **_empty(report)}, 3
        report["rebuilt"] = pre["rebuilt"]
        failed = False
        with State() as st:
            for _round in range(1000):
                before = dict(ctx.counters)
                failed |= _run_stages(ctx, report, st)
                moved = any(ctx.counters[k] != before[k] for k in ("sources", "pages_fetched", "pages_queued"))
                if not until_idle or ctx.expired() or not moved:
                    break
        report.update(ctx.counters)
        report["collect_paused"] = ctx.paused
        if ctx.warnings:
            report["warnings"] = ctx.warnings[:50]
        if ctx.errors:
            report["errors"] = ctx.errors[:50]
        opsdb.tick_state_set("last_tick_done_at", clock.now_ms())
        return report, 1 if failed else 0
    finally:
        try:
            opsdb.tick_state_set("lock_pid", "")
        except Exception:  # noqa: BLE001
            pass
        lock.release(fd)


def _empty(report: dict) -> dict:
    return {**report, **{k: 0 for k in COUNTER_KEYS}, "stages": {}}
