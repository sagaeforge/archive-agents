"""Result -> 원장 이벤트. 이벤트 형식은 schemas/events/가 원본이다."""
from __future__ import annotations

import json

from kb.core import cas, ids
from kb.core.canon import canon_json, sha256_hex
from kb.parse import conflicts
from kb.parse.model import Claim, Result

ACTOR = conflicts.ACTOR
GATE_VERSION = "parse@1"


def _h(o) -> str:
    return sha256_hex(canon_json(o))[:12]


def resolve_pointer(doc, ptr: str):
    """RFC 6901. 없으면 KeyError."""
    if ptr == "":
        return doc
    cur = doc
    for part in ptr.split("/")[1:]:
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


def entity_event(e, domain) -> dict:
    p = {"id": e.id, "type": e.type, "label": e.label}
    if e.aliases:
        p["aliases"] = list(e.aliases)
    if e.props:
        p["props"] = e.props
    if domain:
        p["domain"] = list(domain)
    return {"kind": "entity.put", "actor": ACTOR, "origin": "external", "subject": e.id, "idem_key": f"ent:{e.id}:{_h(p)}", "payload": p}


def edge_event(ed) -> dict:
    p = {"id": ids.edge_id(ed.src, ed.rtype, ed.dst), "src": ed.src, "rtype": ed.rtype, "dst": ed.dst}
    if ed.props:
        p["props"] = ed.props
    return {"kind": "edge.put", "actor": ACTOR, "origin": "external", "subject": ed.src, "idem_key": f"edge:{p['id']}:{_h(p)}", "payload": p}


def claim_payload(c: Claim, sid: str, text_sha: str, ref: str) -> dict:
    qual = c.qualifiers or {}
    period = c.valid_from if c.kind == "event" else None
    cid = ids.claim_id_det(c.subject, c.predicate, qual, c.value, period)
    ev = dict(c.selector)
    ev.update(snapshot=sid, text_sha=text_sha, gate_version=GATE_VERSION)
    p = {"id": cid, "subject": c.subject, "predicate": c.predicate, "value": c.value, "statement": c.statement, "kind": c.kind,
         "stance": "stated", "method": "deterministic", "verification": "parser_derived",
         "slot": conflicts.slot_of(c.subject, c.predicate, qual), "extractor": ref, "evidence": [ev]}
    if c.object:
        p["object"] = c.object
    if c.unit:
        p["unit"] = c.unit
    if qual:
        p["qualifiers"] = qual
    if c.valid_from:
        p["valid"] = {"from": c.valid_from}
        if c.precision:
            p["valid"]["precision"] = c.precision
    return p


def series_events(s, sid: str, ref: str, domain) -> list[dict]:
    sid_ = ids.series_id(s.slug)
    d = {"id": sid_, "label": s.label, "metric": s.metric}
    for k in ("unit", "subject", "granularity"):
        if getattr(s, k):
            d[k] = getattr(s, k)
    if domain:
        d["domain"] = list(domain)
    nd = b"\n".join(canon_json(p) for p in s.points) + b"\n"
    sha = cas.put(nd)
    return [{"kind": "series.define", "actor": ACTOR, "origin": "external", "subject": sid_, "idem_key": f"series.define:{sid_}:{_h(d)}", "payload": d},
            {"kind": "series.batch", "actor": ACTOR, "origin": "external", "subject": sid_, "idem_key": f"series.batch:{sid_}:{sid}:{ref}",
             "payload": {"series_id": sid_, "snapshot": sid, "parser": ref, "points_sha": sha, "count": len(s.points)}}]


def build(snap: dict, res: Result, text, text_sha: str, ref: str, *, source: str | None, functional: set, now_ms: int,
          existing=conflicts.load_existing) -> tuple[list[dict], dict]:
    """(이벤트 목록, 통계). 순서: 엔티티, 엣지, 시계열, 주장(+대체/충돌)."""
    sid = snap["id"]
    domain = snap.get("domain")
    stats = {"entities": 0, "edges": 0, "series": 0, "claims": 0, "superseded": 0, "conflicts": 0, "dropped": 0}
    evs: list[dict] = []
    seen = set()
    for e in res.entities:
        if e.id not in seen:
            seen.add(e.id)
            evs.append(entity_event(e, domain))
    stats["entities"] = len(seen)
    for ed in res.edges:
        evs.append(edge_event(ed))
    stats["edges"] = len(res.edges)
    for s in res.series:
        evs.extend(series_events(s, sid, ref, domain))
    stats["series"] = len(res.series)
    doc = None
    if text.fmt == "json":
        try:
            doc = json.loads(text.text)
        except ValueError:
            doc = None
    for c in res.claims:
        sel = c.selector
        if sel["selector_kind"] == "jsonpointer":
            try:
                resolve_pointer(doc, sel["json_pointer"])
            except (KeyError, IndexError, ValueError, TypeError):
                stats["dropped"] += 1
                continue
        elif text.text[sel["start_cp"]:sel["end_cp"]] != sel["exact"]:
            stats["dropped"] += 1
            continue
        p = claim_payload(c, sid, text_sha, ref)
        post: list[dict] = []
        if c.predicate in functional:
            try:
                ex = existing(p["slot"])
            except Exception:  # noqa: BLE001 gold 조회 실패가 파싱을 막지 않는다. 충돌 처리는 다음 파싱이 한다
                ex = []
            r = conflicts.resolve(p, source, ex, True, now_ms)
            if r.new_valid_to:
                p.setdefault("valid", {})["to"] = r.new_valid_to
            for d in r.events:
                k, dp = d["kind"], d["payload"]
                key = {"claim.supersede": f"supersede:{dp.get('id')}:{dp.get('by')}", "edge.put": f"edge:{dp.get('id')}",
                       "claim.assert": f"claim.close:{dp.get('id')}:{dp.get('valid', {}).get('to')}"}[k]
                post.append({"kind": k, "actor": ACTOR, "origin": "external", "subject": dp.get("id"), "idem_key": key, "payload": dp})
                stats["superseded" if k == "claim.supersede" else "conflicts" if k == "edge.put" else "claims"] += 1
        evs.append({"kind": "claim.assert", "actor": ACTOR, "origin": "external", "subject": p["subject"],
                    "idem_key": f"claim:{p['id']}:{sid}:{ref}", "payload": p})
        evs.extend(post)       # 대체와 충돌 엣지는 새 주장이 생긴 뒤에 쓴다
        stats["claims"] += 1
    return evs, stats
