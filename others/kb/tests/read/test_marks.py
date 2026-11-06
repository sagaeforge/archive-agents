"""카드 표시 기호: q, p, f:user, f:agent:<세션>, internal, a, u, +Nsrc, !gN, hist:N. public은 internal 표시가 없다."""
from kb import read
from .rhelp import E, claim, entity, record, snap


def _cards(w, ids, **kw):
    ctx_kw = {k: kw.pop(k) for k in ("include_unverified",) if k in kw}
    with w.rd(**ctx_kw) as (con, c):
        res = read.render_cards(con, c, ids, **kw)
    lines = res.text.split("\n")
    return res, {ln.split("\t")[0]: ln.split("\t") for ln in lines[1:] if "\t" in ln}


def _marks(cells):
    return [m for m in cells[4].split(",") if m]


def test_basic_marks_and_public_has_no_internal(w):
    w.add(entity("e:tool:x", "X"), snap(), claim("c-q", "e:tool:x", "x는 위젯을 지원한다"),
          claim("c-p", "e:tool:x", "x의 최신 버전은 2.0이다", verification="parser_derived"),
          claim("c-a", "e:tool:x", "출처 B는 x가 빠르다고 주장한다", stance="attributed", speaker="src:b"),
          claim("c-u", "e:tool:x", "x는 달을 지원한다", verification="needs_review"))
    res, cards = _cards(w, ["c-q", "c-p", "c-a", "c-u"], include_unverified=True)
    assert _marks(cards["c-q"]) == ["q"] and _marks(cards["c-p"]) == ["p"]
    assert _marks(cards["c-a"]) == ["q", "a"] and _marks(cards["c-u"]) == ["u"]
    assert all("internal" not in _marks(v) for v in cards.values())
    assert res.text.split("\n")[0].startswith("#kb v1 seq=") and all(len(v) == 5 for v in cards.values())
    _, cards2 = _cards(w, ["c-q", "c-u"])  # include_unverified가 아니면 u 카드는 없다
    assert "c-u" not in cards2


def test_first_party_and_internal_marks(w):
    w.add(record("f-user", "사용자 메모", "internal"),
          E("record.put", {"id": "f-ag", "type": "Note", "title": "에이전트 메모", "sensitivity": "public", "body": "x"}, "f-ag",
            origin="first_party", actor="agent:sess9", on_behalf_of="user:sagae"))
    _, cards = _cards(w, ["f-user", "f-ag"])
    assert _marks(cards["f-user"]) == ["f:user", "internal"] and cards["f-user"][2] == "user"
    assert _marks(cards["f-ag"]) == ["f:agent:sess9"]


def test_source_count_conflict_and_history_marks(w):
    w.add(entity("e:policy:p", "P"), snap("n-1", source="src:a"), snap("n-2", url="https://b.example/doc", source="src:b"),
          claim("c-1", "e:policy:p", "P 기준은 4000시간이다", predicate="hours", value="4000"),
          claim("c-2", "e:policy:p", "P 기준은 8000시간이다", predicate="hours", value="8000"),
          claim("c-3", "e:policy:p", "P 기준은 1000시간이었다", predicate="hours", value="1000"),
          claim("c-multi", "e:policy:p", "P는 두 곳에서 확인된다", evidence=[
              {"snapshot": "n-1", "selector_kind": "text_quote", "exact": "a"}, {"snapshot": "n-2", "selector_kind": "text_quote", "exact": "b"}]))
    w.add(E("claim.supersede", {"id": "c-3", "by": "c-2"}, "c-3"))
    _, cards = _cards(w, ["c-1", "c-2", "c-multi"])
    assert "!g2" in _marks(cards["c-1"]) and "!g2" in _marks(cards["c-2"])
    assert "hist:1" in _marks(cards["c-1"])
    assert "+1src" in _marks(cards["c-multi"]) and cards["c-multi"][2] == "a"
    assert "!g2" not in _marks(cards["c-multi"])


def test_liveness_marks_and_superseded_not_rendered(w):
    w.add(entity("e:tool:s", "S", liveness={"liveness": "deprecated"}), entity("e:tool:r", "R", liveness={"liveness": "partial"}),
          snap(), claim("c-d", "e:tool:s", "S는 위젯을 지원한다"), claim("c-r", "e:tool:r", "R는 위젯을 지원한다"),
          claim("c-old", "e:tool:s", "S는 옛 기능이다"))
    w.add(E("claim.supersede", {"id": "c-old", "by": "c-d"}, "c-old"))
    res, cards = _cards(w, ["c-d", "c-r", "c-old"])
    assert "dep" in _marks(cards["c-d"]) and any(m.startswith("partial") for m in _marks(cards["c-r"]))
    assert "c-old" not in cards and res.n == 2
