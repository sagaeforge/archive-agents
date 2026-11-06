"""kb harvest: 세션이 배운 것을 기록으로 거둔다(결정적, LLM 없음, 네트워크 없음).

흐름: 원본 발견 -> 선별 추출 -> 비밀 탐지(걸리면 원본 통째로 건너뜀) -> 줄 정화 -> 사후 검증 -> 상태 대조(멱등) ->
      기록 쓰기(kb.write.put_record, transport=intake) -> URL 후보를 티켓으로(kb.ticket).

- 기록은 first_party 에이전트 기록이고 타입은 Learning이다. 원본 하나에 기록 하나, 내용이 바뀌면 같은 ID의 새 버전이다.
- 세션 서술은 claim, entity, edge 이벤트가 되지 않는다(ADR-0001 7.8). 외부 사실은 URL만 티켓으로 간다.
- 내용이 같으면 아무것도 쓰지 않는다. 사용자가 지운(tombstone, redact) 기록은 되살리지 않는다.
- 상한(config.py)은 한 번의 실행에 걸린다. 넘은 일은 다음 실행이 잇는다.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field

from kb.core import paths
from kb.harvest import filters, sources, state, tickets
from kb.harvest.config import Config
from kb.harvest.sources import Extracted, Source, SkipSource

TYPE = "Learning"
ID_SALT = "harvest:"
KEY_PREFIX = state.KEY_PREFIX
MAX_TITLE = 200
PROP_STR_MAX = 300


@dataclass
class Built:
    src: Source
    rid: str
    title: str
    body: str
    fmt: str
    props: dict
    sha: str
    removed: int
    truncated: bool
    urls: list[str]
    shas: int = 0                  # 12자리로 줄인 git SHA 값 수
    action: str = "new"            # new | changed | unchanged | removed_by_user
    deferred: str | None = None    # 이번 실행에서 못 쓴 이유: cap(쓰기 상한) | held(보관분 적재 대기) | deadline(시간 상한)
    known: state.Known | None = None

    @property
    def nbytes(self) -> int:
        return len(self.body.encode("utf-8"))

    def record(self) -> dict:
        return {"id": self.rid, "type": TYPE, "title": self.title, "body": self.body, "body_format": self.fmt,
                "sensitivity": "internal", "props": self.props}


@dataclass
class Skipped:
    src: Source
    reason: str
    rules: list[str] = field(default_factory=list)


def record_id(src: Source) -> str:
    from kb.write import record
    return record.derive_id(ID_SALT + src.key)


def _short(s: str, n: int) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


def content_sha(title: str, body: str) -> str:
    return hashlib.sha256((title + "\x00" + body).encode("utf-8")).hexdigest()


def _clean_props(sc, props: dict) -> dict:
    """문자열 props에 걸리는 줄 규칙을 그대로 건다. 걸리면 그 값만 뺀다."""
    out: dict = {}
    for k, v in props.items():
        if v is None or v == "":
            continue
        if isinstance(v, str):
            v = _short(v, PROP_STR_MAX)
            if sc.bad(v):
                continue
        out[k] = v
    return out


def build_one(src: Source, cfg: Config, sc: filters.HarvestScrubber, now: float | None = None) -> Built:
    """원본 하나를 저장할 기록으로. 저장하지 않을 이유가 있으면 sources.SkipSource 또는 SecretSkip."""
    sources.check_age(src, cfg, now)
    ex: Extracted = sources.extract(src, cfg)
    text, shas = filters.shorten_git_shas(filters.clean_text(ex.text))   # KEY=<40자리 SHA>는 줄여서 비밀 오탐을 피한다
    rules = filters.secret_rules(ex.title + "\n" + text)                # 줄 정화 전 원문에 건다
    if rules:
        raise SecretSkip(rules)
    body, removed = filters.scrub(sc, text)
    if len(body.strip()) < cfg.min_body_chars:
        raise SkipSource("empty")
    body, truncated = filters.clip(body, cfg.max_body_bytes)
    title = _short(filters.clean_text(ex.title), MAX_TITLE)
    if not title or sc.bad(title):
        title = f"({src.kind}) 제목 제거됨"
    rid = record_id(src)
    sha = content_sha(title, body)
    props = {"source_kind": src.kind, "project": src.project, "source_path": sources.display_path(src.path),
             "session": ex.session, "source_date": ex.date, "content_sha": sha, "scrubbed_lines": removed,
             "tags": ["harvest", src.kind]}
    if truncated:
        props["truncated"] = True
    props.update({k: v for k, v in ex.props.items() if k not in props})
    props = _clean_props(sc, props)
    # 사후 검증: 같은 규칙을 저장될 글 전체에 다시 건다. 여기서 걸리면 코드 결함이다
    check = title + "\n" + body + "\n" + json.dumps(props, ensure_ascii=False, sort_keys=True)
    if filters.audit_total(sc.audit(check)):
        raise SkipSource("postcheck")
    rules = filters.secret_rules(check)
    if rules:
        raise SecretSkip(rules)
    from kb.intake import urls as _urls
    found = list(dict.fromkeys(_urls.extract(body)))
    return Built(src, rid, title, body, ex.fmt, props, sha, removed, truncated, found, shas)


class SecretSkip(SkipSource):
    """비밀이 탐지돼 원본을 통째로 저장하지 않는다. 값은 어디에도 남기지 않고 규칙 ID만 센다."""

    def __init__(self, rules: list[str]):
        super().__init__("secret")
        self.rules = rules


@dataclass
class Collected:
    built: list[Built] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)
    discovery: dict = field(default_factory=dict)
    sources: int = 0


def collect(cfg: Config, sc: filters.HarvestScrubber, now: float | None = None) -> Collected:
    srcs, disc = sources.discover(cfg)
    col = Collected(discovery=disc)
    if len(srcs) > cfg.max_sources:
        disc["capped_sources"] = len(srcs) - cfg.max_sources
        srcs = srcs[:cfg.max_sources]
    col.sources = len(srcs)
    for s in srcs:
        try:
            col.built.append(build_one(s, cfg, sc, now))
        except SecretSkip as e:
            col.skipped.append(Skipped(s, "secret", e.rules))
        except SkipSource as e:
            col.skipped.append(Skipped(s, e.reason))
    return col


# ------------------------------------------------------------------ 상태 대조와 계획

def classify(built: list[Built], snap: state.Snapshot) -> None:
    for b in built:
        k = snap.known.get(b.rid) or state.Known()
        b.known = k
        if not k.live:
            b.action = "removed_by_user"
        elif k.held:
            if k.held_sha == b.sha:
                b.action = "unchanged"
            else:
                b.action = "changed"
                if snap.fp_open:
                    b.deferred = "held"         # 열린 뒤에는 tick의 recover가 보관분을 먼저 적재한다
        elif k.version:
            b.action = "unchanged" if k.sha == b.sha else "changed"
        else:
            b.action = "new"


def next_version(b: Built) -> int:
    k = b.known or state.Known()
    return k.version + k.held + 1


def idem_key(b: Built) -> str:
    """버전 번호를 넣어 A -> B -> A 로 되돌아간 내용도 새 버전으로 남는다. 같은 입력의 재시도는 같은 키다."""
    return f"{KEY_PREFIX}{b.rid}:v{next_version(b)}:{b.sha[:16]}"


def apply_caps(built: list[Built], cfg: Config) -> dict:
    """쓸 일(new, changed)에 쓰기 상한을 건다. 넘은 일은 deferred="cap"으로 남기고 다음 실행이 잇는다."""
    n = size = 0
    deferred = 0
    for b in built:
        if b.action not in ("new", "changed") or b.deferred:
            continue
        if n >= cfg.max_writes or (n and size + b.nbytes > cfg.max_write_bytes):
            b.deferred = "cap"
            deferred += 1
            continue
        n += 1
        size += b.nbytes
    return {"writes": n, "bytes": size, "deferred_cap": deferred}


# ------------------------------------------------------------------ 보고

def _project_stats(col: Collected) -> dict:
    out: dict = {}

    def p(name):
        return out.setdefault(name, {"sources": 0, "candidates": 0, "skipped_secret": 0, "skipped_other": 0,
                                     "lines_removed": 0, "urls_found": 0, "new": 0, "changed": 0, "unchanged": 0,
                                     "deferred": 0})
    for b in col.built:
        s = p(b.src.project)
        s["sources"] += 1
        s["candidates"] += 1
        s["lines_removed"] += b.removed
        s["urls_found"] += len(b.urls)
        if b.action in ("new", "changed", "unchanged"):
            s[b.action] += 1
        if b.deferred:
            s["deferred"] += 1
    for k in col.skipped:
        s = p(k.src.project)
        s["sources"] += 1
        s["skipped_secret" if k.reason == "secret" else "skipped_other"] += 1
    return dict(sorted(out.items()))


def _verify(col: Collected, sc: filters.HarvestScrubber) -> dict:
    """저장하려는 모든 기록에 차단 목록, 내부 주소, 확장 규칙, 비밀 탐지를 한 번 더 건다(건수만)."""
    d = a = e = x = s = 0
    for b in col.built:
        text = b.title + "\n" + b.body + "\n" + json.dumps(b.props, ensure_ascii=False, sort_keys=True)
        r = sc.audit(text)
        d, a, e, x = d + r["deny"], a + r["internal_addr"], e + r["email"], x + r["extra"]
        s += 1 if filters.secret_rules(text) else 0
    return {"records": len(col.built), "deny_hits": d, "internal_addr_hits": a, "email_hits": e, "extra_hits": x,
            "secret_hits": s}


def _report(cfg: Config, col: Collected, sc, *, mode: str, plan: dict, writes: dict, urls: tickets.UrlStats | None,
            samples: int, stopped: bool) -> dict:
    skipped: dict = {}
    rules: dict = {}
    for k in col.skipped:
        skipped[k.reason] = skipped.get(k.reason, 0) + 1
        for r in k.rules:
            rules[r] = rules.get(r, 0) + 1
    actions: dict = {}
    deferred: dict = {}
    by_kind: dict = {}
    for b in col.built:
        actions[b.action] = actions.get(b.action, 0) + 1
        by_kind[b.src.kind] = by_kind.get(b.src.kind, 0) + 1
        if b.deferred:
            deferred[b.deferred] = deferred.get(b.deferred, 0) + 1
    ordered = sorted(col.built, key=lambda b: (b.src.kind, b.src.project, b.title))
    pick = [ordered[i * len(ordered) // samples] for i in range(samples)] if ordered and samples else []
    return {
        "mode": mode,
        "sources": {"found": col.discovery.get("found", 0) - col.discovery.get("capped_sources", 0),
                    "excluded_projects": col.discovery.get("excluded_projects", 0),
                    "capped": col.discovery.get("capped_sources", 0), "by_kind_candidates": dict(sorted(by_kind.items()))},
        "candidates": len(col.built),
        "actions": dict(sorted(actions.items())),
        "deferred": dict(sorted(deferred.items())),
        "skipped": dict(sorted(skipped.items())),
        "skipped_secret_rules": dict(sorted(rules.items())),
        "lines_removed": sum(b.removed for b in col.built),
        "git_sha_values_shortened": sum(b.shas for b in col.built),
        "filters": {"deny_entries": sc.deny_entries, "deny_stems": sc.deny_stems},
        "urls": (urls.as_dict() if urls else {"extracted": sum(len(b.urls) for b in col.built)}),
        "tickets": urls.tickets if urls else 0,
        "writes": writes,
        "new_events": writes.get("events", 0) + (urls.new_events if urls else 0),
        "caps": {"max_writes": cfg.max_writes, "max_write_bytes": cfg.max_write_bytes,
                 "max_body_bytes": cfg.max_body_bytes, "max_urls": cfg.max_urls,
                 "max_urls_per_source": cfg.max_urls_per_source, "max_sources": cfg.max_sources},
        "verify": _verify(col, sc),
        "projects": _project_stats(col),
        "samples": [{"kind": b.src.kind, "project": b.src.project, "title": b.title, "action": b.action} for b in pick],
        "stopped_early": stopped,
        "plan": plan,
    }


# ------------------------------------------------------------------ 진입점

def _scrubber() -> tuple[filters.HarvestScrubber, list[str]]:
    from kb.intake import deny
    names = deny.load()                  # 없으면 IntakeError(E_DENY_MISSING). 차단 목록 없이는 돌지 않는다
    return filters.HarvestScrubber(names), names


def plan(cfg: Config, *, now: float | None = None, samples: int = 3, dump_dir: str | None = None) -> dict:
    """쓰기 없음(dry-run). 원장과 스풀은 읽기 전용으로만 연다."""
    sc, names = _scrubber()
    col = collect(cfg, sc, now)
    snap = state.lookup(b.rid for b in col.built)
    classify(col.built, snap)
    pl = apply_caps(col.built, cfg)
    urls = tickets.plan_urls(col.built, names, cfg, apply=False)
    if dump_dir:
        _dump(col, dump_dir)
    return _report(cfg, col, sc, mode="dry-run", plan=pl, writes={"events": 0, "stored": 0, "held": 0, "bytes": 0,
                                                                    "errors": {}}, urls=urls, samples=samples,
                   stopped=False)


def _ensure_ready() -> None:
    from kb.intake import core as ic
    ic._ensure_ready()


def run(cfg: Config, *, should_stop=None, samples: int = 3) -> dict:
    """기록과 티켓을 쓴다. 같은 내용을 다시 돌리면 쓰는 이벤트가 0이다."""
    from kb.core.gatelock import Gate
    from kb.write import put_record
    from kb.write.engine import project_pending
    from kb.write.errors import IdemConflict, VersionConflict, WriteRejected
    sc, names = _scrubber()
    lock = Gate(paths.ops_dir() / "harvest.lock")
    try:
        fd = lock.acquire(0.5)
    except TimeoutError:
        return {"mode": "run", "skipped": "locked", "new_events": 0}
    try:
        deadline = time.monotonic() + cfg.deadline_s

        def stop() -> bool:
            return time.monotonic() > deadline or bool(should_stop and should_stop())

        _ensure_ready()
        col = collect(cfg, sc)
        snap = state.lookup(b.rid for b in col.built)
        classify(col.built, snap)
        pl = apply_caps(col.built, cfg)
        w = {"events": 0, "stored": 0, "held": 0, "bytes": 0, "errors": {}, "secret_hits": 0}
        stopped = False
        for b in col.built:
            if b.action not in ("new", "changed") or b.deferred:
                continue
            if stop():
                stopped = True
                b.deferred = "deadline"
                continue
            rec = b.record()
            if b.known and b.known.version and not b.known.held:
                rec["expected_version"] = b.known.version
            try:
                res = put_record(rec, idem_key(b), "intake", session=cfg.session)
            except (WriteRejected, VersionConflict, IdemConflict) as e:
                code = getattr(e, "code", None) or type(e).__name__
                w["errors"][code] = w["errors"].get(code, 0) + 1
                continue
            if any(x.startswith("secret_detected") for x in res.warnings):
                w["secret_hits"] += 1
            if res.held:
                w["held"] += 1
                w["events"] += 1
            else:
                w["stored"] += 1
                w["events"] += sum(1 for e in res.events if not e["replayed"])
            w["bytes"] += b.nbytes
        project_pending()          # 티켓 판정은 gold가 원장 머리를 따라잡은 뒤에 읽는다
        urls = tickets.plan_urls(col.built, names, cfg, apply=True, should_stop=stop)
        project_pending()
        return _report(cfg, col, sc, mode="run", plan=pl, writes=w, urls=urls, samples=samples, stopped=stopped)
    finally:
        lock.release(fd)


def _dump(col: Collected, out_dir: str) -> None:
    """검토용. 저장하려는 기록을 파일로 내보낸다(0600). KB에는 쓰지 않는다."""
    import os
    from pathlib import Path
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    for b in col.built:
        f = d / f"{b.src.kind}-{b.rid}.md"
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(f"<!-- {b.src.kind} | {b.src.project} | {b.title} -->\n\n{b.body}")
