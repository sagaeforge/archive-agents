"""도메인별 건수. 다중 도메인 소스는 각 도메인에 잡히고 비율과 점수는 없다."""
import json

from kb.cli import main
from kb.core import ledger
from kb.guard import status
from kb.project import rebuild
from conftest import mk_source
from projhelp import E, claim, entity, snap_events


def seed_gold(env):
    led = ledger.open_ledger()
    ledger.append(led, [
        E("source.registered", {"id": "src:multi", "domain": ["C", "D", "E"]}, "src:multi"),
        E("source.registered", {"id": "src:a", "domain": ["A"]}, "src:a"),
        *snap_events("n-1", source="src:multi"),
        *snap_events("n-2", url="https://b.example/doc", source="src:a", paras=("다른 문단입니다 하나.",)),
        entity("e:tool:x"),
        claim("c1", "e:tool:x", "x는 위젯을 지원한다", snap="n-1"),
        claim("c2", "e:tool:x", "x는 다른 기능도 지원한다", snap="n-1", verification="needs_review"),
    ])
    rebuild(led=led)
    led.close()


def test_multi_domain_source_counted_in_each(env, ops, set_registry):
    set_registry([mk_source("src:multi", domain=("C", "D", "E")), mk_source("src:a", domain=("A",)),
                  mk_source("src:off", domain=("B",), enabled=False)])
    ops.execute("INSERT INTO source_state(source_id, state, last_ok_at, fail_count) VALUES('src:multi','broken',1,0)")
    seed_gold(env)
    st = status.build(decisions=set())
    bd = st["by_domain"]
    for d in "CDE":
        assert bd[d]["sources_active"] == 1 and bd[d]["sources_failed"] == 1 and bd[d]["snapshots"] == 1, d
    assert bd["A"] == {"sources_active": 1, "sources_failed": 0, "snapshots": 1, "claims_active": 0}
    assert bd["B"]["sources_active"] == 0                             # 비활성 소스는 세지 않는다
    assert sorted(bd) == list("ABCDEFG")
    total_sources = sum(v["sources_active"] for v in bd.values())
    assert total_sources == 4 > 2                                     # 합이 전체 소스(2)보다 크다


def test_claims_review_counts_held_claims(env, set_registry):
    set_registry([mk_source("src:multi", domain=("C", "D", "E"))])
    seed_gold(env)
    st = status.build(decisions=set())
    assert st["counts"]["claims_review"] == 1 and st["counts"]["claims_active"] == 1
    assert st["counts"]["snapshots"] == 2
    assert all(st["by_domain"][d]["claims_active"] == 1 for d in "CDE")   # needs_review는 활성 주장에 안 든다


def test_no_ratio_or_score_fields(env, set_registry, capsys):
    set_registry([mk_source("src:multi", domain=("C", "D", "E"))])
    seed_gold(env)
    assert main(["status", "--json"]) == 0
    out = capsys.readouterr().out
    st = json.loads(out)
    for banned in ("ratio", "score", "rank", "percent", "rate", "점수", "비율"):
        assert banned not in out.lower(), banned

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                yield k, v
                yield from walk(v)
        elif isinstance(x, list):
            for v in x:
                yield from walk(v)
    leaf = [v for k, v in walk(st["by_domain"]) if not isinstance(v, dict)]
    assert all(isinstance(v, int) and not isinstance(v, bool) for v in leaf)   # 건수(정수)뿐이다
