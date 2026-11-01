"""tick 내부 작업 진입점(sources/internal.d/harvest.yaml). 한 시간에 한 번, 실행당 상한 안에서만 돈다.

상주 프로세스, systemd 유닛, LLM 호출, 네트워크 호출이 없다. 실패는 tick을 막지 않고 경고로 남는다.
작업이 예외로 끝나면 tick은 만기 시각을 갱신하지 않아 다음 tick이 곧바로 다시 돌린다. 그래서 여기서 잡아
경고만 남기고 정상 종료한다(다음 시도는 한 시간 뒤).
"""
from __future__ import annotations


def run(ctx=None) -> dict:
    from kb.harvest import config, core
    stop = getattr(ctx, "expired", None)
    try:
        cfg = config.load()
        if not cfg.enabled:
            return {"skipped": "disabled"}
        rep = core.run(cfg, should_stop=stop if callable(stop) else None, samples=0)
    except Exception as e:  # noqa: BLE001 한 시간 뒤에 다시 시도한다
        msg = f"harvest: {type(e).__name__}: {e}"[:300]
        if ctx is not None and hasattr(ctx, "warnings"):
            ctx.warnings.append(msg)
        return {"error": msg}
    w = rep.get("writes") or {}
    warn = getattr(ctx, "warnings", None)
    if warn is not None:
        if w.get("errors"):
            warn.append("harvest: 쓰기 거부 " + ",".join(f"{k}={v}" for k, v in sorted(w["errors"].items())))
        if w.get("secret_hits"):
            warn.append(f"harvest: put_record가 비밀을 격리한 기록 {w['secret_hits']}건(사전 탐지 누락, 확인 필요)")
        if (rep.get("urls") or {}).get("aborted"):
            warn.append("harvest: 티켓 이력을 읽지 못해 이번 실행은 URL을 올리지 않았다")
    return {k: rep.get(k) for k in ("mode", "candidates", "actions", "deferred", "new_events", "skipped", "tickets", "stopped_early",
                                    "skipped_secret_rules") if k in rep}
