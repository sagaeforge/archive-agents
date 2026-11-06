"""문서형 어댑터: changelog_md, page_md, llms_txt, html_index, raw_file, pdf_doc, sitemap."""
from __future__ import annotations

import re

from kb.core import ids
from kb.parse.adapters import adapter
from kb.parse.adapters._common import (VERSION_RE, day_points, doc_entity, entity_from_cfg, link_list, version_key)
from kb.parse.model import Claim, Edge, Entity, Result, Series, quote, slugify

_H2 = re.compile(r"^##[ \t]+\[?v?(\d+(?:\.\d+){1,3}[\w.+\-]*)\]?(?:[ \t]*[-–—(][ \t]*(\d{4}-\d{2}-\d{2}))?", re.M)


@adapter("changelog_md", hint="markdown")
def changelog_md(ctx) -> Result:
    """'## 버전' 제목마다 릴리스 엔티티, 최신 버전 주장. 제목에 날짜가 있으면 출시일 주장(event)."""
    text = ctx.text.text
    cfg = ctx.cfg or {}
    prod = entity_from_cfg(cfg, "entity", Entity(ids.entity_id("tool", slugify(ctx.source.id.split(":", 1)[-1] if ctx.source else "changelog")),
                                                 "Tool", ctx.url))
    res = Result(entities=[prod])
    versions = []
    for m in _H2.finditer(text):
        versions.append((m.group(1), m.group(2), m.start(), m.end()))
    if not versions:
        res.notes.append("no_version_headings")
        res.count = 0
        return res
    slug = prod.id.split(":", 2)[2]
    for ver, date, a, b in versions:
        rid = ids.entity_id(prod.type.lower(), f"{slug}-{re.sub(r'[^a-z0-9.]+', '-', ver.lower()).strip('-.')}")
        res.entities.append(Entity(rid, prod.type, f"{prod.label} {ver}", {"version": ver, "release_of": prod.id}))
        res.edges.append(Edge(rid, "PART_OF", prod.id))
        if date:
            sel = quote(text, text[a:b], a)
            if sel:
                res.claims.append(Claim(rid, "released_on", date, f"{prod.label} {ver}은(는) {date}에 출시되었다.", sel,
                                        kind="event", valid_from=date, precision="day"))
    latest = max(versions, key=lambda v: version_key(v[0]))
    ver, _d, a, b = latest
    sel = quote(text, text[a:b], a)
    if sel:
        res.claims.append(Claim(prod.id, "latest_version", ver, f"{prod.label}의 변경 이력(CHANGELOG)에 실린 최신 버전은 {ver}이다.", sel))
    res.count = len(versions)
    return res


def _title(text: str, fallback: str) -> str:
    m = re.search(r"^#[ \t]+(.+?)[ \t#]*$", text, re.M)
    if m:
        return m.group(1).strip()
    for ln in text.splitlines():
        if ln.strip():
            return ln.strip()[:120]
    return fallback


@adapter("page_md", hint=None)
def page_md(ctx) -> Result:
    e = doc_entity(ctx.url, _title(ctx.text.text, ctx.url), ctx.snapshot.get("source"),
                   headings=len(re.findall(r"^#{1,6}[ \t]", ctx.text.text, re.M)))
    return Result(entities=[e], count=1)


@adapter("raw_file", hint="text")
def raw_file(ctx) -> Result:
    t = ctx.text.text
    return Result(entities=[doc_entity(ctx.url, ctx.url.rsplit("/", 1)[-1], ctx.snapshot.get("source"),
                                       bytes=len(ctx.raw), lines=t.count("\n") + 1)], count=1)


@adapter("pdf_doc", hint="pdf")
def pdf_doc(ctx) -> Result:
    t = ctx.text.text
    return Result(entities=[doc_entity(ctx.url, _title(t, ctx.url), ctx.snapshot.get("source"),
                                       pages=getattr(ctx.text, "pages", None))], count=1)


_MD_ITEM = re.compile(r"\[([^\]]+)\]\(\s*<?([^)\s>]+)>?[^)]*\)")


@adapter("llms_txt", hint="markdown")
def llms_txt(ctx) -> Result:
    """색인 문서 자체: 색인과 항목 문서 엔티티, LINKS_TO 엣지. 하위 페이지는 page_md가 파싱한다."""
    t = ctx.text.text
    items = [(m.group(1), m.group(2)) for m in _MD_ITEM.finditer(t)]
    ents, edges, n = link_list(items, ctx.url, ctx.snapshot.get("source"), int(ctx.cfg.get("max_entities", 1000)), _title(t, ctx.url))
    return Result(entities=ents, edges=edges, count=n)


@adapter("html_index", hint="html")
def html_index(ctx) -> Result:
    """HTML 목록 페이지. 표시 본문은 마크다운이라 원본 HTML에서 링크를 다시 뽑는다."""
    import lxml.html
    sel = (ctx.cfg or {}).get("selector") or ((ctx.source.discover or {}).get("selector") if ctx.source else None) or "a[href]"
    doc = lxml.html.document_fromstring(ctx.raw)
    items = []
    for el in doc.cssselect(sel):
        anchors = [el] if el.tag == "a" else list(el.iter("a"))
        for a in anchors:
            h = a.get("href")
            if h and not h.lower().startswith(("javascript:", "mailto:", "tel:", "#")):
                items.append((" ".join(a.text_content().split()) or h, h))
    ents, edges, n = link_list(items, ctx.url, ctx.snapshot.get("source"), int(ctx.cfg.get("max_entities", 500)), _title(ctx.text.text, ctx.url))
    return Result(entities=ents, edges=edges, count=n)


@adapter("sitemap", hint="text")
def sitemap(ctx) -> Result:
    """URL 수 시계열. URL 목록은 색인 단계(discover)가 따로 쓴다."""
    n = len(_locs(ctx.raw))
    src = ctx.source.id.split(":", 1)[-1] if ctx.source else slugify(ctx.url)
    return Result(series=[Series(f"{slugify(src)}-urls", f"{src} sitemap URL 수", "sitemap_urls", day_points(ctx, n, "count"),
                                 unit="count", granularity="day")], count=n)


def _locs(body: bytes) -> list[str]:
    from lxml import etree
    root = etree.fromstring(body, etree.XMLParser(resolve_entities=False, no_network=True, recover=True))
    if root is None:
        return []
    return [el.text.strip() for el in root.iter() if isinstance(el.tag, str) and el.tag.rsplit("}", 1)[-1] == "loc" and el.text]
