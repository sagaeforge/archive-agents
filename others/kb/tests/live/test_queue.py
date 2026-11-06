"""사람 판단 대기열: 상한 30, 초과 시 오래된 항목은 상태 유지로 내린다. 에이전트 제안은 후보로만 남는다."""
import pytest

from kb.live import decide, reviewq
from kb.live.model import Item, Sig


def test_cap_30_demotes_oldest_stale_suspect_first(env):
    for i in range(30):
        q = "H04" if i % 2 == 0 else "H01"
        reviewq.open_item(f"e:repo:r{i:02d}", "repo", Item(q, "t", "stale_suspect" if q == "H04" else "removed"), [], now=1000 + i)
    assert len(reviewq.list_open()) == 30
    reviewq.open_item("e:repo:new", "repo", Item("H01", "t", "removed"), [], now=5000)
    open_ = reviewq.list_open()
    assert len(open_) == 30
    ids_ = {i["target"] for i in open_}
    assert "e:repo:r00" not in ids_ and "e:repo:new" in ids_ and "e:repo:r01" in ids_      # 가장 오래된 stale_suspect(H04)가 내려갔다
    from kb.core import opsdb
    c = opsdb.connect()
    try:
        assert c.execute("SELECT count(*) FROM review WHERE state='demoted'").fetchone()[0] == 1
    finally:
        c.close()


def test_cap_falls_back_to_oldest_when_none_is_stale(env):
    for i in range(31):
        reviewq.open_item(f"e:repo:h{i:02d}", "repo", Item("H01", "t", "removed"), [], now=1000 + i)
    open_ = reviewq.list_open()
    assert len(open_) == 30 and open_[0]["target"] == "e:repo:h01"


def test_same_question_updates_instead_of_duplicating(env):
    a = reviewq.open_item("e:repo:x", "repo", Item("H02", "첫째", "removed"), [])
    b = reviewq.open_item("e:repo:x", "repo", Item("H02", "둘째", "removed"), [])
    assert a == b and len(reviewq.list_open()) == 1 and "둘째" in reviewq.list_open()[0]["question"]


def test_agent_cannot_decide_only_propose(env):
    rid = reviewq.open_item("e:repo:y", "repo", Item("H01", "t", "removed"), [Sig("M12", "removed", "n-1", "gone").event()])
    with pytest.raises(decide.DecideError):
        decide.decide(rid, "removed", by="agent:codex")
    assert reviewq.propose(rid, "removed", "agent:codex")
    it = reviewq.get(rid)
    assert it["proposed"]["by"] == "agent:codex" and len(reviewq.list_open()) == 1
