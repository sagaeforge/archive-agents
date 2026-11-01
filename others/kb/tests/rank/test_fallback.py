"""강등 규칙: 소켓 없음 r=l, 재순위 없음 r=c(Dense 순서 뒤 어휘 전용), 점수 없음, 필터는 코어가 다시 건다."""
import json
import os
import socket
import threading
import time

from kb.rank import client, conf, fusion, store
from kb.read import search as S

from .conftest import build_vec, rhelp


def _no_score(o):
    bad = {"score", "scores", "logit", "logits", "rank", "distance", "similarity", "bm25"}
    if isinstance(o, dict):
        assert not (bad & set(o)), set(o)
        [_no_score(v) for v in o.values()]
    elif isinstance(o, list):
        [_no_score(v) for v in o]


def test_no_socket_is_lexical(w, kb_home):
    build_vec(w, kb_home)
    assert not os.path.exists(conf.sock_path())
    assert client.search("쇼츠 수익", w.ctx(), limit=10) is None
    lex = S.search("쇼츠 수익", w.ctx(), mode="lexical")
    hyb = S.search("쇼츠 수익", w.ctx(), mode="hybrid")
    assert [i["id"] for i in hyb["data"]["items"]] == [i["id"] for i in lex["data"]["items"]]    # r=l
    assert "lexical_only" in json.dumps(hyb)


def test_rerank_route_h_and_no_scores(w, kb_home, service):
    build_vec(w, kb_home)
    r = client.search("쇼츠 수익 배분", w.ctx(), limit=10)
    assert r is not None and r.route == "h" and r.ids
    assert r.ids[0] == "c-9k2p4q7m1xac"          # 재순위 1위(주장 카드)
    res = S.search("쇼츠 수익 배분", w.ctx(), mode="hybrid")
    assert "lexical_only" not in json.dumps(res)
    _no_score(res)


def test_no_reranker_is_dense_then_lexical_only(w, kb_home, service):
    service.no_rerank = True
    build_vec(w, kb_home)
    q = "쇼츠 수익 배분"
    r = client.search(q, w.ctx(), limit=10)
    assert r is not None and r.route == "c"
    ix = store.Index(store.current_root())
    qv = service.embedder().encode_q8([q], "query")[0]
    fact, psg = ix.topk(qv, conf.CAND_FACT, conf.FACT), ix.topk(qv, conf.CAND_PASSAGE, "p")
    dense = fusion.interleave(fact, psg)
    assert [i for i in r.ids if i in set(dense)][:len(dense)] == [i for i in dense if i in r.ids]   # Dense 순서가 앞
    with w.rd() as (con, ctx):
        lex = [it["id"] for it in S.search_in(con, ctx, q, mode="lexical", limit=conf.CAND_LEX)[0]["items"]]
    lex_only = [i for i in lex if i not in set(dense)]
    pos = [r.ids.index(i) for i in lex_only if i in r.ids]
    assert all(p >= len([d for d in dense if d in r.ids]) for p in pos)                          # 어휘 전용은 Dense 뒤
    _no_score(S.search(q, w.ctx(), mode="hybrid"))


def test_core_refilters_private_and_secret(w, kb_home, service):
    """색인에 private, secret ID가 섞여 있어도(손상, 구버전) 코어 필터가 걸러 낸다."""
    build_vec(w, kb_home)
    ix = store.Index(store.current_root())
    q = "쇼츠 비공개 후킹"
    qv = service.embedder().encode_q8([q], "query")[0]
    rows = [ix.row(i) for i in range(ix.n)] + [qv, qv]
    ids = ix.ids + ["f-01JC8ZQ3T9PRV", "f-01JC8ZQ3T9SEC"]
    kinds = ix.kinds + ["r", "r"]
    store.write_index(kb_home / "derived" / "vec" / "v-evil", "v-evil", ids, kinds, ix.shas + ["x", "y"], rows, {"model": "stub"})
    store.point_current("v-evil")
    r = client.search(q, w.ctx(), limit=20)
    assert r is not None and "f-01JC8ZQ3T9PRV" not in r.ids and "f-01JC8ZQ3T9SEC" not in r.ids
    res = S.search(q, w.ctx(), mode="hybrid")
    assert not {"f-01JC8ZQ3T9PRV", "f-01JC8ZQ3T9SEC"} & {i["id"] for i in res["data"]["items"]}


def test_hang_falls_back_within_deadline(w, kb_home, monkeypatch):
    build_vec(w, kb_home)
    monkeypatch.setattr(conf, "CLIENT_TIMEOUT_S", 0.6)
    p = conf.sock_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(p))
    s.listen(4)
    t0 = time.monotonic()
    assert client.search("쇼츠", w.ctx(), limit=5) is None            # 받고 답하지 않는 서버
    assert time.monotonic() - t0 < 3
    s.close()


def test_kinds_filter(w, kb_home, service):
    build_vec(w, kb_home)
    r = client.search("쇼츠 후킹", w.ctx(), kinds=("record",), limit=10)
    assert r is not None and r.ids and all(i.startswith("f-") for i in r.ids)


def test_promotion_adds_claim_before_passage(w, kb_home, service):
    build_vec(w, kb_home)
    r = client.search("YPP 신규 진입 기준", w.ctx(), limit=10)
    assert r is not None
    ps = [i for i in r.ids if i.startswith("n-1:")]
    assert ps and r.ids.index("c-8k2p4q7m1xab") < r.ids.index(ps[0])      # 문단 앞에 그 문단의 주장


def test_fusion_order_rules():
    assert fusion.interleave(["a", "b"], ["x", "a", "y"]) == ["a", "x", "b", "y"]
    assert fusion.pool(["f1", "f2"], ["p1"], ["l1", "f2", "l2"], ["e1", "l1"]) == ["f1", "p1", "f2", "l1", "l2", "e1"]
    assert fusion.rerank_order(["a", "b", "c", "d"], [0.5, -2.5, 3.0, -2.0]) == ["c", "a", "d"]   # 하한 -2 미만 버림, 동점 없음
