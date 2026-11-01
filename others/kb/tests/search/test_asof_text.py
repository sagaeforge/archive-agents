"""옛 판에만 있던 문단이 as_of_observed로 찾아지고 현재 검색에서는 나오지 않는다. 민감도 필터가 적용된다."""
from kb.read import search as S

from .shelp import DAY, T0, E, ids, record, snap


def _two_versions(w):
    t1, t2 = T0 + DAY, T0 + 10 * DAY
    w.add(snap("n-1", document_id="d-same", at=t1, paras=("옛날 문단 보라색코끼리 설명", "그대로인 문단 안정성")))
    w.add(snap("n-2", document_id="d-same", at=t2, paras=("새 문단 파란고래 설명", "그대로인 문단 안정성")))
    return t1, t2


def test_old_paragraph_found_only_as_of(w):
    t1, t2 = _two_versions(w)
    now = S.search("보라색코끼리", w.ctx(), kinds="passage")
    assert ids(now) == []
    old = S.search("보라색코끼리", w.ctx(as_of_observed=t1 + DAY), kinds="passage")
    assert len(ids(old)) == 1
    (it,) = old["data"]["items"]
    assert it["snapshot_id"] == "n-1" and "보라색코끼리" in it["snippet"]
    assert old["as_of"]["observed"] is not None
    # 새 문단은 옛 시점에 없다
    assert ids(S.search("파란고래", w.ctx(as_of_observed=t1 + DAY), kinds="passage")) == []
    assert len(ids(S.search("파란고래", w.ctx(), kinds="passage"))) == 1
    # 그대로인 문단은 두 시점 모두에서 한 건이다
    assert len(ids(S.search("안정성", w.ctx(as_of_observed=t1 + DAY), kinds="passage"))) == 1
    assert len(ids(S.search("안정성", w.ctx(), kinds="passage"))) == 1


def test_asof_path_reports_exact_total(w):
    t1, _ = _two_versions(w)
    r = S.search("보라색코끼리", w.ctx(as_of_observed=t1 + DAY))
    assert r["page"]["total"] == 1 and r["page"]["truncated"] is False


def test_sensitivity_filter_applies_in_asof(w):
    t1 = T0 + DAY
    w.add(record("f-pub", "공개 메모 노랑부엉이", sens="internal", at=t1))
    w.add(record("f-prv", "비공개 메모 노랑부엉이", sens="private", at=t1))
    q = "노랑부엉이"
    assert ids(S.search(q, w.ctx(), kinds="record")) == ["f-pub"]
    assert ids(S.search(q, w.ctx(as_of_observed=t1 + DAY), kinds="record")) == ["f-pub"]
    wide = ids(S.search(q, w.ctx(max_sensitivity="private", as_of_observed=t1 + DAY), kinds="record"))
    assert sorted(wide) == ["f-prv", "f-pub"]
