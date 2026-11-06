"""피드 어댑터: rss_atom, arxiv, hn_algolia."""
from __future__ import annotations

import calendar
import re
from datetime import datetime, timezone
from html import escape

from kb.core import ids
from kb.parse.adapters import adapter
from kb.parse.adapters._common import day_points, doc_entity, json_prose
from kb.parse.model import Claim, Result, Series, quote, slugify


def _iso_day(st) -> str | None:
    if not st:
        return None
    try:
        return datetime.fromtimestamp(calendar.timegm(st), tz=timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, ValueError):
        return None


def _locate(text: str, needles: list[str], start: int = 0) -> dict | None:
    for n in needles:
        if n:
            for cand in (n, escape(n, quote=False)):
                sel = quote(text, cand, start)
                if sel:
                    return sel
    return None


def feed_result(ctx, entity_type: str = "Document", limit: int = 400) -> Result:
    import feedparser
    fp = feedparser.parse(ctx.raw)
    res = Result()
    ftitle = (fp.feed.get("title") or ctx.url).strip()
    text = ctx.text.text
    src = ctx.snapshot.get("source")
    n = 0
    for ent in fp.entries[:limit]:
        link = (ent.get("link") or ent.get("id") or "").strip()
        title = " ".join((ent.get("title") or "").split())
        if not link or not title:
            continue
        e = doc_entity(link, title, src)
        if entity_type != "Document":
            e.type = entity_type
            e.id = ids.entity_id(entity_type.lower(), e.id.split(":", 2)[2])
        res.entities.append(e)
        n += 1
        raw_date = ent.get("published") or ent.get("updated") or ""
        day = _iso_day(ent.get("published_parsed") or ent.get("updated_parsed"))
        if not day:
            continue
        anchor = text.find(link) if link in text else 0
        sel = _locate(text, [raw_date], max(0, anchor))
        if sel:
            res.claims.append(Claim(e.id, "released_on", day, f"{ftitle}에 \"{title}\"이(가) {day}에 게시되었다.", sel,
                                    kind="event", valid_from=day, precision="day"))
    res.count = n
    return res


@adapter("rss_atom", hint="text")
def rss_atom(ctx) -> Result:
    return feed_result(ctx, (ctx.cfg or {}).get("entity_type", "Document"), int((ctx.cfg or {}).get("limit", 400)))


@adapter("arxiv", hint="text")
def arxiv(ctx) -> Result:
    return feed_result(ctx, "Document", int((ctx.cfg or {}).get("limit", 100)))


@adapter("hn_algolia", hint="json", prose=json_prose("/hits/*/story_text"))      # 산문 선언(D1): 스토리 본문만. 제목은 Document 엔티티다
def hn_algolia(ctx) -> Result:
    d = ctx.json()
    q = d.get("query") or (ctx.cfg or {}).get("query") or "hn"
    n = d.get("nbHits")
    res = Result()
    if isinstance(n, int):
        res.series.append(Series(f"hn-hits-{slugify(q)}", f"Hacker News '{q}' 스토리 수", "hn_story_hits",
                                 day_points(ctx, n, "count"), unit="count", granularity="day"))
    for h in (d.get("hits") or [])[:int((ctx.cfg or {}).get("hits", 20))]:
        title, url = h.get("title"), h.get("url") or (f"https://news.ycombinator.com/item?id={h.get('objectID')}" if h.get("objectID") else None)
        if title and url:
            res.entities.append(doc_entity(url, title, ctx.snapshot.get("source"), hn_id=h.get("objectID"), created_at=h.get("created_at")))
    res.count = n if isinstance(n, int) else len(res.entities)
    return res
