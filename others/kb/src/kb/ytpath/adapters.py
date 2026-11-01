"""파서 어댑터: trends_rss, google_suggest. kb.parse.ADAPTERS가 kb.<패키지>.adapters로 탐색한다.

두 응답 모두 검색량을 담지 않는다(자동완성) 또는 Google이 준 구간 값만 담는다(Trends RSS의 approx_traffic).
그래서 점수, 순위, 응답 안의 순서를 저장하지 않는다. 키워드 후보는 "Google이 제안했다/올렸다"는 귀속으로만 낸다.
YouTube 검색량이 아니다. 귀속 표기: Google Trends, Google 자동완성.
"""
from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
from html import escape
from urllib.parse import parse_qs, urlsplit

from kb.core import ids
from kb.parse.adapters import adapter
from kb.parse.model import Claim, Entity, Result, pointer, quote, slugify

SUGGEST_LIMIT = 20
TRENDS_LIMIT = 50


def keyword_entity(term: str) -> Entity:
    t = " ".join(term.split())
    return Entity(ids.entity_id("keyword", slugify(t)), "Keyword", t[:300])


def _qs(url: str, key: str, default: str) -> str:
    v = parse_qs(urlsplit(url).query).get(key)
    return (v[0] if v else default).strip() or default


@adapter("google_suggest", hint="json")
def google_suggest(ctx) -> Result:
    """google.com/complete/search?client=firefox 응답: [질의, [제안...], ...]. 제안마다 Keyword와
    "질의에 대해 Google 자동완성이 제안했다" 주장을 낸다. 사실 투영이 (제안)-[autocomplete_suggested_for]->(질의) 엣지를 만든다."""
    res = Result()
    try:
        d = ctx.json()
    except ValueError:
        res.notes.append("not_json")
        return res
    if not (isinstance(d, list) and len(d) >= 2 and isinstance(d[0], str) and isinstance(d[1], list)):
        res.notes.append("unexpected_shape")
        return res
    q = " ".join(d[0].split())
    if not q:
        res.notes.append("empty_query")
        return res
    lang = _qs(ctx.url, "hl", "und")
    seed = keyword_entity(q)
    res.entities.append(seed)
    seen = {q.casefold()}
    for i, s in enumerate(d[1]):
        if len(seen) > SUGGEST_LIMIT:
            break
        if not isinstance(s, str):
            continue
        t = " ".join(s.split())
        if not t or t.casefold() in seen:
            continue
        seen.add(t.casefold())
        k = keyword_entity(t)
        res.entities.append(k)
        res.claims.append(Claim(
            k.id, "autocomplete_suggested_for", q,
            f"Google 자동완성이 질의 \"{q}\"(hl={lang})에 \"{t}\"를 제안했다({ctx.day} 관측). 응답에 검색량은 없다.",
            pointer(f"/1/{i}", s), kind="event", qualifiers={"lang": lang, "attribution": "Google 자동완성"},
            valid_from=ctx.day, precision="day", object=seed.id))
    res.count = len(res.entities)
    return res


def _locate(text: str, needle: str, start: int = 0) -> dict | None:
    for cand in (needle, escape(needle, quote=False), escape(needle, quote=False).replace("'", "&apos;"),
                 needle.replace("'", "&apos;")):
        sel = quote(text, cand, start)
        if sel:
            return sel
    return None


@adapter("trends_rss", hint="text")
def trends_rss(ctx) -> Result:
    """trends.google.com/trending/rss?geo=XX. 항목마다 Keyword, trending_search 주장, approx_traffic 구간 값 주장."""
    import feedparser
    fp = feedparser.parse(ctx.raw)
    res = Result()
    geo = _qs(ctx.url, "geo", "XX").upper()
    text = ctx.text.text
    seen: set[str] = set()
    for ent in fp.entries[:TRENDS_LIMIT]:
        title = " ".join((ent.get("title") or "").split())
        if not title or title.casefold() in seen:
            continue
        seen.add(title.casefold())
        k = keyword_entity(title)
        res.entities.append(k)
        st = ent.get("published_parsed")
        day = datetime.fromtimestamp(calendar.timegm(st), tz=timezone.utc).strftime("%Y-%m-%d") if st else None
        anchor = max(0, text.find(f"<title>{escape(title, quote=False)}</title>"))
        sel = _locate(text, title, anchor)
        if sel and day:
            res.claims.append(Claim(
                k.id, "trending_search", geo,
                f"Google Trends 일별 급상승 검색어({geo})에 \"{title}\"이(가) {day}에 올랐다.",
                sel, kind="event", qualifiers={"geo": geo, "attribution": "Google Trends"},
                valid_from=day, precision="day"))
        traffic = (ent.get("ht_approx_traffic") or "").strip()
        if traffic and day and re.fullmatch(r"[0-9][0-9,]*\+?", traffic):
            tsel = _locate(text, traffic, anchor)
            if tsel:
                res.claims.append(Claim(
                    k.id, "google_trends_approx_traffic", traffic,
                    f"Google Trends RSS({geo})가 \"{title}\"의 대략 검색량 구간을 \"{traffic}\"로 표시했다({day}). YouTube 검색량이 아니다.",
                    tsel, kind="event", qualifiers={"geo": geo, "attribution": "Google Trends"},
                    valid_from=day, precision="day"))
    res.count = len(res.entities)
    return res
