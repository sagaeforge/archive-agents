"""kb-rank 시험 도우미. 스텁 모델(해시 기반)로 소켓 서비스, 색인, 클라이언트를 끝까지 돌린다. torch와 numpy 없이 돈다."""
import importlib.util
import os
import shutil
import threading
from pathlib import Path

import pytest

_p = Path(__file__).resolve().parents[1] / "read" / "rhelp.py"
_spec = importlib.util.spec_from_file_location("kb_tests_rhelp_rank", _p)
rhelp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rhelp)

PARAS = ("YPP 신규 진입 기준은 8,000시간으로 올라간다.", "쇼츠 수익 배분은 45%다.", "썸네일 클릭률은 노출 대비 클릭 비율이다.")


@pytest.fixture(autouse=True)
def stub_env(monkeypatch, kb_home):
    monkeypatch.setenv("KB_RANK_STUB", "1")
    monkeypatch.delenv("KB_RANK_NO_RERANK", raising=False)
    monkeypatch.setenv("KB_RANK_SOCK", str(kb_home / "run" / "kb-rank.sock"))


@pytest.fixture
def w(kb_home):
    world = rhelp.World(kb_home)
    world.add(rhelp.entity("e:platform:youtube", "YouTube Shorts"))
    world.add(rhelp.snap("n-1", paras=PARAS))
    world.add(rhelp.claim("c-8k2p4q7m1xab", "e:platform:youtube", PARAS[0], snap_id="n-1"))
    world.add(rhelp.claim("c-9k2p4q7m1xac", "e:platform:youtube", PARAS[1], snap_id="n-1"))
    world.add(rhelp.record("f-01JC8ZQ3T9XYZ", "쇼츠 후킹 메모", body="첫 3초의 후킹이 중요하다"))
    world.add(rhelp.record("f-01JC8ZQ3T9PRV", "비공개 메모", sens="private", body="쇼츠 비공개 계획 후킹"))
    world.add(rhelp.record("f-01JC8ZQ3T9SEC", "비밀 메모", sens="secret", body="쇼츠 비밀 키 후킹"))
    yield world
    world.close()


def publish_gold(world, kb_home, name):
    """World의 gold를 derived/gold/<name>/graph.db로 복사하고 current를 맞춘다(indexer 입력)."""
    world.gold.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    d = kb_home / "derived" / "gold" / name
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy(world.path, d / "graph.db")
    link = kb_home / "derived" / "gold" / "current"
    if link.is_symlink():
        link.unlink()
    os.symlink(name, link)


def build_vec(world, kb_home, name="g-000000001-aaaa", full=False):
    from kb.rank import indexer
    publish_gold(world, kb_home, name)
    return indexer.build(full=full, stub=True)


@pytest.fixture
def service(kb_home):
    """스텁 kb-rank를 스레드로 띄운다. no_rerank를 바꾸려면 svc.no_rerank를 직접 바꾼다."""
    from kb.rank import server
    svc = server.RankService(stub=True)
    lst = server.listener_from_env()
    stop = threading.Event()
    t = threading.Thread(target=server.serve, args=(lst, svc), kwargs={"stop": stop.is_set, "idle_exit_s": 600}, daemon=True)
    t.start()
    yield svc
    stop.set()
    t.join(3)
    lst.close()
