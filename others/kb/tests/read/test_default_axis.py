"""기본 읽기는 관측축만 현재이고 유효축을 걸지 않는다(계약 2.9)."""
import time

from kb import read
from .rhelp import E, claim, entity, snap, verdict


def _ids(w, nid="e:policy:p", **kw):
    with w.rd(**kw) as (con, c):
        return sorted(x["id"] for x in read.node_claims(con, c, nid)[0]["items"])


def test_closed_event_and_dead_node_stay_visible(w):
    w.add(entity("e:policy:p", "P"), entity("e:tool:old", "옛도구"), snap(),
          claim("c-ev", "e:policy:p", "P는 2020년 한 해만 시행됐다", "event", valid={"from": "2020-01-01", "to": "2021-01-01"}))
    w.add(verdict("e:tool:old", "dead", "removed"))
    assert _ids(w) == ["c-ev"]  # 닫힌 구간 event가 사라지지 않는다
    assert _ids(w, as_of_valid="2026-01-01") == []  # as_of_valid를 줄 때만 유효축이 걸린다
    assert _ids(w, as_of_valid="2020-06-01") == ["c-ev"]
    with w.rd() as (con, c):
        assert read.get_node(con, c, "e:tool:old")["status"] == "dead"  # dead 노드 직접 조회
    with w.rd(status="dead") as (con, c):
        assert [x["id"] for x in read.list_nodes(con, c, type="Tool")[0]["items"]] == ["e:tool:old"]
    with w.rd() as (con, c):
        assert read.list_nodes(con, c, type="Tool")[0]["items"] == []


def test_same_applied_seq_same_data_regardless_of_clock(w, monkeypatch):
    w.add(entity("e:policy:p", "P"), snap(), claim("c-1", "e:policy:p", "P는 영구 정책이다", "state", valid={"from": "2020-01-01"}),
          claim("c-2", "e:policy:p", "P는 2099년에 바뀐다", "event", valid={"from": "2099-01-01"}))
    out = []
    for fake in (None, 4_102_444_800.0, 1_000_000_000.0):
        if fake is not None:
            monkeypatch.setattr(time, "time", lambda f=fake: f)
        with w.rd() as (con, c):
            d = read.get_node(con, c, "e:policy:p")
            env = read.envelope(con, c, d)
            out.append((env["data"], env["applied_seq"], env["build_id"], env["epoch"]))
    assert out[0] == out[1] == out[2]
    assert [x["id"] for x in out[0][0]["claims"]] == ["c-1", "c-2"]  # 미래 발효 event도 보인다


def test_future_effective_replacement(w):
    w.add(entity("e:policy:p", "P"), snap())
    old = lambda to: claim("c-old", "e:policy:p", "P 기준은 4000시간이다", "state", predicate="hours", value="4000",
                           valid={"from": "2024-06-01", **({"to": to} if to else {})})
    w.add(old(None))
    w.add(claim("c-new", "e:policy:p", "P 기준은 8000시간이다", "state", predicate="hours", value="8000", valid={"from": "2099-01-01"}))
    w.add(old("2099-01-01"))  # 옛 주장은 valid.to를 닫은 새 버전으로 남는다
    assert _ids(w) == ["c-new", "c-old"]  # 효력일 전에는 두 주장 모두 active
    with w.rd() as (con, c):
        assert {x["id"]: x["status"] for x in read.node_claims(con, c, "e:policy:p")[0]["items"]} == {"c-new": "active", "c-old": "active"}
    assert _ids(w, as_of_valid="2050-01-01") == ["c-old"]  # 그 시점의 값 하나
    assert _ids(w, as_of_valid="2100-01-01") == ["c-new"]
    # 효력일이 지나면 claim.supersede로 옛 주장이 superseded
    w.add(E("claim.supersede", {"id": "c-old", "by": "c-new", "valid_to": "2099-01-01"}, "c-old"))
    assert _ids(w) == ["c-new"]
    assert _ids(w, status="superseded") == ["c-old"]
    with w.rd() as (con, c):
        assert read.get_claim(con, c, "c-old")["status"] == "superseded"  # 직접 조회는 항상 응답
