"""색인 문서에서 하위 페이지 URL을 뽑는 순수 함수(ADR 10.4). 네트워크에 가지 않는다.

DISCOVERERS[kind](body: bytes, base_url: str, cfg: dict) -> list[str]
프래그먼트와 중복을 지우고 같은 호스트 URL만 남긴다. 순서는 문서에 나온 순서(결정적).
include/exclude/max_pages는 호출자(WP-06 fetch 단계)가 적용하지만 cfg에 있으면 여기서도 같은 규칙으로 거른다.
"""
from __future__ import annotations

import re
from urllib.parse import urldefrag, urljoin, urlsplit

_MD_LINK = re.compile(r"\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
_BARE = re.compile(r"(?<![\w(])(https?://[^\s<>\")\]]+)")


def _host(u: str) -> str:
    return (urlsplit(u).hostname or "").lower()


def _clean(urls, base_url: str, cfg: dict) -> list[str]:
    host = _host(base_url)
    inc = [re.compile(p) for p in ([cfg["include"]] if isinstance(cfg.get("include"), str) else cfg.get("include") or [])]
    exc = [re.compile(p) for p in ([cfg["exclude"]] if isinstance(cfg.get("exclude"), str) else cfg.get("exclude") or [])]
    out, seen = [], set()
    for u in urls:
        u = urldefrag(urljoin(base_url, u.strip()))[0]
        sp = urlsplit(u)
        if sp.scheme not in ("http", "https") or _host(u) != host or u in seen:
            continue
        if inc and not any(p.search(u) for p in inc):
            continue
        if any(p.search(u) for p in exc):
            continue
        seen.add(u)
        out.append(u)
    return out


def _text(body: bytes) -> str:
    return body.decode("utf-8", "replace")


def llms_txt(body: bytes, base_url: str, cfg: dict) -> list[str]:
    """마크다운 링크 중 같은 호스트의 문서 URL. 링크 문법이 아닌 줄의 맨 URL도 받는다."""
    t = _text(body)
    found = [m.group(1) for m in _MD_LINK.finditer(t)]
    stripped = _MD_LINK.sub(" ", t)
    found += [m.group(1).rstrip(".,;") for m in _BARE.finditer(stripped)]
    # 문서에 나온 순서를 지키려고 위치로 정렬한다
    pos = {}
    for u in found:
        pos.setdefault(u, t.find(u))
    ordered = sorted(set(found), key=lambda u: (pos[u] if pos[u] >= 0 else 10 ** 9, u))
    return _clean(ordered, base_url, cfg)


def sitemap(body: bytes, base_url: str, cfg: dict) -> list[str]:
    """urlset의 loc. sitemapindex면 하위 sitemap URL을 돌려준다(WP-06이 max_depth까지 따라간다)."""
    from lxml import etree
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False, recover=True)
    root = etree.fromstring(body, parser)
    if root is None:
        return []
    locs = []
    for el in root.iter():
        if isinstance(el.tag, str) and el.tag.rsplit("}", 1)[-1] == "loc" and el.text:
            locs.append(el.text.strip())
    return _clean(locs, base_url, cfg)


def html_index(body: bytes, base_url: str, cfg: dict) -> list[str]:
    """cfg.selector(기본 a[href])의 링크."""
    import lxml.html
    sel = cfg.get("selector") or "a[href]"
    doc = lxml.html.document_fromstring(body)
    hrefs = []
    for el in doc.cssselect(sel):
        h = el.get("href") if el.tag == "a" else None
        if h is None:
            for a in el.iter("a"):
                if a.get("href"):
                    hrefs.append(a.get("href"))
            continue
        hrefs.append(h)
    return _clean([h for h in hrefs if not h.lower().startswith(("javascript:", "mailto:", "tel:"))], base_url, cfg)


DISCOVERERS = {"llms_txt": llms_txt, "sitemap": sitemap, "html_index": html_index}
