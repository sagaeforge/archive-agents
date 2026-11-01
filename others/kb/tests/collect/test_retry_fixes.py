"""재시도 판정 항목 재현: State.put 기존 행 갱신, budget 지연, --batch의 max_pages와 결정 관문."""
import pytest
import yaml

from kb.collect import tick as T
from kb.collect import tick_stage
from kb.collect.state import State
from kb.commands.tick import _batch

from .conftest import mk_source
from .test_pages import disc_src, fake_sitemap, page_world


def test_put_existing_row_without_state(env):
    with State() as st:
        st.put("src:x", None, state="ok", fail_count=2)
        st.put("src:x", None, next_check_at=123)            # NOT NULL 오류였던 호출
        assert st.get("src:x")["state"] == "ok" and st.get("src:x")["next_check_at"] == 123
        st.put("src:x", "https://a.example/u", state="ok")
        st.put("src:x", "https://a.example/u", next_check_at=9)
        r = st.get("src:x", "https://a.example/u")
        assert r["next_check_at"] == 9 and r["state"] == "ok"
        st.put("src:new", None, next_check_at=5)             # 새 행도 통과
        assert st.get("src:new")["state"] == "new"


def test_budget_exceeded_defers_without_error(world, set_registry, clk):
    world.add("budget.example", "/robots.txt", 404)
    urls = [f"https://budget.example/p{i}" for i in range(6)]
    for u in urls:
        world.add("budget.example", u[len("https://budget.example"):], 200, b"x", headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:b", urls=urls)])
    rep, rc = T.run_tick()
    assert rc == 0 and rep["stages"]["fetch"] == "ok" and not rep.get("errors")
    assert rep["pages_fetched"] == 2
    with State() as st:
        deferred = [r for r in st.list_urls("src:b") if r["next_check_at"]]
        assert deferred, "예산 초과 URL은 next_check_at으로 미뤄진다"


@pytest.fixture(autouse=True)
def _discoverers(monkeypatch):
    monkeypatch.setattr(tick_stage, "load_discoverers", lambda: ({"sitemap": fake_sitemap}, None))


def test_batch_parses_max_pages(tmp_path):
    p = tmp_path / "b.yaml"
    p.write_text(yaml.safe_dump({"batch": [{"id": "src:a", "max_pages": 7}, {"id": "src:b"}, "src:c"]}))
    ids, caps = _batch(str(p))
    assert ids == ["src:a", "src:b", "src:c"] and caps == {"src:a": 7}


def test_batch_max_pages_overrides_discover_cap(world, set_registry):
    page_world(world, n=5)
    set_registry([disc_src()])      # discover.max_pages=5
    rep, _ = T.run_tick(batch=["src:d"], batch_caps={"src:d": 2})
    assert rep["pages_queued"] == 2 and rep["pages_capped"] == 3 and rep["pages_fetched"] == 2


def test_batch_keeps_decision_gate(world, set_registry):
    world.add("r.example", "/robots.txt", 404)
    world.add("r.example", "/x", 200, b"x", headers={"Content-Type": "text/plain"})
    set_registry([mk_source("src:dec", "https://r.example/x", requires_decision=5)])
    rep, _ = T.run_tick(batch=["src:dec"])
    assert rep["sources"] == 0 and world.calls_to("r.example") == 0 if hasattr(world, "calls_to") else rep["sources"] == 0
