"""배치 2개를 같은 KB_HOME에 연달아: 같은 바이트는 새 스냅샷·주장 0건, 만기 전 소스는 건너뛴다 (WP-21)."""
from collect.conftest import events, mk_source  # noqa: F401
from collect.test_tick import tick  # noqa: F401


def _setup(world, set_registry):
    for h in ("a.example", "b.example", "c.example"):
        world.add(h, "/robots.txt", 404)
        world.add(h, "/doc", 200, ("본문 " + h).encode(), headers={"Content-Type": "text/plain", "ETag": '"1"'})
    set_registry([mk_source("src:a", "https://a.example/doc", cls="docs"), mk_source("src:b", "https://b.example/doc", cls="docs"),
                  mk_source("src:c", "https://c.example/doc", cls="docs")])


def test_second_batch_adds_nothing_for_overlap(world, set_registry, clk):
    _setup(world, set_registry)
    rep1, _ = tick(batch=["src:a", "src:b"])
    snaps1 = len(events("snapshot.captured"))
    claims1 = len(events("claim.assert"))
    assert snaps1 >= 2
    # --batch는 force라 만기 전에도 재요청하지만, 같은 바이트(304 또는 같은 sha)는 새 스냅샷·주장을 만들지 않는다
    rep2, _ = tick(batch=["src:b", "src:c"])
    assert len(events("snapshot.captured")) == snaps1 + 1          # c만 새로
    assert len(events("claim.assert")) == claims1
    # 일반 tick은 만기 전 소스를 건너뛴다
    n_all = world.net_count()
    tick()
    assert world.net_count() == n_all
    # 만기 뒤에도 같은 바이트면 새 스냅샷 0건
    clk.advance(2 * 86400)
    before = len(events("snapshot.captured"))
    tick(batch=["src:a", "src:b", "src:c"])
    assert len(events("snapshot.captured")) == before
    assert len(events("claim.assert")) == claims1
