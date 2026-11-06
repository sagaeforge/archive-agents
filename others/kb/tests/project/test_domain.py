"""node_domain: 소스 도메인 상속은 적용 시점 값이고 소급하지 않는다."""
from kb.core import cas, ledger
from kb.core.canon import canon_json
from kb.project import fingerprint_conn, project_tail, replay
from projhelp import E, claim, entity, new_gold, snap_events


def doms(g, nid):
    return [r[0] for r in g.execute("SELECT domain FROM node_domain WHERE node_id=? ORDER BY domain", (nid,))]


def test_multi_domain_source_rows_everywhere(led, kb_home):
    pts = [{"period_key": "2026-10", "period_start": 1, "period_end": 2, "value": "10", "unit": "rank"}]
    sha = cas.put(canon_json(pts))
    ledger.append(led, [
        E("source.registered", {"id": "src:a", "domain": ["A", "C"]}, "src:a"),
        *snap_events(source="src:a"),                      # snapshot.captured에 domain이 없으면 소스 목록을 쓴다
        entity("e:tool:x", domain=["F"]),
        claim("c1", "e:tool:x", "x는 위젯을 지원한다"),
        E("series.define", {"id": "s:x", "label": "x 순위", "metric": "rank", "subject": "e:tool:x", "domain": ["B"]}, "s:x"),
        E("series.batch", {"series_id": "s:x", "snapshot": "n-1", "parser": "p@1", "points_sha": sha, "count": 1}, "s:x"),
    ])
    g = new_gold(kb_home, "d")
    project_tail(led, g, None, 10 ** 6)
    assert doms(g, "n-1") == ["A", "C"] and doms(g, "d-n-1") == ["A", "C"]
    assert doms(g, "c1") == ["A", "C"]
    assert doms(g, "e:tool:x") == ["A", "C", "F"], "엔티티는 제출 도메인과 근거 주장 소스의 합집합"
    assert doms(g, "s:x") == ["A", "B", "C"]
    assert g.execute("SELECT value, unit FROM series_obs").fetchall() == [("10", "rank")]


def test_source_change_is_not_retroactive_and_incremental_equals_rebuild(led, kb_home):
    first = [E("source.registered", {"id": "src:a", "domain": ["A"]}, "src:a"), *snap_events("n-1"),
             entity("e:tool:x"), claim("c1", "e:tool:x", "x는 위젯을 지원한다")]
    ledger.append(led, first)
    g = new_gold(kb_home, "inc")
    project_tail(led, g, 4, 10 ** 6)
    project_tail(led, g, None, 10 ** 6)
    ledger.append(led, [E("source.registered", {"id": "src:a", "domain": ["B"]}, "src:a"),
                        *snap_events("n-2", url="https://a.example/other", paras=("다른 문단입니다.",)),
                        claim("c2", "e:tool:x", "x는 다른 기능도 지원한다", snap="n-2")])
    project_tail(led, g, 1, 10 ** 6)
    project_tail(led, g, None, 10 ** 6)
    assert doms(g, "n-1") == ["A"] and doms(g, "c1") == ["A"], "목록을 바꿔도 옛 행은 그대로"
    assert doms(g, "n-2") == ["B"] and doms(g, "c2") == ["B"]
    assert doms(g, "e:tool:x") == ["A", "B"]
    g2 = new_gold(kb_home, "full")
    replay(led, g2)
    assert fingerprint_conn(g2) == fingerprint_conn(g)
