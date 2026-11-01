"""어댑터 공용 도우미."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urljoin, urlsplit

from kb.core import ids
from kb.parse.model import Edge, Entity, slugify

VERSION_RE = re.compile(r"(\d+(?:\.\d+){1,3})")


def doc_slug(url: str) -> str:
    sp = urlsplit(url)
    h = hashlib.sha256(ids.normalize_url(url).encode()).hexdigest()[:10]
    return f"{slugify(sp.hostname or 'x', 30)}-{h}"


def doc_entity(url: str, label: str | None, source: str | None = None, **props) -> Entity:
    p = {"url": ids.normalize_url(url)}
    if source:
        p["source"] = source
    p.update({k: v for k, v in props.items() if v is not None})
    return Entity(ids.entity_id("document", doc_slug(url)), "Document", (label or url).strip()[:300] or url, p)


def entity_from_cfg(cfg: dict, key: str, default: Entity) -> Entity:
    """소스의 parse.<key> 설정({slug, label, type})을 엔티티로. 설정이 없으면 default."""
    c = (cfg or {}).get(key)
    if not c:
        return default
    t = str(c.get("type", default.type))
    return Entity(ids.entity_id(t.lower(), c["slug"]), t, c.get("label", default.label), c.get("props"))


def version_key(v: str) -> tuple:
    m = VERSION_RE.search(v or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def link_list(items, index_url: str, source: str | None, limit: int, label: str | None = None):
    """(제목, URL) 목록 -> 색인 문서 엔티티, 항목 문서 엔티티, LINKS_TO 엣지."""
    idx = doc_entity(index_url, label, source)
    ents, edges, seen = [idx], [], set()
    for title, href in items:
        u = urljoin(index_url, href)
        if urlsplit(u).scheme not in ("http", "https") or u in seen or u == index_url:
            continue
        seen.add(u)
        e = doc_entity(u, title, source)
        ents.append(e)
        edges.append(Edge(idx.id, "LINKS_TO", e.id))
        if len(seen) >= limit:
            break
    return ents, edges, len(seen)


def day_points(ctx, value, unit=None) -> list:
    from kb.parse.model import day_ms
    s = day_ms(ctx.day)
    return [{"period_key": ctx.day, "period_start": s, "period_end": s + 86400_000, "value": str(value), "unit": unit}]


def jdump(v) -> str:
    return json.dumps(v, ensure_ascii=False)
