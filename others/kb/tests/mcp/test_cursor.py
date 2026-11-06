import re

from kb.read.budget import est_tokens


def card_ids(text):
    return [ln.split("\t")[0] for ln in text.splitlines()[1:] if ln and not ln.startswith("~ ")]


def cur_of(text):
    m = re.search(r" cur=(\S+)", text.splitlines()[0])
    return m.group(1) if m else None


def drain(m, budget):
    out, cur, guard = [], None, 0
    while guard < 200:
        kw = {"cursor": cur} if cur else {}
        t, err, _ = m.call("kb_search", q="hooks", k=50, budget=budget, **kw)
        assert not err, t
        out += card_ids(t)
        cur = cur_of(t)
        guard += 1
        if not cur:
            return out
    raise AssertionError("커서가 끝나지 않는다")


def test_cursor_continues_across_pages_and_restart(factory):
    m = factory()
    full = drain(m, 6000)
    assert len(full) > 40 and len(set(full)) == len(full)
    p1, err, _ = m.call("kb_search", q="hooks", k=50, budget=500)
    assert not err and est_tokens(p1) <= 500             # 머리 길이가 예산에 든다
    c1 = cur_of(p1)
    ids1 = card_ids(p1)
    assert c1 and 0 < len(ids1) < len(full)
    assert ids1 == full[:len(ids1)]
    assert re.search(r" more=\d+", p1.splitlines()[0])
    p2, err, _ = m.call("kb_search", q="hooks", k=50, budget=500, cursor=c1)
    assert not err
    ids2 = card_ids(p2)
    assert ids2 and not set(ids1) & set(ids2)
    assert ids1 + ids2 == full[:len(ids1 + ids2)]
    # 서버 재시작 뒤에도 같은 커서가 이어진다
    m2 = factory()
    p2b, err, _ = m2.call("kb_search", q="hooks", k=50, budget=500, cursor=c1)
    assert not err and card_ids(p2b) == ids2
    # 작은 예산으로 끝까지 이어 읽어도 전체와 같다
    assert drain(m, 500) == full


def test_other_filter_is_cursor_mismatch(server):
    p1, _, _ = server.call("kb_search", q="hooks", k=50, budget=500)
    c1 = cur_of(p1)
    assert c1
    for kw in ({"type": "Claim"}, {"domain": "E"}, {"include": "unverified"}):
        t, err, _ = server.call("kb_search", q="hooks", k=50, budget=500, cursor=c1, **kw)
        assert err and "cursor_mismatch" in t, (kw, t)
    t, err, _ = server.call("kb_search", q="전혀 다른 질의", k=50, budget=500, cursor=c1)
    assert err and "cursor_mismatch" in t
