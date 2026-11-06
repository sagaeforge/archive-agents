"""레지스트리 변경을 source.registered, source.status로 쓴다(ADR 10.4). tick 2단계 registry와 kb sources sync가 부른다.
Source 노드가 있어야 /v1/snapshots의 source.label, trust와 카드 출처 칸이 찬다."""
from __future__ import annotations

import json

from kb.collect import registry
from kb.collect.state import State
from kb.core.canon import sha256_hex
from kb.parse.conflicts import ACTOR


def spec_of(s) -> tuple[dict, str]:
    """(source.registered payload, spec_sha). spec_sha에는 결정 승인 여부로 정해지는 실행 가능 판정도 넣는다."""
    ok, why = registry.runnable(s)
    pol = s.policy
    props = {k: v for k, v in {
        "inventory_id": s.inventory_id, "parser": s.parser, "tos": pol.get("tos"), "tos_ref": pol.get("tos_ref"),
        "robots": pol.get("robots"), "trust": pol.get("trust"), "retention": pol.get("retention"),
        "enabled": bool(pol.get("enabled")), "runnable": ok, "not_runnable_reason": why,
        "requires_decision": pol.get("requires_decision"), "reason": pol.get("reason"), "needs_contact": bool(pol.get("needs_contact")),
        "fetch_kind": s.fetch.get("kind"), "url": s.fetch.get("url"), "urls": len(s.static_urls()) or None,
        "discover": (s.discover or {}).get("kind"),
    }.items() if v is not None}
    payload = {"id": s.id, "label": s.name or s.id, "domain": list(s.domain), "props": props}
    if s.class_:
        payload["class"] = s.class_
    sha = sha256_hex(json.dumps([s.raw, ok, why], sort_keys=True, ensure_ascii=False, default=str).encode())
    payload["spec_sha"] = sha
    return payload, sha


def _gone(st: State, s) -> bool:
    """소스의 색인 또는 단일 URL(없으면 정적 URL 전부)이 gone인가. 서로 다른 시간대 3회 404 판정은 WP-06이 한다."""
    if s.fetch.get("url"):
        row = st.get(s.id)
        return bool(row and row.get("state") == "gone")
    urls = [u for u, _ in s.static_urls()]
    if not urls:
        return False
    rows = {r["url"]: r for r in st.list_urls(s.id)}
    return all(rows.get(u, {}).get("state") == "gone" for u in urls)


def sync(*, dry_run: bool = False) -> dict:
    """변경분만 쓴다. 반환: {sources, registered, gone, unchanged}."""
    from kb.write import commit
    srcs = registry.load_registry()
    out = {"sources": len(srcs), "registered": 0, "gone": 0, "unchanged": 0, "ids": []}
    evs: list[dict] = []
    marks: list[tuple[str, str]] = []
    with State() as st:
        for s in srcs:
            payload, sha = spec_of(s)
            if st.kv_get(f"registry:spec:{s.id}") != sha:
                evs.append({"kind": "source.registered", "actor": ACTOR, "origin": "system", "subject": s.id,
                            "idem_key": f"source.registered:{s.id}:{sha[:16]}", "payload": payload})
                marks.append((f"registry:spec:{s.id}", sha))
                out["registered"] += 1
                out["ids"].append(s.id)
            else:
                out["unchanged"] += 1
            if _gone(st, s) and st.kv_get(f"registry:gone:{s.id}") != "1":
                evs.append({"kind": "source.status", "actor": ACTOR, "origin": "system", "subject": s.id,
                            "idem_key": f"source.status:{s.id}:gone", "payload": {"id": s.id, "state": "gone", "reason": "404 x3"}})
                marks.append((f"registry:gone:{s.id}", "1"))
                out["gone"] += 1
        if evs and not dry_run:
            commit(evs, ACTOR, timeout=60.0)
            for k, v in marks:
                st.kv_set(k, v)
    return out
