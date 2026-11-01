"""필터 경로는 안쪽 LIMIT 없이 필터 후 순위를 매긴다(감사 R7). 기본 경로는 total=null, 상위 400 후보."""
import pytest

from kb.read import search as S
from kb.read.ctx import BadParam, CursorMismatch

from .shelp import E, ids, record

N, RARE = 600, 6   # 1%


@pytest.fixture
def big(w):
    evs = []
    for i in range(N):
        rare = i < RARE
        # 희귀 레코드는 본문이 길어 bm25가 낮다 -> 상위 400 밖으로 밀린다
        body = f"공통어 본문 {i} " + ("잡음 " * 80 if rare else "")
        e = record(f"f-{i:04d}", f"공통어 문서 {i} " + ("잡음 " * 80 if rare else ""), body=body, type="Decision" if rare else "Note")
        evs.append(e)
    w.add(evs)
    return w


def _all_matches(w, **ctxkw):
    """안쪽 LIMIT 없는 정답: 제목이나 본문에 `공통어`가 있는 record 전부."""
    with w.rd(**ctxkw) as (con, ctx):
        from kb.read.ctx import visibility_sql
        vw, vp = visibility_sql(ctx, "s", kind="span")
        sql = f"SELECT DISTINCT s.ref_id FROM span s WHERE s.ref_kind='record' AND {vw}"
        return {r[0] for r in con.execute(sql, vp)}


def test_rare_filter_returns_all_and_total_exact(big):
    r = S.search("공통어", big.ctx(types="Decision"), kinds="record", limit=200)
    assert r["page"]["total"] == RARE
    assert sorted(ids(r)) == [f"f-{i:04d}" for i in range(RARE)]
    # 필터 없는 기본 경로는 상위 400 안에서만 순위를 매겨 희귀 레코드를 놓친다(0건 오답의 원형)
    seen = set()
    cur = None
    while True:
        p = S.search("공통어", big.ctx(), limit=200, cursor=cur)
        seen |= set(ids(p))
        cur = p["page"]["next_cursor"]
        if not cur:
            break
    assert p["page"]["total"] is None and p["page"]["truncated"] is True
    assert len(seen) <= 400 and not seen & {f"f-{i:04d}" for i in range(RARE)}


def test_filter_path_equals_unlimited_truth(big):
    for kw in ({"types": "Note"}, {"types": "Decision"}, {"origin": "first_party"}, {"author": "user:sagae"}):
        truth = _all_matches(big, **kw)
        got, cur = [], None
        while True:
            r = S.search("공통어", big.ctx(**kw), kinds="record", limit=200, cursor=cur)
            got += ids(r)
            cur = r["page"]["next_cursor"]
            assert r["page"]["total"] == len(truth)
            if not cur:
                break
        assert set(got) == truth and len(got) == len(truth), kw


def test_zero_wrong_answers_for_existing_info(big):
    # 있는 정보를 0건으로 답하지 않는다: 어떤 희귀 필터에서도 건수는 정답과 같다
    for dom in ("none",):
        r = S.search("공통어", big.ctx(domain=dom), kinds="record", limit=200)
        assert r["page"]["total"] == len(_all_matches(big, domain=dom))
        assert len(ids(r)) == min(200, r["page"]["total"])


def test_facets_from_full_match_not_top_400(big):
    f = S.search_facets("공통어", big.ctx())
    assert f["data"]["total"] == N   # 상위 400이 아니라 전체 일치
    by_type = {x["value"]: x["count"] for x in f["data"]["facets"]["type"]}
    assert by_type == {"Note": N - RARE, "Decision": RARE}
    # 타입 필터를 걸어도 type 축은 자기 축 필터를 빼고 센다(WP-04 규칙)
    f2 = S.search_facets("공통어", big.ctx(types="Decision"))
    assert f2["data"]["total"] == RARE
    assert {x["value"]: x["count"] for x in f2["data"]["facets"]["type"]} == by_type
    # origin 축은 type 필터를 따른다
    assert {x["value"]: x["count"] for x in f2["data"]["facets"]["origin"]} == {"first_party": RARE}


def test_cursor_follows_rank_position_across_insert(big):
    ctx = big.ctx(types="Note")
    p1 = S.search("공통어", ctx, kinds="record", limit=5)
    assert p1["page"]["next_cursor"] and len(ids(p1)) == 5
    # 페이지 사이에 더 잘 맞는(짧은) 새 레코드가 들어와도 커서가 이어진다
    big.add(record("f-new", "공통어", body="", type="Note"))
    p2 = S.search("공통어", ctx, kinds="record", limit=5, cursor=p1["page"]["next_cursor"])
    assert ids(p2) and not set(ids(p2)) & set(ids(p1))
    full = ids(S.search("공통어", ctx, kinds="record", limit=15))
    k = full.index(ids(p1)[-1])   # 앵커(1페이지 마지막 항목) 바로 뒤에서 이어진다
    assert ids(p2) == full[k + 1:k + 6]
    assert "f-new" in full and "f-new" not in ids(p2)


def test_cursor_rejected_for_other_query_or_filter(big):
    ctx = big.ctx(types="Note")
    c = S.search("공통어", ctx, kinds="record", limit=5)["page"]["next_cursor"]
    with pytest.raises(CursorMismatch):
        S.search("다른말", ctx, kinds="record", limit=5, cursor=c)
    with pytest.raises(CursorMismatch):
        S.search("공통어", big.ctx(types="Decision"), kinds="record", limit=5, cursor=c)


def test_bad_params(big):
    with pytest.raises(BadParam):
        S.search("...", big.ctx())            # 토큰이 하나도 없다
    with pytest.raises(BadParam):
        S.search("공통어", big.ctx(), kinds="bogus")
    with pytest.raises(BadParam):
        S.search("공통어", big.ctx(), mode="vector")
    from kb.read.ctx import LimitTooLarge
    with pytest.raises(LimitTooLarge):
        S.search("공통어", big.ctx(), limit=201)
