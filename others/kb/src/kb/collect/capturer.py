"""capture(source, url): 공용 수집 층. 거부 호스트, 정책, 서킷, 예산, 호스트 간격, robots를 걸고
조건부 GET -> 원본 CAS -> snapshot.captured 이벤트까지 한다. tick, kb fetch, kb_fetch, 묶음이 전부 여기를 지난다.

미변경 재수집은 fetch_log에만 남긴다. 바이트가 fsync되기 전에 이벤트를 쓰지 않는다(cas.put 뒤 commit)."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from kb.collect import cadence, clock, hostpolicy, registry, robots
from kb.collect.errors import Blocked, FetchError, HostDenied, PolicyError
from kb.collect.fetch import safe_fetch
from kb.collect.state import State
from kb.core import cas, config, ids, paths
from kb.core.gatelock import Gate

ATTEMPTS = 3
RETRY_SLEEP_CAP_S = 5.0
HOST_LOCK_WAIT_S = 180.0
COLLECTOR_TIMEOUT_S = 60.0
GONE_SLOT_MS = 6 * 3600 * 1000      # 404는 서로 다른 6시간 창에서 3회 본 뒤에만 gone
GONE_NEED = 3
BOT_MARKERS = ("sign in to confirm you're not a bot", "sign in to confirm you’re not a bot",
               "unusual traffic from your computer network", "attention required! | cloudflare",
               "verify you are human", "checking your browser before accessing")
POLICY_OUTCOMES = ("host_denied", "policy_skip", "robots_denied", "circuit_open", "budget_exceeded")
ACTOR = "collector"
_adhoc_done = False


@dataclass
class SnapshotRef:
    source: str
    url: str
    outcome: str
    status: int | None = None
    snapshot: str | None = None
    new: bool = False
    raw_sha: str | None = None
    bytes: int | None = None
    content_type: str | None = None
    chain: list = field(default_factory=list)
    error: str | None = None
    until: int | None = None
    retry_after: float | None = None

    @property
    def ok(self) -> bool:
        return self.outcome in ("captured", "not_modified", "reused")

    @property
    def code(self) -> str | None:
        if self.outcome in POLICY_OUTCOMES:
            return "E_POLICY"
        return None if self.ok else "E_FETCH"

    def as_dict(self) -> dict:
        return {"source": self.source, "url": self.url, "outcome": self.outcome, "status": self.status,
                "snapshot": self.snapshot, "new": self.new, "raw_sha": self.raw_sha, "bytes": self.bytes,
                "content_type": self.content_type, "chain": [list(c) for c in self.chain], "error": self.error,
                "code": self.code}


def _host_lock(host: str) -> Gate:
    return Gate(paths.ops_dir() / f"host-{hashlib.sha1(host.encode()).hexdigest()[:12]}.lock")


def _wait_interval(st: State, host: str, src) -> None:
    gap = hostpolicy.interval_for(host)
    if src is not None and src.policy.get("min_interval_s") is not None:
        gap = max(gap, float(src.policy["min_interval_s"]))
    last = st.last_network_at(host)
    if last is not None:
        clock.sleep(gap - (clock.now_ms() - last) / 1000.0)


def ensure_adhoc_registered() -> None:
    global _adhoc_done
    if _adhoc_done:
        return
    from kb.write import commit
    commit([{"kind": "source.registered", "actor": ACTOR, "origin": "system", "idem_key": "source:src:adhoc:v1",
             "subject": registry.ADHOC_ID,
             "payload": {"id": registry.ADHOC_ID, "label": "ad hoc", "props": {"tos": "unverified", "trust": "unknown"}}}],
           ACTOR, timeout=COLLECTOR_TIMEOUT_S)
    _adhoc_done = True


def _unit_url(src, url: str) -> str | None:
    """source_state는 색인 또는 단일 url의 상태만 갖는다. 나머지는 url_state."""
    return None if (src.id != registry.ADHOC_ID and url == src.fetch.get("url")) else url


def _bot_page(f, body: bytes) -> bool:
    ct = (f.headers.get("content-type") or "").lower()
    if ct and not any(t in ct for t in ("html", "text", "json", "xml")):
        return False
    head = body[:65536].decode("utf-8", "ignore").lower()
    if not any(m in head for m in BOT_MARKERS):
        return False
    if f.status in (403, 429, 503) or len(body) < 50_000:
        return True
    t = head.find("<title>")
    return t >= 0 and any(m in head[t:t + 300] for m in BOT_MARKERS)


def _expect_violation(src, f) -> str | None:
    ex = src.expect or {}
    ct = (f.content_type or "").split(";")[0].strip().lower()
    want = ex.get("content_type")
    if want:
        wants = [want] if isinstance(want, str) else list(want)
        if ct and not any(ct == w.lower() or ct.startswith(w.lower().rstrip("*")) for w in wants):
            return f"content_type:{ct}!={'|'.join(wants)}"
        if not ct:
            return "content_type:missing"
    elif ct in ("text/html", "application/xhtml+xml") and src.parser and any(
            k in src.parser for k in ("feed", "atom", "rss", "json", "changelog")):
        return f"content_type:{ct}:html_for_{src.parser}"
    if ex.get("min_bytes") and len(f.body) < int(ex["min_bytes"]):
        return f"min_bytes:{len(f.body)}<{ex['min_bytes']}"
    if ex.get("max_bytes") and len(f.body) > int(ex["max_bytes"]):
        return f"max_bytes:{len(f.body)}>{ex['max_bytes']}"
    sw = ex.get("starts_with")
    if sw and not f.body.lstrip()[:len(sw.encode())].lower().startswith(sw.lower().encode()):
        return f"starts_with:{sw}"
    return None


class _RobotsUnavailable(Exception):
    pass


def _robots_allows(st: State, src, url: str, host: str) -> tuple[bool, str | None]:
    """(허용 여부, 이유). robots.txt를 받지 못하면 _RobotsUnavailable."""
    u = urlsplit(url)
    origin = f"https://{host}" + (f":{u.port}" if u.port and u.port != 443 else "")
    row = st.robots_get(host)
    if row and clock.now_ms() - row[0] < robots.TTL_MS:
        status, body = row[1], row[2]
    else:
        _wait_interval(st, host, src)
        try:
            f = safe_fetch(origin + "/robots.txt", source=src, max_bytes=robots.MAX_PARSE * 2,
                           allow_ports=_ports(src))
        except Blocked:
            raise     # 거부 호스트와 규칙 위반은 본 요청과 같은 처리
        except FetchError as e:
            st.log(src.id, host, origin + "/robots.txt", "robots_fetch", None, None, None)
            raise _RobotsUnavailable(str(e)) from e
        st.log(src.id, host, origin + "/robots.txt", "robots_fetch", f.status, f.bytes, f.ms)
        if f.status == 429:
            st.trip(host, "robots_429")
            raise _RobotsUnavailable("429")
        if f.status >= 500:
            raise _RobotsUnavailable(str(f.status))
        status = f.status
        body = f.body.decode("utf-8", "replace") if 200 <= f.status < 300 else ""
        st.robots_put(host, status, body)
    if status is not None and 200 <= status < 300:
        return robots.Robots.parse(body).allowed(robots.path_query(url)), "robots_txt"
    return True, f"robots_status_{status}"      # 4xx: robots.txt 없음. 전부 허용(RFC 9309 2.3.1.3)


def _ports(src) -> tuple:
    return tuple(src.fetch.get("allow_ports") or ()) if src is not None else ()


def _resolve(source) -> registry.Source:
    if isinstance(source, registry.Source):
        return source
    s = registry.get_source(str(source))
    if s is None:
        raise PolicyError(f"unknown_source:{source}")
    return s


def capture(source, url: str, *, conditional: bool = True, reuse_s: float | None = None,
            discovered_from: str | None = None, state: State | None = None) -> SnapshotRef:
    """한 URL을 받아 스냅샷을 만든다. 정책으로 막히면 예외 대신 outcome이 POLICY_OUTCOMES 중 하나인 결과를 돌려준다."""
    src = _resolve(source)
    own = state is None
    st = state or State()
    try:
        return _capture(st, src, url, conditional, reuse_s, discovered_from)
    finally:
        if own:
            st.close()


def _capture(st: State, src, url: str, conditional: bool, reuse_s, discovered_from) -> SnapshotRef:
    ref = SnapshotRef(source=src.id, url=url, outcome="error")
    try:
        u = urlsplit(url)
        host = (u.hostname or "").lower()
    except ValueError:
        host = ""
    logh = host or "-"

    def done(outcome, status=None, error=None, **kw):
        ref.outcome, ref.status, ref.error = outcome, status, error
        for k, v in kw.items():
            setattr(ref, k, v)
        return ref

    # 1) 호스트 정책, 소스 정책. 네트워크 0회
    reason = hostpolicy.denied_reason(host) if host else None
    if reason:
        st.log(src.id, logh, url, "host_denied")
        return done("host_denied", error=reason)
    ok, why = registry.runnable(src)
    if not ok:
        st.log(src.id, logh, url, "policy_skip")
        return done("policy_skip", error=why)
    if src.id != registry.ADHOC_ID:
        ud = src.url_decision(url)
        if ud is not None and not config.decision_ok(int(ud)):
            st.log(src.id, logh, url, "policy_skip")
            return done("policy_skip", error=f"decision_{ud}_pending")
        if not src.owns_url(url):
            st.log(src.id, logh, url, "policy_skip")
            return done("policy_skip", error="url_not_in_source")
    else:
        ensure_adhoc_registered()
    uu = _unit_url(src, url)
    row = st.get(src.id, uu)
    now = clock.now_ms()
    if reuse_s and row and row.get("last_ok_at") and row.get("last_sha") and now - row["last_ok_at"] < reuse_s * 1000:
        return done("reused", 200, snapshot=ids.snapshot_id(row["last_sha"], url), raw_sha=row["last_sha"])
    until = st.circuit_until(host) if host else None
    if until:
        st.log(src.id, logh, url, "circuit_open")
        return done("circuit_open", error="circuit_open", until=until)

    # 2) 호스트별 직렬. 예산, 간격, robots, GET
    try:
        gate = _host_lock(host)
        fd = gate.acquire(HOST_LOCK_WAIT_S)
    except TimeoutError:
        return done("error", error="host_lock_timeout")
    try:
        return _network(st, src, url, host, uu, row, conditional, discovered_from, done, ref)
    finally:
        gate.release(fd)


def _network(st: State, src, url, host, uu, row, conditional, discovered_from, done, ref) -> SnapshotRef:
    budget = hostpolicy.budgets().get(host)
    if budget is not None and st.hour_count(host) >= budget:
        st.log(src.id, host, url, "budget_exceeded")
        return done("budget_exceeded", error=f"hourly_budget:{budget}")
    u = urlsplit(url)
    simple = u.scheme == "https" and u.username is None and u.password is None
    try:
        if simple and src.policy.get("robots", "enforce") == "enforce":
            allowed, why = _robots_allows(st, src, url, host)
            if not allowed:
                st.log(src.id, host, url, "robots_denied")
                _unit_fail(st, src, uu, row, state="robots_denied", fail=False)
                return done("robots_denied", error=why)
        hdrs = {}
        if conditional and row and row.get("last_sha"):
            if row.get("etag"):
                hdrs["If-None-Match"] = row["etag"]
            if row.get("last_modified"):
                hdrs["If-Modified-Since"] = row["last_modified"]
        f = None
        last_err = None
        for attempt in range(ATTEMPTS):
            _wait_interval(st, host, src)
            try:
                f = safe_fetch(url, source=src, headers=hdrs, allow_ports=_ports(src))
            except HostDenied as e:
                st.log(src.id, e.host or host, url, "host_denied")
                return done("host_denied", error=str(e))
            except Blocked as e:
                st.log(src.id, host, url, "rejected")
                _unit_fail(st, src, uu, row, state="failed")
                return done("rejected", error=str(e))
            except FetchError as e:
                st.log(src.id, host, url, "error")
                last_err, f = str(e), None
                clock.sleep(min(RETRY_SLEEP_CAP_S, 0.5 * 2 ** attempt))
                continue
            if f.status >= 500 and attempt < ATTEMPTS - 1:
                st.log(src.id, host, url, "error", f.status, f.bytes, f.ms)
                clock.sleep(min(RETRY_SLEEP_CAP_S, f.retry_after if f.retry_after is not None else 0.5 * 2 ** attempt))
                continue
            break
    except HostDenied as e:
        st.log(src.id, host, url, "host_denied")
        return done("host_denied", error=str(e))
    except Blocked as e:
        st.log(src.id, host, url, "rejected")
        _unit_fail(st, src, uu, row, state="failed")
        return done("rejected", error=str(e))
    except _RobotsUnavailable as e:
        _unit_fail(st, src, uu, row, state="failed")
        return done("error", error=f"robots_unavailable:{e}")
    ref.chain = list(f.chain) if f else []
    if f is None:
        _unit_fail(st, src, uu, row, state="failed")
        return done("error", error=last_err)
    ref.chain = list(f.chain)
    if f.status in (429, 403) or (200 <= f.status < 300 and _bot_page(f, f.body)) or (f.status == 503 and _bot_page(f, f.body)):
        until = st.trip(host, f"status_{f.status}" if f.status in (429, 403) else "bot_check_body")
        st.log(src.id, host, url, "blocked", f.status, f.bytes, f.ms)
        _unit_fail(st, src, uu, row, state="blocked", retry_after=f.retry_after, floor=until)
        return done("blocked", f.status, error="circuit_opened", until=until)
    if f.status in (404, 410):
        return _gone(st, src, url, uu, row, f, done)
    if f.status == 304:
        sha = (row or {}).get("last_sha")
        _unit_ok(st, src, uu, row, sha, f, discovered_from)
        st.log(src.id, host, url, "not_modified", 304, 0, f.ms)
        return done("not_modified", 304, snapshot=ids.snapshot_id(sha, url) if sha else None, raw_sha=sha)
    if not 200 <= f.status < 300:
        st.log(src.id, host, url, "http_error", f.status, f.bytes, f.ms)
        _unit_fail(st, src, uu, row, state="failed", retry_after=f.retry_after)
        return done("error", f.status, error=f"http_{f.status}")
    return _store(st, src, url, host, uu, row, f, discovered_from, done)


def _store(st, src, url, host, uu, row, f, discovered_from, done) -> SnapshotRef:
    sha = hashlib.sha256(f.body).hexdigest()
    if row and row.get("last_sha") == sha:
        _unit_ok(st, src, uu, row, sha, f, discovered_from)
        st.log(src.id, host, url, "not_modified", f.status, f.bytes, f.ms)
        return done("not_modified", f.status, snapshot=ids.snapshot_id(sha, url), raw_sha=sha, bytes=f.bytes,
                    content_type=f.content_type)
    viol = _expect_violation(src, f)
    tier = "objects" if src.policy.get("retention", "permanent") == "permanent" else "ttl"
    cas.put(f.body, tier=tier)
    if viol:
        st.dlq_put("broken_source", f"{src.id}|{url}", "fetch", viol, sha)
        st.log(src.id, host, url, "expect_violation", f.status, f.bytes, f.ms)
        now = clock.now_ms()
        st.put(src.id, uu, state="broken", next_check_at=cadence.next_ok(src, now) if src.class_ else None,
               **({"shape": viol[:200]} if uu is None else {}))
        return done("broken", f.status, error=viol, raw_sha=sha, bytes=f.bytes, content_type=f.content_type)
    sid = ids.snapshot_id(sha, url)
    p = {"id": sid, "document_id": ids.document_id(url), "source": src.id, "url": url, "raw_sha": sha,
         "fetched_at": clock.now_ms(), "http_status": f.status, "bytes": f.bytes, "tier": tier}
    if f.content_type:
        p["content_type"] = f.content_type
    if f.etag:
        p["etag"] = f.etag
    if f.last_modified:
        p["last_modified"] = f.last_modified
    if src.domain:
        p["domain"] = list(src.domain)
    if len(f.chain) > 1:
        p["chain"] = [[c[0], c[1]] for c in f.chain]
    from kb.write import commit
    from kb.write.errors import IdemConflict as WIdem
    from kb.core.ledger import IdemConflict as LIdem
    try:
        commit([{"kind": "snapshot.captured", "actor": ACTOR, "origin": "external", "idem_key": f"snapshot:{sid}",
                 "subject": sid, "payload": p}], ACTOR, timeout=COLLECTOR_TIMEOUT_S)
    except (WIdem, LIdem):
        pass     # 같은 (raw_sha, url) 스냅샷이 이미 있다. 앞선 시도가 상태 갱신 전에 죽은 경우
    _unit_ok(st, src, uu, row, sha, f, discovered_from)
    st.log(src.id, host, url, "ok", f.status, f.bytes, f.ms)
    return done("captured", f.status, snapshot=sid, new=True, raw_sha=sha, bytes=f.bytes, content_type=f.content_type)


def _unit_ok(st, src, uu, row, sha, f, discovered_from) -> None:
    now = clock.now_ms()
    fields = dict(last_ok_at=now, fail_count=0, state="ok", last_sha=sha)
    if f.etag:
        fields["etag"] = f.etag
    if f.last_modified:
        fields["last_modified"] = f.last_modified
    if uu is not None and discovered_from:
        fields["discovered_from"] = discovered_from
    if src.id != registry.ADHOC_ID:
        fields["next_check_at"] = cadence.next_ok(src, now)
    st.put(src.id, uu, **fields)
    st.kv_set(f"gone:{src.id}|{uu or ''}", "[]")


def _unit_fail(st, src, uu, row, *, state, fail=True, retry_after=None, floor=None) -> None:
    now = clock.now_ms()
    n = ((row or {}).get("fail_count") or 0) + (1 if fail else 0)
    nxt = cadence.next_fail(now, max(n, 1), retry_after)
    if state == "robots_denied":
        nxt = cadence.next_ok(src, now)
    if floor:
        nxt = max(nxt, floor)
    if src.id == registry.ADHOC_ID:
        nxt = None
    st.put(src.id, uu, fail_count=n, state=state, next_check_at=nxt)


def _gone(st, src, url, uu, row, f, done) -> SnapshotRef:
    """404, 410은 단일 관측으로 판정하지 않는다. 서로 다른 6시간 창 3회 뒤에만 gone."""
    now = clock.now_ms()
    key = f"gone:{src.id}|{uu or ''}"
    slots = st.kv_json(key, []) or []
    slot = now // GONE_SLOT_MS
    if slot not in slots:
        slots.append(slot)
    st.kv_set(key, json.dumps(slots[-GONE_NEED:]))
    n = len(slots)
    gone = n >= GONE_NEED
    st.log(src.id, urlsplit(url).hostname or "-", url, "not_found", f.status, 0, f.ms)
    nxt = None if src.id == registry.ADHOC_ID else (now + 7 * 86400_000 if gone else (slot + 1) * GONE_SLOT_MS + 60_000)
    st.put(src.id, uu, fail_count=n, state="gone" if gone else "suspect", next_check_at=nxt)
    if gone and uu is None and src.id != registry.ADHOC_ID:
        from kb.write import commit
        commit([{"kind": "source.status", "actor": ACTOR, "origin": "system", "idem_key": f"gone:{src.id}:{slots[0]}",
                 "subject": src.id, "payload": {"id": src.id, "state": "gone", "reason": f"http_{f.status}_x{n}"}}],
               ACTOR, timeout=COLLECTOR_TIMEOUT_S)
    return done("gone" if gone else "suspect", f.status, error=f"http_{f.status}:{n}/{GONE_NEED}")
