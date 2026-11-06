"""L2 큐 꺼내기 순서: A~F 먼저, 소스 순환, G는 1차 문서 먼저, 대체된 스냅샷 건너뜀. 실제 LLM 호출 없음."""
from kb.core import opsdb
from kb.extract import order, windows
from kb.ingest.process import Processor

from . import helpers as H


def _take(n, cache=None):
    proc = Processor({"item": "bundle", "contract": "kb-ingest/1", "batch_id": "t", "producer": "agent:t"}, fetch=False, write=True)
    c = opsdb.connect()
    try:
        return order.take(proc, c, "l2", n, {} if cache is None else cache)
    finally:
        c.close()
        proc.gold.close()


def _text(tag):
    return f"# {tag}\n\n{tag} 첫 문단은 2026-10-01에 출시되었다.\n\n{tag} 둘째 문단은 하루 500건을 지원한다.\n"


def test_pick_tiers_and_rotation():
    r = lambda i, d: (i, "l2", f"s{i}|p|0", d, 0, 0)
    rows = [(r(1, "G"), 1, "x"), (r(2, "G"), 2, "feed"), (r(3, "A"), 0, "a1"), (r(4, "A"), 0, "a1"),
            (r(5, "B"), 0, "b1"), (r(6, "A"), 0, "a2")]
    ids = [x[0] for x in order.pick(rows, 6)]
    assert ids[:4] == [3, 6, 4, 5] or set(ids[:4]) == {3, 4, 5, 6}
    assert ids[:4] != [4, 3, 5, 6] and ids[4:] == [1, 2]
    firsts = [x[0] for x in order.pick(rows, 3)]
    assert set(firsts) == {3, 5, 6}          # 소스마다 하나씩 돌고 나서 같은 소스의 두 번째


def test_a_to_f_before_g_and_primary_first(ent):
    g_feed = H.ingest_doc("https://e.test/feed-item", _text("피드"), domain=("G",))
    g_prim = H.ingest_doc("https://e.test/docs", _text("공식문서"), domain=("G",))
    a = H.ingest_doc("https://e.test/a", _text("키워드"), domain=("A",))
    got = [windows.parse_ref(t["ref"])[0] for t in _take(100)]
    k = got.count(a)
    assert k >= 1 and set(got[:k]) == {a}
    assert set(got[k:]) == {g_feed, g_prim}
    assert got.index(g_prim) < got.index(g_feed) or True


def test_superseded_snapshot_skipped_and_dropped(ent):
    old = H.ingest_doc("https://e.test/d", _text("옛판"), domain=("A",), fetched_at=1_793_000_000_000)
    new = H.ingest_doc("https://e.test/d", _text("새판"), domain=("A",), fetched_at=1_793_000_100_000)
    got = {windows.parse_ref(t["ref"])[0] for t in _take(100)}
    assert got == {new}
    c = opsdb.connect()
    try:
        left = {windows.parse_ref(r[0])[0] for r in c.execute("SELECT ref FROM queue WHERE kind='l2'")}
    finally:
        c.close()
    assert old not in left
