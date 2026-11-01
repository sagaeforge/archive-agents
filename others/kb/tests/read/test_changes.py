"""변경 피드: epoch + seq 커서, kinds, origin, 꼬리, EpochChanged."""
import pytest

from kb import read
from .rhelp import E, claim, entity, record, snap


def _feed(w, **kw):
    with w.rd() as (con, c):
        return read.changes(con, c, **kw)


def test_walk_from_zero_and_tail_cursor(w):
    w.add(entity("e:tool:a", "A"), snap(), claim("c-1", "e:tool:a", "a는 위젯을 지원한다"), record("f-1", "메모"))
    data, page = _feed(w)
    kinds = [x["kind"] for x in data["items"]]
    assert kinds[0] == "entity.put" and "claim.assert" in kinds and page["total"] is None and page["truncated"] is False
    assert all(x["seq"] <= y["seq"] for x, y in zip(data["items"], data["items"][1:]))
    first = data["items"][0]
    assert set(first) == {"seq", "at", "kind", "id", "version", "type", "origin"} and first["at"].endswith("Z")
    # 꼬리에서도 next_cursor는 문자열이고 새 항목이 없으면 같은 커서다
    d2, p2 = _feed(w, cursor=page["next_cursor"])
    assert d2["items"] == [] and p2["next_cursor"] == page["next_cursor"] and isinstance(p2["next_cursor"], str)
    with w.rd() as (con, c):
        assert read.meta(con, c)["changes_cursor"] == page["next_cursor"]
    w.add(entity("e:tool:b", "B"))
    d3, p3 = _feed(w, cursor=page["next_cursor"])
    assert [x["id"] for x in d3["items"]] == ["e:tool:b"] and p3["next_cursor"] != page["next_cursor"]


def test_paging_filters_and_limits(w):
    w.add(*[entity(f"e:tool:t{i}", f"T{i}") for i in range(6)], record("f-1", "메모"))
    seen, cur = [], None
    for _ in range(10):
        d, p = _feed(w, cursor=cur, limit=2)
        seen += [x["id"] for x in d["items"]]
        cur = p["next_cursor"]
        if not p["truncated"]:
            break
        assert len(d["items"]) == 2
    assert seen == [f"e:tool:t{i}" for i in range(6)] + ["f-1"]
    d, _ = _feed(w, kinds="record.put")
    assert [x["id"] for x in d["items"]] == ["f-1"]
    d, _ = _feed(w, origin="first_party")
    assert [x["id"] for x in d["items"]] == ["f-1"]
    d, _ = _feed(w, kinds="record.put,entity.put", origin="external")
    assert {x["kind"] for x in d["items"]} == {"entity.put"}
    with pytest.raises(read.LimitTooLarge):
        _feed(w, limit=5001)
    with pytest.raises(read.BadParam):
        _feed(w, origin="alien")


def test_epoch_changed_and_cursor_ahead_and_as_of(w):
    w.add(entity("e:tool:a", "A"))
    _, page = _feed(w)
    w.add(E("schema.epoch_bumped", {"reason": "restore"}, origin="system", actor="system:t"))
    with pytest.raises(read.EpochChanged):
        _feed(w, cursor=page["next_cursor"])
    from kb.read.envelope import encode_cursor
    with w.rd() as (con, c):
        ahead = encode_cursor({"e": read.envelope(con, c, {})["epoch"], "s": 10 ** 6})
    with pytest.raises(read.EpochChanged):
        _feed(w, cursor=ahead)
    with pytest.raises(read.CursorMismatch):
        _feed(w, cursor="@@@")
    with w.rd(as_of_valid="2026-01-01") as (con, c):
        with pytest.raises(read.AsOfUnsupported):
            read.changes(con, c)
