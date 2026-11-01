"""세션 조사 자료 흡수(WP-26): 매니페스트 -> 기록(Artifact) + URL 후보 티켓.

세션 서술은 claim, entity, edge 이벤트가 되지 않는다. 기록은 kb.write.put_record(transport="intake")가 쓰고
결정 2 전에는 held다. 외부 사실은 URL만 티켓(kb.ticket)으로 넘긴다. 이 모듈은 네트워크를 쓰지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from kb.intake import deny as _deny
from kb.intake import urls as _urls
from kb.intake.errors import IntakeError
from kb.intake.manifest import URL_TREATS, load_manifest
from kb.intake.scrub import Scrubber

TICKET_PREFIX = "세션 출처 재확인: "


@dataclass
class Material:
    item: dict
    resolved: bool = False
    body: str | None = None
    scrubbed: int = 0
    urls: list[str] = field(default_factory=list)
    source_path: str = ""

    @property
    def treat(self) -> str:
        return self.item["treat"]

    @property
    def body_sha(self) -> str | None:
        return None if self.body is None else hashlib.sha256(self.body.encode()).hexdigest()

    @property
    def key(self) -> str | None:
        return None if self.body is None else f"intake:{self.item['id']}:{self.body_sha}"


# ------------------------------------------------------------------ 읽기

def _locate(rel: str, item: dict, copy_dir: Path, *, want_dir: bool = False) -> Path | None:
    """사본이 있으면 사본, 없으면 원본. intake/ 로 시작하는 경로는 사본 폴더 안이다."""
    if rel.startswith("intake/"):
        cand = copy_dir / rel[len("intake/"):]
    else:
        c = copy_dir / item["session"] / Path(rel).name
        if not want_dir and c.is_file():
            return c
        cand = Path(rel)
    ok = cand.is_dir() if want_dir else cand.is_file()
    return cand if ok else None


def _text(p: Path) -> str:
    return p.read_bytes().decode("utf-8", errors="replace")


def _git_show(spec: dict) -> str | None:
    try:
        r = subprocess.run(["git", "-C", spec["repo"], "show", f"{spec['ref']}:{spec['path']}"],
                           capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.decode("utf-8", errors="replace") if r.returncode == 0 else None


def _jsonl_body(text: str, labels: list[str]) -> str:
    """같은 key의 started 줄 label이 labels에 든 result 줄만. 다른 줄은 저장하지 않는다."""
    want: dict[str, str] = {}
    results: list[tuple[str, object]] = []
    for ln in text.splitlines():
        try:
            d = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("type") == "started" and d.get("label") in labels:
            want[d.get("key")] = d["label"]
        elif d.get("type") == "result":
            results.append((d.get("key"), d.get("result")))
    parts = []
    for key, res in results:
        if key in want:
            parts.append(f"## {want[key]}\n\n" + json.dumps(res, ensure_ascii=False, indent=2, sort_keys=True))
    return "\n\n".join(parts) + ("\n" if parts else "")


def _versions_body(text: str, names: list[str]) -> str:
    doc = json.loads(text)
    pk = doc.get("packages") or {}
    deps = doc.get("dependencies") or {}
    out = []
    for n in names:
        v = (pk.get(f"node_modules/{n}") or {}).get("version") or (deps.get(n) or {}).get("version")
        out.append(f"- {n} {v}" if v else f"- {n} (잠금 파일에 없음)")
    return "\n".join(out) + "\n"


def _index_body(root: Path) -> str:
    rows = []
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        h = hashlib.sha256()
        with open(f, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        rows.append(f"- {f.relative_to(root).as_posix()}\t{f.stat().st_size}\t{h.hexdigest()}")
    return f"파일 {len(rows)}개 (경로, 바이트, sha256)\n\n" + "\n".join(rows) + "\n"


def material(item: dict, copy_dir: Path, scr: Scrubber) -> Material:
    """항목 하나를 읽어 저장할 본문을 만든다. excluded는 파일을 열지 않는다."""
    m = Material(item=item)
    treat = item["treat"]
    if treat == "excluded":
        m.resolved = True
        return m
    gs = item.get("git_show")
    m.source_path = (f"git show {gs['ref']}:{gs['path']} ({Path(gs['repo']).name})" if gs else item["path"])
    drop = set(item.get("exclude_lines") or [])
    if treat in ("full", "filtered"):
        if gs:
            raw = _git_show(gs)
        else:
            p = _locate(item["path"], item, copy_dir)
            raw = _text(p) if p else None
        if raw is None:
            return m
        m.body, m.scrubbed = scr.lines(raw, drop or None)
        m.urls = _urls.extract(m.body)
    elif treat == "jsonl_filter":
        p = _locate(item["path"], item, copy_dir)
        if not p:
            return m
        raw = _jsonl_body(_text(p), list(item.get("select") or []))
        m.body, m.scrubbed = scr.lines(raw)
        m.urls = _urls.extract(m.body)
    elif treat == "versions_only":
        p = _locate(item["path"], item, copy_dir)
        if not p:
            return m
        m.body = _versions_body(_text(p), list(item.get("select") or []))
    elif treat == "index":
        d = _locate(item["path"], item, copy_dir, want_dir=True)
        if not d:
            return m
        raw = _index_body(d)
        m.body, m.scrubbed = scr.lines(raw)
    elif treat == "urls_only":
        uf = item.get("urls_file")
        if uf:  # 전사 본문은 열지 않는다. 크기만 stat으로 본다
            f = _locate(uf, item, copy_dir)
            if not f:
                return m
            found = [ln.strip() for ln in _text(f).splitlines() if ln.strip().startswith("https://")]
            src = Path(item["path"])
            size = src.stat().st_size if src.is_file() else None
            meta = [f"원본 크기 {size} 바이트(본문 미저장, 미열람)"] if size is not None else ["원본 본문 미저장, 미열람"]
        else:  # URL을 뽑으려고 읽을 뿐 본문은 저장하지 않는다
            f = _locate(item["path"], item, copy_dir)
            if not f:
                return m
            data = f.read_bytes()
            found = _urls.extract(data.decode("utf-8", errors="replace"))
            meta = [f"원본 크기 {len(data)} 바이트 sha256 {hashlib.sha256(data).hexdigest()}(본문 미저장)"]
        kept, dropped = [], 0
        for u in dict.fromkeys(found):
            if scr.bad(u):
                dropped += 1
            else:
                kept.append(u)
        m.scrubbed = dropped
        m.urls = kept
        m.body = ("본문 없이 메타데이터와 공개 URL만 저장한다.\n\n" + "\n".join(meta) + f"\n\n공개 URL {len(kept)}건\n\n"
                  + "\n".join(f"- {u}" for u in kept) + "\n")
    m.resolved = m.body is not None
    return m


# ------------------------------------------------------------------ 상태 조회(읽기 전용)

def _held_keys() -> set[str]:
    from kb.core import spool
    out: set[str] = set()
    try:
        for _, obj in spool.iter_items("fp-held"):
            for e in (obj or {}).get("events", []):
                if e.get("idem_key"):
                    out.add(e["idem_key"])
    except FileNotFoundError:
        pass
    return out


def _ledger_keys() -> set[str]:
    from kb.core import ledger
    from kb.core.conn import connect_ro
    p = ledger.ledger_path()
    if not p.exists():
        return set()
    c = connect_ro(p)
    try:
        return {r[0] for r in c.execute("SELECT idem_key FROM event WHERE idem_key LIKE 'intake:%'")}
    finally:
        c.close()


def _active_urls() -> set[str]:
    try:
        from kb.collect import registry
        out = set()
        for s in registry.load_registry(validate=False):
            if s.enabled:
                for u in s.all_urls():
                    n = _urls.normalize(u)
                    if n:
                        out.add(n)
        return out
    except Exception:  # 레지스트리를 못 읽으면 건너뛰기 판정만 약해질 뿐이다
        return set()


class Book:
    """열린 티켓의 주제와 urls 사본. 쓰기 규칙(kb.ticket)과 같은 병합 판정으로 URL을 자리에 앉힌다."""

    def __init__(self, rows: list[dict]):
        self.rows = [{"id": r["id"], "topic": r["topic"], "urls": list(r["urls"])} for r in rows]

    def place(self, topic: str, url: str):
        from kb import ticket
        self.rows.sort(key=lambda r: r["id"] or "\uffff")  # 쓰기 쪽 _open_rows가 id 순이다. 같은 순서로 골라야 같은 티켓이 된다
        match = [r for r in self.rows if ticket.same_request(topic, r["topic"])]
        hit = match[0] if match else None
        if any(url in r["urls"] for r in match):  # 병합 후보 어디에든 있으면 이미 있는 것이다(멱등)
            return "have", next(r for r in match if url in r["urls"])
        if hit is None:
            hit = {"id": None, "topic": topic, "urls": [url]}
            self.rows.append(hit)
            return "add", hit
        if url in hit["urls"]:
            return "have", hit
        if len(hit["urls"]) >= ticket.MAX_URLS:
            return "cap", hit
        hit["urls"].append(url)
        return "add", hit

    def settle(self, ent: dict, topic: str, url: str, tid: str) -> dict:
        """open_ticket이 돌려준 티켓 id에 맞춰 사본을 고친다. 반환은 URL이 실제로 든 항목."""
        tgt = next((r for r in self.rows if r["id"] == tid and r is not ent), None)
        if ent["id"] is None and tgt is None:
            ent["id"] = tid
            return ent
        if ent["id"] == tid:
            return ent
        ent["urls"].remove(url)
        if not ent["urls"] and ent["id"] is None:
            self.rows.remove(ent)
        if tgt is None:
            tgt = {"id": tid, "topic": topic, "urls": []}
            self.rows.append(tgt)
        if url not in tgt["urls"]:
            tgt["urls"].append(url)
        return tgt


def _open_rows() -> list[dict]:
    from kb import ticket
    try:
        return ticket._open_rows()
    except Exception:
        return []


def _candidates(mats: list[Material], dn: list[str]) -> tuple[dict, list[tuple[Material, list[str]]]]:
    """URL 집계와 항목별 등록 후보. 전역 중복 제거."""
    import re as _re
    from kb.collect import host_allowed
    deny_re = _re.compile("|".join(_re.escape(n) for n in sorted(set(dn), key=len, reverse=True)), _re.I) if dn else None
    active = _active_urls()
    seen: set[str] = set()
    agg = {"extracted": 0, "registered": 0, "skipped": 0, "denied": 0}
    per: list[tuple[Material, list[str]]] = []
    for m in mats:
        if not m.resolved or m.treat not in URL_TREATS or m.item.get("no_urls"):
            continue
        cand = []
        for raw in m.urls:
            n = _urls.normalize(raw)
            if not n or n in seen:
                continue
            seen.add(n)
            agg["extracted"] += 1
            if _urls.skip_reason(n, deny_re) or n in active:
                agg["skipped"] += 1
            elif not host_allowed(urlsplit(n).hostname or ""):
                agg["denied"] += 1
            else:
                cand.append(n)
        if cand:
            per.append((m, cand))
    return agg, per


# ------------------------------------------------------------------ plan, run, status

def _collect(manifest: dict, dn: list[str]) -> list[Material]:
    scr = Scrubber(dn)
    cd = Path(manifest["copy_dir"]).expanduser()
    return [material(it, cd, scr) for it in manifest["items"]]


def _record(m: Material) -> dict:
    it = m.item
    props = {"session": it["session"], "project": it["project"], "source_path": m.source_path,
             "researched_on": it["researched_on"], "primary": it.get("primary"), "treat": it["treat"],
             "scrubbed": m.scrubbed}
    if it.get("note"):
        props["note"] = it["note"]
    props = {k: v for k, v in props.items() if v is not None}
    fmt = "markdown" if m.source_path.endswith(".md") or it["treat"] in ("urls_only", "index", "versions_only") else "text"
    return {"type": "Artifact", "title": it["topic"], "body": m.body, "body_format": fmt,
            "sensitivity": "internal", "props": props}


def _secret(m: Material) -> bool:
    from kb.write import record
    w: list[str] = []
    record.build_payload(_record(m), record.derive_id(m.key), w)
    return any(x.startswith("secret_detected") for x in w)


def _report(manifest: dict, mats: list[Material], states: dict[str, str], agg: dict, tickets: int, *,
            new_events: int, secret_hits: int, detail: bool, extra: dict | None = None) -> dict:
    items = len(mats)
    un = [m.item["id"] for m in mats if not m.resolved]
    out = {
        "items": items,
        "stored": sum(1 for s in states.values() if s == "stored"),
        "held": sum(1 for s in states.values() if s == "held"),
        "excluded": sum(1 for m in mats if m.treat == "excluded"),
        "unresolved": len(un), "unresolved_ids": un,
        "secret_hits": secret_hits,
        "scrubbed_lines": sum(m.scrubbed for m in mats),
        "urls": agg, "tickets": tickets, "new_events": new_events,
    }
    if extra:
        out.update(extra)
    if detail:
        out["detail"] = [{"id": m.item["id"], "treat": m.treat, "resolved": m.resolved, "state": states.get(m.item["id"], "-"),
                          "bytes": len((m.body or "").encode()), "scrubbed": m.scrubbed, "urls": len(m.urls)} for m in mats]
    return out


def _states(mats: list[Material]) -> dict[str, str]:
    led, held = _ledger_keys(), _held_keys()
    st = {}
    for m in mats:
        if m.treat == "excluded" or not m.resolved:
            continue
        st[m.item["id"]] = "stored" if m.key in led else "held" if m.key in held else "new"
    return st


def _simulate(per, rows) -> tuple[dict, int]:
    book = Book(rows)
    capped, touched = 0, set()
    for m, cand in per:
        topic = TICKET_PREFIX + m.item["topic"]
        for u in cand:
            act, ent = book.place(topic, u)
            if act == "cap":
                capped += 1
            else:
                touched.add(id(ent))
    return {"capped": capped}, len(touched)


def plan(manifest: dict | None = None, *, detail: bool = False) -> dict:
    """쓰기 없음. 차단 목록이 없으면 E_DENY_MISSING."""
    manifest = manifest or load_manifest()
    dn = _deny.load()
    mats = _collect(manifest, dn)
    agg, per = _candidates(mats, dn)
    st = _states(mats)
    info, tickets = _simulate(per, _open_rows())
    agg = {**agg, "registered": sum(len(c) for _, c in per) - info["capped"]}
    agg["skipped"] += info["capped"]
    secrets = sum(1 for m in mats if m.resolved and m.body is not None and _secret(m))
    return _report(manifest, mats, st, agg, tickets, new_events=0, secret_hits=secrets, detail=detail,
                   extra={"mode": "plan", "ticket_capped": info["capped"]})


def status(manifest: dict | None = None, *, detail: bool = False) -> dict:
    r = plan(manifest, detail=detail)
    r["mode"] = "status"
    return r


def _ensure_ready() -> None:
    """gold가 없거나 gold_schema가 코드와 다르면 rebuild, 그리고 schema sync를 먼저 돈다(멱등, gold는 파생물)."""
    from kb.project import SchemaMismatch, current_gold_path, open_gold, rebuild
    from kb.write import sync_schema
    sync_schema()
    p = current_gold_path()
    if p is None:
        rebuild(allow_missing=True)
        return
    try:
        open_gold(p).close()
    except SchemaMismatch:
        rebuild(allow_missing=True)


def run(manifest: dict | None = None, *, detail: bool = False) -> dict:
    from kb import ticket
    from kb.write import put_record
    from kb.write.engine import project_pending
    from kb.write.errors import WriteRejected
    manifest = manifest or load_manifest()
    dn = _deny.load()
    mats = _collect(manifest, dn)
    _ensure_ready()
    held0 = _held_keys()
    new_events, secrets = 0, 0
    st: dict[str, str] = {}
    for m in mats:
        if m.treat == "excluded" or not m.resolved:
            continue
        res = put_record(_record(m), m.key, "intake", session=m.item["session"])
        if any(w.startswith("secret_detected") for w in res.warnings):
            secrets += 1
        if res.held:
            st[m.item["id"]] = "held"
            new_events += 0 if m.key in held0 else 1
        else:
            st[m.item["id"]] = "stored"
            new_events += sum(1 for e in res.events if not e["replayed"])
    project_pending()  # 티켓을 읽기 전에 gold가 원장 머리를 따라잡아야 한다(문단 예산 때문에 뒤처질 수 있다)
    agg, per = _candidates(mats, dn)
    book = Book(_open_rows())
    touched: set[int] = set()
    registered = capped = errors = 0
    for m, cand in per:
        topic = TICKET_PREFIX + m.item["topic"]
        reason = (f"세션 {m.item['session']}가 {m.item['researched_on']}에 조사한 자료({m.item['id']})가 인용한 출처. "
                  "수집 경로의 게이트를 지나기 전에는 사실이 아니다")
        for u in cand:
            act, ent = book.place(topic, u)
            if act == "cap":
                capped += 1
                continue
            if act == "add":
                try:
                    r = ticket.open_ticket(topic, reason, "low", u, transport="intake", session=m.item["session"])
                except WriteRejected:
                    errors += 1
                    ent["urls"].remove(u)
                    continue
                ent = book.settle(ent, topic, u, r["ticket"])
                new_events += 1
            registered += 1
            touched.add(id(ent))
    project_pending()
    agg = {**agg, "registered": registered, "skipped": agg["skipped"] + capped}
    return _report(manifest, mats, st, agg, len(touched), new_events=new_events, secret_hits=secrets, detail=detail,
                   extra={"mode": "run", "ticket_capped": capped, "ticket_errors": errors})


# ------------------------------------------------------------------ verify, purge-copy

def _stored_payloads():
    """(idem_key, payload, body) 보관 중(스풀)과 원장의 intake 기록."""
    from kb.core import cas, ledger, spool
    from kb.core.conn import connect_ro

    def body_of(p: dict) -> str:
        if isinstance(p.get("body"), str):
            return p["body"]
        sha = p.get("body_sha")
        try:
            return cas.get(sha).decode("utf-8", errors="replace") if sha else ""
        except Exception:
            return ""
    try:
        for _, obj in spool.iter_items("fp-held"):
            for e in (obj or {}).get("events", []):
                if e.get("kind") == "record.put" and str(e.get("idem_key", "")).startswith("intake:"):
                    yield e["idem_key"], e["payload"], body_of(e["payload"])
    except FileNotFoundError:
        pass
    lp = ledger.ledger_path()
    if lp.exists():
        c = connect_ro(lp)
        try:
            for key, sha in c.execute("SELECT idem_key, payload_sha FROM event WHERE idem_key LIKE 'intake:%' "
                                      "AND kind='record.put'").fetchall():
                p = ledger.get_payload(c, sha) or {}
                yield key, p, body_of(p)
        finally:
            c.close()


def verify(manifest: dict | None = None) -> dict:
    """저장된 기록에서 차단 목록 문자열과 내부 주소 패턴을 찾아 건수만 낸다."""
    manifest = manifest or load_manifest()
    dn = _deny.load()
    scr = Scrubber(dn)
    want = {it["id"]: it["treat"] for it in manifest["items"]}
    dh = ah = mism = n = 0
    seen: set[str] = set()
    for key, p, body in _stored_payloads():
        parts = key.split(":", 2)
        iid = parts[1] if len(parts) > 2 else ""
        seen.add(iid)
        n += 1
        text = "\n".join([str(p.get("title", "")), body, json.dumps(p.get("props", {}), ensure_ascii=False)])
        d, a = scr.hits(text)
        dh += d
        ah += a
        if want.get(iid) != (p.get("props") or {}).get("treat"):
            mism += 1
    missing = sum(1 for it in manifest["items"] if it["treat"] != "excluded" and it["id"] not in seen)
    return {"deny_entries": len(dn), "deny_hits": dh, "internal_addr_hits": ah, "by_treat_mismatch": mism,
            "records": n, "missing": missing}


def purge_copy(manifest: dict | None = None, *, apply: bool = False, copy_dir: str | None = None) -> dict:
    """접수 사본 삭제. MANIFEST.sha256 대조와 전 항목 처리 확인과 결정 3 승인 뒤에만, TTY에서만 지운다."""
    import shutil
    from kb.core import config
    from kb.write import tty
    manifest = manifest or load_manifest()
    cd = Path(copy_dir or manifest["copy_dir"]).expanduser()
    out = {"copy_dir_exists": cd.is_dir(), "applied": False, "checks": {}}
    if not cd.is_dir():
        out["checks"]["copy_present"] = False
        return out
    mf = cd / "MANIFEST.sha256"
    ok_hash, bad = mf.is_file(), 0
    if ok_hash:
        for ln in mf.read_text().splitlines():
            if not ln.strip():
                continue
            h, rel = ln.split(None, 1)
            f = cd / rel.strip().lstrip("*").removeprefix("./")
            if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != h:
                bad += 1
    out["checks"]["manifest_sha256"] = ok_hash and bad == 0
    st = status(manifest)
    out["checks"]["all_processed"] = st["unresolved"] == 0 and st["stored"] + st["held"] + st["excluded"] == st["items"]
    out["checks"]["decision_3"] = bool(config.decision_ok(3))
    out["checks"]["tty"] = bool(tty.is_tty())
    ready = all(out["checks"].values())
    out["ready"] = ready
    if apply:
        if not ready:
            raise IntakeError("E_PURGE_BLOCKED", "삭제 조건 미충족: " + ",".join(k for k, v in out["checks"].items() if not v))
        shutil.rmtree(cd)
        out["applied"] = True
    return out
