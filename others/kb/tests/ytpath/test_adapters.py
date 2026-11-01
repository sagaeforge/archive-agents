"""trends_rss, google_suggest: 고정 픽스처, 네트워크 없음, 출처 귀속 형태, 점수와 순위 없음."""
import json
from types import SimpleNamespace

from kb.parse import adapters
from kb.parse.display import display_text
from kb.parse.events import resolve_pointer
from kb.parse.model import Ctx

from .conftest import SUGGEST_EN, SUGGEST_KO, TRENDS_URL, capture, fx, gold

FORBIDDEN_FIELDS = {"score", "rank", "ranking", "position", "relevance", "volume", "search_volume"}


def run(name, body, ctype, url):
    ad = adapters.ADAPTERS[name]
    txt = display_text(body, ctype, hint=ad.hint, url=url)
    snap = {"id": "n-test", "url": url, "source": "src:t", "raw_sha": "0" * 64, "fetched_at": 1_793_500_000_000, "content_type": ctype}
    c = Ctx(snapshot=snap, raw=body, text=txt, source=None, cfg={})
    return ad.parse(c), c


def test_adapters_are_discovered_by_parse_registry():
    assert {"trends_rss", "google_suggest"} <= set(adapters.ADAPTERS)


def test_google_suggest_ko_attribution_form():
    res, c = run("google_suggest", fx("suggest_ko.json"), "text/javascript; charset=UTF-8", SUGGEST_KO)
    seed = [e for e in res.entities if e.label == "유튜브 제목"]
    assert len(seed) == 1 and seed[0].type == "Keyword"
    assert len(res.claims) == 9                      # 질의와 같은 제안 한 건은 낸다 하지 않는다
    doc = json.loads(c.text.text)
    for cl in res.claims:
        assert cl.predicate == "autocomplete_suggested_for" and cl.value == "유튜브 제목" and cl.object == seed[0].id
        assert "Google 자동완성" in cl.statement and "검색량은 없다" in cl.statement
        assert cl.qualifiers["lang"] == "ko" and cl.qualifiers["attribution"] == "Google 자동완성"
        assert cl.selector["selector_kind"] == "jsonpointer"
        assert resolve_pointer(doc, cl.selector["json_pointer"]) is not None
        assert not (FORBIDDEN_FIELDS & set(cl.qualifiers))


def test_google_suggest_en_and_no_position_is_stored():
    res, _ = run("google_suggest", fx("suggest_en.json"), "text/javascript; charset=UTF-8", SUGGEST_EN)
    assert res.claims and all(cl.qualifiers["lang"] == "en" for cl in res.claims)
    for cl in res.claims:
        assert not any(w in cl.statement for w in ("위", "순위", "점수"))
    for e in res.entities:
        assert not (FORBIDDEN_FIELDS & set(e.props or {}))
    assert not res.series


def test_google_suggest_bad_shape_is_note_not_crash():
    res, _ = run("google_suggest", b'{"a": 1}', "text/javascript", SUGGEST_EN)
    assert res.notes == ["unexpected_shape"] and not res.claims


def test_trends_rss_attribution_and_interval_value():
    res, c = run("trends_rss", fx("trends_kr.xml"), "application/xml; charset=UTF-8", TRENDS_URL)
    assert len(res.entities) == 4 and all(e.type == "Keyword" for e in res.entities)
    preds = {cl.predicate for cl in res.claims}
    assert preds == {"trending_search", "google_trends_approx_traffic"}
    for cl in res.claims:
        assert "Google Trends" in cl.statement or cl.qualifiers["attribution"] == "Google Trends"
        assert cl.qualifiers["geo"] == "KR" and cl.qualifiers["attribution"] == "Google Trends"
        assert cl.selector["selector_kind"] == "text_quote"
        assert c.text.text[cl.selector["start_cp"]:cl.selector["end_cp"]] == cl.selector["exact"]
    traffic = [cl for cl in res.claims if cl.predicate == "google_trends_approx_traffic"]
    assert traffic and all(t.value.rstrip("+").replace(",", "").isdigit() for t in traffic)
    assert all("YouTube 검색량이 아니다" in t.statement for t in traffic)
    assert not any(k in cl.statement for cl in res.claims for k in ("점수", "순위"))


def test_pipeline_writes_keywords_and_projection_edges(env):
    """snapshot -> tick 4단계 -> gold: Keyword 노드와 사실 투영 엣지, 근거 일치."""
    from kb.parse import tick_stage
    capture(SUGGEST_KO, fx("suggest_ko.json"), "text/javascript; charset=UTF-8", "src:yt-suggest")
    capture(TRENDS_URL, fx("trends_kr.xml"), "application/xml; charset=UTF-8", "src:google-trends")
    tc = SimpleNamespace(expired=lambda: False, counters={"parsed": 0}, warnings=[], errors=[], only=None)
    res = tick_stage.run(tc)
    assert res.ok and res.detail["parsed"] == 2, (res, tc.errors, tc.warnings)
    con = gold()
    n_kw = con.execute("SELECT count(*) FROM node WHERE type='Keyword' AND expired_at IS NULL").fetchone()[0]
    assert n_kw >= 13
    cl = con.execute("SELECT c.predicate, count(*) FROM node n JOIN claim c ON c.vid=n.vid WHERE n.expired_at IS NULL "
                     "AND c.predicate IN ('autocomplete_suggested_for','trending_search','google_trends_approx_traffic') GROUP BY 1").fetchall()
    assert dict(cl)["autocomplete_suggested_for"] == 9 and dict(cl)["trending_search"] == 4
