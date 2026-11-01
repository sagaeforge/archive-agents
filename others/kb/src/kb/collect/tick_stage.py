"""tick 3단계 fetch(ADR 10.2, 10.4). 만기 소스를 capture로 받고, 색인에서 하위 URL을 뽑아 page 큐로 돌린다.
LLM 비용 0. 단계가 중간에 죽어도 다음 tick이 이어 간다(큐 임대는 시작할 때 되돌린다)."""
from __future__ import annotations

import re
from urllib.parse import urldefrag

from kb.collect import cadence, capturer as cap, clock, registry
from kb.collect.discover import load_discoverers
from kb.collect.state import State
from kb.collect.stage import StageResult
from kb.core import cas

PAGE_BATCH = 20
FAIL_OUTCOMES = ("error", "rejected", "blocked", "broken", "gone", "suspect")
DEFER_MS = {"host_denied": 86400_000, "policy_skip": 86400_000, "budget_exceeded": 3600_000}


def _prio(src) -> int:
    d = (src.domain or ["G"])[0]
    return 1 if d == "G" else 0


def _patterns(v) -> list:
    return [re.compile(x) for x in ([v] if isinstance(v, str) else (v or []))]


def _enqueue(st: State, src, urls: list[str], now: int, force: bool, counters: dict) -> None:
    for u in urls:
        row = st.get(src.id, u)
        if not force and row and row.get("next_check_at") and row["next_check_at"] > now:
            continue
        if row is None:
            st.put(src.id, u, state="new", discovered_from=src.index_url if src.discover else None)
        if st.page_put(f"{src.id}|{u}", (src.domain or [None])[0], _prio(src)):
            counters["pages_queued"] += 1


def _discover(st: State, src, ref, ctx, now: int, force: bool, counters: dict, warns: list) -> None:
    """색인 본문에서 하위 URL을 뽑아 url_state를 갱신하고 만기인 것을 page 큐에 넣는다."""
    disc = src.discover
    fn = ctx.discoverers.get(disc["kind"])
    if fn is None:
        return
    sha = ref.raw_sha if ref is not None and ref.raw_sha else (st.get(src.id) or {}).get("last_sha")
    if not sha:
        return
    try:
        body = cas.get(sha)
        cfg = dict(disc)
        cfg.setdefault("max_depth", registry.DEFAULT_MAX_DEPTH)
        found = list(fn(body, src.index_url, cfg))
    except Exception as e:  # noqa: BLE001 어댑터 오류가 다른 소스를 막지 않는다
        warns.append(f"discover {src.id}: {type(e).__name__}: {e}"[:300])
        return
    host = registry.host_of(src.index_url)
    inc, exc = _patterns(disc.get("include")), _patterns(disc.get("exclude"))
    keep: list[str] = []
    seen: set[str] = set()
    for u in found:
        u = urldefrag(str(u))[0]
        if u in seen or u == src.index_url or registry.host_of(u) != host:
            continue
        if inc and not any(p.search(u) for p in inc):
            continue
        if any(p.search(u) for p in exc):
            continue
        seen.add(u)
        keep.append(u)
    mx = int((getattr(ctx, "batch_caps", None) or {}).get(src.id) or disc["max_pages"])
    capped = max(0, len(keep) - mx)
    counters["pages_capped"] += capped          # 조용한 절단 금지: 넘긴 URL은 센다
    keep = keep[:mx]
    live = set(keep)
    for r in st.list_urls(src.id):
        if r["url"] not in live and r["state"] != "unlisted" and r["discovered_from"] == src.index_url:
            st.put(src.id, r["url"], state="unlisted")      # 지우지 않는다
        elif r["url"] in live and r["state"] == "unlisted":
            st.put(src.id, r["url"], state="ok" if r["last_sha"] else "new")
    _enqueue(st, src, keep, now, force, counters)


def _plan(srcs: list, st: State, ctx, now: int) -> list:
    """만기 목록. 시점 소실 > 늦은 순."""
    if ctx.only:
        srcs = [s for s in srcs if s.id == ctx.only]
    if ctx.batch is not None:
        by = {s.id: s for s in srcs}
        out = []
        for i in ctx.batch:
            s = by.get(i)
            if s is None or not registry.runnable(s)[0]:      # 결정 관문은 batch에도 켜 둔다
                continue
            out.append(s)
        return out
    rows = []
    for s in srcs:
        ok, _ = registry.runnable(s)
        if not ok:
            continue
        u = st.get(s.id) if s.fetch.get("url") else None
        nxt = (u or {}).get("next_check_at")
        has_static = bool(s.static_urls())
        if s.fetch.get("url") and (u is None or nxt is None or nxt <= now):
            late = now - (nxt if nxt else 0) if u else 10 ** 12
            lossy = bool(u and nxt and not cadence.retroactive(s) and now - nxt > cadence.interval_ms(s))
            rows.append((0 if lossy else 1, -late, s.id, s))
        elif has_static or s.discover:       # 색인은 아직 만기가 아니어도 하위 URL이 만기일 수 있다
            rows.append((2, 0, s.id, s))
    rows.sort(key=lambda r: r[:3])
    return [r[3] for r in rows]


def _gap(st: State, src, unit: dict, now: int) -> bool:
    """시점 소실 클래스가 놓친 구간을 gap.recorded 한 건으로 남긴다. 놓친 슬롯만큼 돌리지 않는다."""
    nxt = unit.get("next_check_at")
    if not nxt or cadence.retroactive(src) or now - nxt <= cadence.interval_ms(src):
        return False
    from kb.write import commit
    commit([{"kind": "gap.recorded", "actor": cap.ACTOR, "origin": "system", "idem_key": f"gap:{src.id}:{nxt}",
             "subject": src.id,
             "payload": {"source": src.id, "from_at": int(nxt), "to_at": int(now), "reason": "missed_slots"}}],
           cap.ACTOR, timeout=cap.COLLECTOR_TIMEOUT_S)
    return True


def run(ctx) -> StageResult:
    res = StageResult()
    c = ctx.counters
    if getattr(ctx, "paused", False):
        res.detail.update(paused=True)
        return res
    if ctx.discoverers is None:
        ctx.discoverers, w = load_discoverers()
        if w:
            ctx.warnings.append(w)
    now = clock.now_ms()
    srcs = registry.load_registry()
    force = (ctx.only is not None or ctx.batch is not None) and not getattr(ctx, "force_spent", False)
    per_src: dict[str, int] = {}
    by_id = {s.id: s for s in srcs}
    touched = 0
    with State() as st:
        st.page_reclaim()       # tick.lock을 쥐었으므로 앞 tick의 임대는 주인이 없다
        for src in _plan(srcs, st, ctx, now):
            if ctx.expired():
                break
            ref = None
            url = src.fetch.get("url")
            unit = st.get(src.id) if url else None
            due = force or unit is None or not unit.get("next_check_at") or unit["next_check_at"] <= now
            if url and due:
                if unit and not force and _gap(st, src, unit, now):
                    c["gaps"] += 1
                ref = cap.capture(src, url, state=st)
                c["sources"] += 1
                touched += 1
                if ref.outcome == "robots_denied":
                    c["robots_denied"] += 1
                elif ref.outcome in FAIL_OUTCOMES:
                    c["failed_sources"] += 1
                if ref.outcome in DEFER_MS or ref.outcome == "circuit_open":
                    st.put(src.id, None, next_check_at=ref.until or now + DEFER_MS.get(ref.outcome, 3600_000))
                if not ref.ok:
                    ref = None          # 받지 못했거나 형식이 깨졌으면 직전 정상 색인으로 하위 URL을 잇는다
            if src.discover and (ref is not None or unit is not None):
                _discover(st, src, ref, ctx, now, force, c, ctx.warnings)
            statics = [u for u, _ in src.static_urls()]
            if statics:
                queued0 = c["pages_queued"]
                _enqueue(st, src, statics, now, force, c)
                if not url and c["pages_queued"] > queued0:      # 이번에 만기인 URL이 있을 때만 소스로 센다
                    c["sources"] += 1
                    touched += 1
        ctx.force_spent = True  # --until-idle 다음 회차는 만기만 본다. 본문이 매번 다른 URL이 회차마다 스냅샷을 만들지 않게 한다
        _drain(st, by_id, ctx, per_src)
        st.page_reclaim()       # 소스별 상한 때문에 남긴 것은 다음 tick이 잇는다
    res.detail.update(touched=touched, queue_left=0)
    return res


def _drain(st: State, by_id: dict, ctx, per_src: dict) -> None:
    c = ctx.counters
    while not ctx.expired():
        items = st.page_take(PAGE_BATCH)
        if not items:
            break
        progressed = False
        for it in items:
            if ctx.expired():
                break
            sid, _, url = it["ref"].partition("|")
            src = by_id.get(sid)
            if src is None:
                st.page_done(it["ref"])
                continue
            cap_n = int(src.fetch.get("max_pages_per_tick") or registry.DEFAULT_MAX_PAGES_PER_TICK)
            bc = (getattr(ctx, "batch_caps", None) or {}).get(sid)
            if bc:
                cap_n = max(cap_n, int(bc))
            if per_src.get(sid, 0) >= cap_n:
                continue        # 임대 상태로 두었다가 단계 끝에 되돌린다
            per_src[sid] = per_src.get(sid, 0) + 1
            progressed = True
            ref = cap.capture(src, url, state=st, discovered_from=src.index_url if src.discover else None)
            now = clock.now_ms()
            if ref.ok:
                c["pages_fetched"] += 1
            elif ref.outcome == "robots_denied":
                c["robots_denied"] += 1
            if ref.outcome in DEFER_MS:
                st.put(sid, url, next_check_at=now + DEFER_MS[ref.outcome])
                if ref.outcome == "budget_exceeded":
                    per_src[sid] = cap_n        # 같은 소스의 나머지는 이번 tick에 시도하지 않는다
            elif ref.outcome == "circuit_open":
                st.put(sid, url, next_check_at=ref.until)
            st.page_done(it["ref"])
        if not progressed:
            break


STAGES = [(3, "fetch", run)]
